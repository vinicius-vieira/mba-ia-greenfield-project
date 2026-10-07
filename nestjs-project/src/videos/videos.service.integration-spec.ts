import { DataSource, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import { ChannelNotFoundException } from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
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
    service = new VideosService(
      videoRepository,
      new ChannelsService(dataSource),
      storage,
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
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
});
