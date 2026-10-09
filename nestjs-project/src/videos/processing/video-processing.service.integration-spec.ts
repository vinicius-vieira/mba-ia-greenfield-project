import { readFile } from 'node:fs/promises';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { StorageService } from '../../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { createTestStorageService } from '../../test/storage-test-env';
import { createUserWithChannel, createVideo } from '../../test/video-factory';
import { generateSampleVideo, SampleVideo } from '../../test/video-fixture';
import { Video, VideoStatus } from '../entities/video.entity';
import { InvalidMediaError } from './ffprobe.parser';
import { MediaInspectorService } from './media-inspector.service';
import { VideoProcessingService } from './video-processing.service';

const JPEG_MAGIC = [0xff, 0xd8, 0xff];

describe('VideoProcessingService (integration)', () => {
  let dataSource: DataSource;
  let storage: StorageService;
  let videoRepository: Repository<Video>;
  let service: VideoProcessingService;
  let sample: SampleVideo;
  let channel: Channel;
  const storedKeys: string[] = [];

  async function givenProcessingVideo(
    body: Buffer,
    overrides: Partial<Video> = {},
  ): Promise<Video> {
    const video = await createVideo(dataSource, channel.id, {
      status: VideoStatus.PROCESSING,
      size: body.length,
      ...overrides,
    });
    await storage.putObject(video.storage_key, body, 'video/mp4');
    storedKeys.push(video.storage_key, `videos/${video.id}/thumbnail.jpg`);
    return video;
  }

  beforeAll(async () => {
    dataSource = createTestDataSource([Video]);
    await dataSource.initialize();
    storage = await createTestStorageService();
    videoRepository = dataSource.getRepository(Video);
    service = new VideoProcessingService(
      videoRepository,
      storage,
      new MediaInspectorService(),
    );
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    sample = await generateSampleVideo();
  }, 30_000);

  afterAll(async () => {
    await Promise.all(storedKeys.map((key) => storage.deleteObject(key)));
    await sample.cleanup();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    ({ channel } = await createUserWithChannel(dataSource));
  });

  describe('process', () => {
    it('should make a processing video ready with metadata and a stored thumbnail', async () => {
      const video = await givenProcessingVideo(await readFile(sample.path));

      await service.process(video.id);

      const saved = await videoRepository.findOneByOrFail({ id: video.id });
      expect(saved.status).toBe(VideoStatus.READY);
      expect(saved.duration).toBeCloseTo(2, 0);
      expect(saved.metadata).toEqual({
        width: 320,
        height: 240,
        video_codec: 'h264',
        audio_codec: 'aac',
        bitrate: expect.any(Number),
        frame_rate: 10,
        container_format: expect.stringContaining('mp4'),
      });
      expect(saved.thumbnail_key).toBe(`videos/${video.id}/thumbnail.jpg`);
      expect(saved.processed_at).toBeInstanceOf(Date);
      expect(saved.failure_reason).toBeNull();

      const thumbnailUrl = await storage.presignGetObject(
        saved.thumbnail_key as string,
        { expiresIn: 60, audience: 'internal' },
      );
      const thumbnail = await fetch(thumbnailUrl);
      expect(thumbnail.headers.get('content-type')).toBe('image/jpeg');
      const bytes = new Uint8Array(await thumbnail.arrayBuffer());
      expect(Array.from(bytes.subarray(0, 3))).toEqual(JPEG_MAGIC);
    }, 30_000);

    it('should reject an object that is not media and leave the status to the caller', async () => {
      const video = await givenProcessingVideo(
        Buffer.from('plain text pretending to be a video\n'.repeat(100)),
      );

      await expect(service.process(video.id)).rejects.toBeInstanceOf(
        InvalidMediaError,
      );

      const saved = await videoRepository.findOneByOrFail({ id: video.id });
      expect(saved.status).toBe(VideoStatus.PROCESSING);
      // The upload is kept for diagnosis.
      await expect(storage.headObject(video.storage_key)).resolves.toBe(
        video.size,
      );
    });

    it('should fail with a retryable error when the object is missing', async () => {
      const video = await createVideo(dataSource, channel.id, {
        status: VideoStatus.PROCESSING,
      });

      const failure = service.process(video.id);

      await expect(failure).rejects.toThrow(/^ffprobe failed: /);
      await expect(failure).rejects.not.toBeInstanceOf(InvalidMediaError);
    });

    it('should not reprocess a video that is already ready', async () => {
      const video = await givenProcessingVideo(await readFile(sample.path), {
        status: VideoStatus.READY,
        duration: 99,
      });

      await service.process(video.id);

      const saved = await videoRepository.findOneByOrFail({ id: video.id });
      expect(saved.duration).toBe(99);
      expect(saved.thumbnail_key).toBeNull();
    });

    it('should complete without error for a deleted video', async () => {
      await expect(
        service.process('00000000-0000-4000-8000-000000000000'),
      ).resolves.toBeUndefined();
    });
  });

  describe('markFailed', () => {
    it('should move a processing video to failed with the reason', async () => {
      const video = await createVideo(dataSource, channel.id, {
        status: VideoStatus.PROCESSING,
      });

      await service.markFailed(video.id, 'File is not a valid video');

      const saved = await videoRepository.findOneByOrFail({ id: video.id });
      expect(saved.status).toBe(VideoStatus.FAILED);
      expect(saved.failure_reason).toBe('File is not a valid video');
    });

    it.each([VideoStatus.READY, VideoStatus.DRAFT])(
      'should leave a %s video untouched',
      async (status) => {
        const video = await createVideo(dataSource, channel.id, { status });

        await service.markFailed(video.id, 'late failure');

        const saved = await videoRepository.findOneByOrFail({ id: video.id });
        expect(saved.status).toBe(status);
        expect(saved.failure_reason).toBeNull();
      },
    );
  });
});
