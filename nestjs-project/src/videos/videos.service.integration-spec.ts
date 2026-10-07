import { randomBytes } from 'node:crypto';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import {
  ChannelNotFoundException,
  InvalidUploadPartsException,
  UploadSizeMismatchException,
  VideoUploadNotInProgressException,
  VideoNotOwnedException,
} from '../common/exceptions/domain.exception';
import queueConfig from '../config/queue.config';
import {
  type ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';
import { InvalidMultipartPartsError } from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { emptyQueue, useIsolatedQueuePrefix } from '../test/queue-test-env';
import { createTestStorageService } from '../test/storage-test-env';
import { createUserWithChannel } from '../test/video-factory';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';

describe('VideosService (integration)', () => {
  let dataSource: DataSource;
  let storage: StorageService;
  let videoRepository: Repository<Video>;
  let service: VideosService;
  let queue: Queue<ProcessVideoJobData>;
  let user: User;
  let channel: Channel;

  async function findWithUploadId(id: string): Promise<Video> {
    return videoRepository
      .createQueryBuilder('video')
      .addSelect('video.upload_id')
      .where('video.id = :id', { id })
      .getOneOrFail();
  }

  beforeAll(async () => {
    dataSource = createTestDataSource([Video]);
    await dataSource.initialize();
    storage = await createTestStorageService();
    videoRepository = dataSource.getRepository(Video);
    // Own prefix: the running video-worker container must not take these jobs.
    useIsolatedQueuePrefix();
    const { host, port, prefix } = queueConfig();
    queue = new Queue<ProcessVideoJobData>(VIDEO_PROCESSING_QUEUE, {
      connection: { host, port },
      prefix,
    });
    service = new VideosService(
      videoRepository,
      new ChannelsService(dataSource),
      storage,
      queue,
    );
  });

  afterAll(async () => {
    await emptyQueue(queue);
    await queue.close();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await emptyQueue(queue);
    await cleanAllTables(dataSource);
    ({ user, channel } = await createUserWithChannel(dataSource));
  });

  describe('initiateUpload', () => {
    const dto = { filename: 'clip.mp4', content_type: 'video/mp4', size: 2048 };

    it('should persist the draft and open a real multipart upload', async () => {
      const result = await service.initiateUpload(user.id, dto);

      const saved = await findWithUploadId(result.id);
      expect(saved).toMatchObject({
        channel_id: channel.id,
        public_id: result.public_id,
        title: 'clip',
        status: VideoStatus.DRAFT,
        original_filename: 'clip.mp4',
        content_type: 'video/mp4',
        size: 2048,
        storage_key: `videos/${result.id}/original`,
      });
      expect(saved.upload_id).toEqual(expect.any(String));
      // The upload exists in the storage: listing its parts succeeds (empty).
      await expect(
        storage.listParts(saved.storage_key, saved.upload_id as string),
      ).resolves.toEqual([]);

      await storage.abortMultipartUpload(
        saved.storage_key,
        saved.upload_id as string,
      );
    });

    it('should give each draft its own public id', async () => {
      const first = await service.initiateUpload(user.id, dto);
      const second = await service.initiateUpload(user.id, dto);

      expect(first.public_id).not.toBe(second.public_id);
      expect(await videoRepository.count()).toBe(2);
    });

    it('should reject a user without channel and create nothing', async () => {
      await dataSource.query('DELETE FROM "channels" WHERE "id" = $1', [
        channel.id,
      ]);

      await expect(service.initiateUpload(user.id, dto)).rejects.toBeInstanceOf(
        ChannelNotFoundException,
      );
      expect(await videoRepository.count()).toBe(0);
    });
  });

  describe('owner upload operations', () => {
    const dto = { filename: 'clip.mp4', content_type: 'video/mp4', size: 2048 };

    it('should list a part uploaded through an issued URL', async () => {
      const { id } = await service.initiateUpload(user.id, dto);
      const bytes = randomBytes(dto.size);

      const { urls } = await service.createPartUploadUrls(user.id, id, [1]);
      const put = await fetch(urls[0].url, {
        method: 'PUT',
        body: new Uint8Array(bytes),
      });
      const listed = await service.listUploadedParts(user.id, id);

      expect(put.status).toBe(200);
      expect(listed.parts).toEqual([
        { part_number: 1, etag: put.headers.get('etag'), size: dto.size },
      ]);

      await service.abortUpload(user.id, id);
    });

    it('should remove the row and the multipart upload on abort', async () => {
      const { id } = await service.initiateUpload(user.id, dto);
      const before = await findWithUploadId(id);

      await service.abortUpload(user.id, id);

      await expect(videoRepository.findOneBy({ id })).resolves.toBeNull();
      // The storage no longer knows the upload: completing it is rejected.
      await expect(
        storage.completeMultipartUpload(
          before.storage_key,
          before.upload_id as string,
          [{ partNumber: 1, etag: '"x"' }],
        ),
      ).rejects.toBeInstanceOf(InvalidMultipartPartsError);
    });

    it("should refuse another user's video", async () => {
      const { id } = await service.initiateUpload(user.id, dto);
      const other = await createUserWithChannel(dataSource);

      await expect(
        service.getUploadState(other.user.id, id),
      ).rejects.toBeInstanceOf(VideoNotOwnedException);

      await service.abortUpload(user.id, id);
    });
  });

  describe('completeUpload', () => {
    const dto = { filename: 'clip.mp4', content_type: 'video/mp4', size: 2048 };

    async function uploadSinglePart(
      videoId: string,
      bytes: Buffer,
    ): Promise<string> {
      const { urls } = await service.createPartUploadUrls(
        user.id,
        videoId,
        [1],
      );
      const put = await fetch(urls[0].url, {
        method: 'PUT',
        body: new Uint8Array(bytes),
      });
      return put.headers.get('etag') as string;
    }

    it('should store the object, move the row to processing and enqueue one job', async () => {
      const { id } = await service.initiateUpload(user.id, dto);
      const etag = await uploadSinglePart(id, randomBytes(dto.size));

      const result = await service.completeUpload(user.id, id, [
        { part_number: 1, etag },
      ]);

      const saved = await findWithUploadId(id);
      expect(result.status).toBe(VideoStatus.PROCESSING);
      expect(saved.status).toBe(VideoStatus.PROCESSING);
      expect(saved.upload_id).toBeNull();
      await expect(storage.headObject(saved.storage_key)).resolves.toBe(
        dto.size,
      );

      const jobs = await queue.getJobs(['waiting']);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe(id);
      expect(jobs[0].name).toBe('process-video');
      expect(jobs[0].data).toEqual({ videoId: id });
      expect(jobs[0].opts).toMatchObject({
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      });
    });

    it('should not enqueue a second job for the same video', async () => {
      const { id } = await service.initiateUpload(user.id, dto);
      const etag = await uploadSinglePart(id, randomBytes(dto.size));
      await service.completeUpload(user.id, id, [{ part_number: 1, etag }]);

      await expect(
        service.completeUpload(user.id, id, [{ part_number: 1, etag }]),
      ).rejects.toBeInstanceOf(VideoUploadNotInProgressException);

      expect(await queue.getJobCounts('waiting')).toEqual({ waiting: 1 });
    });

    it('should keep the draft when the storage rejects the parts', async () => {
      const { id } = await service.initiateUpload(user.id, dto);
      await uploadSinglePart(id, randomBytes(dto.size));

      await expect(
        service.completeUpload(user.id, id, [
          { part_number: 1, etag: '"00000000000000000000000000000000"' },
        ]),
      ).rejects.toBeInstanceOf(InvalidUploadPartsException);

      const saved = await findWithUploadId(id);
      expect(saved.status).toBe(VideoStatus.DRAFT);
      expect(saved.upload_id).toEqual(expect.any(String));
      expect(await queue.getJobCounts('waiting')).toEqual({ waiting: 0 });

      await service.abortUpload(user.id, id);
    });

    it('should discard object and draft when fewer bytes than declared were uploaded', async () => {
      const { id } = await service.initiateUpload(user.id, dto);
      const etag = await uploadSinglePart(id, randomBytes(100));

      await expect(
        service.completeUpload(user.id, id, [{ part_number: 1, etag }]),
      ).rejects.toBeInstanceOf(UploadSizeMismatchException);

      await expect(videoRepository.findOneBy({ id })).resolves.toBeNull();
      await expect(
        storage.headObject(`videos/${id}/original`),
      ).resolves.toBeNull();
      expect(await queue.getJobCounts('waiting')).toEqual({ waiting: 0 });
    });

    it('should let the caller retry after a failed publish', async () => {
      const { id } = await service.initiateUpload(user.id, dto);
      const etag = await uploadSinglePart(id, randomBytes(dto.size));
      const publish = jest
        .spyOn(queue, 'add')
        .mockRejectedValueOnce(new Error('redis unavailable'));

      await expect(
        service.completeUpload(user.id, id, [{ part_number: 1, etag }]),
      ).rejects.toThrow('redis unavailable');
      expect((await findWithUploadId(id)).status).toBe(VideoStatus.DRAFT);

      const retried = await service.completeUpload(user.id, id, [
        { part_number: 1, etag },
      ]);

      expect(retried.status).toBe(VideoStatus.PROCESSING);
      expect(await queue.getJobCounts('waiting')).toEqual({ waiting: 1 });
      publish.mockRestore();
    });
  });
});
