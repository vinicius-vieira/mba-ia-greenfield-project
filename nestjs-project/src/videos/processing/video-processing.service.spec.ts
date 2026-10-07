import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { buildVideo } from '../../test/video-factory';
import { Video, VideoStatus } from '../entities/video.entity';
import { InvalidMediaError } from './ffprobe.parser';
import { VideoProcessingService } from './video-processing.service';

const metadata = {
  width: 320,
  height: 240,
  video_codec: 'h264',
  audio_codec: 'aac',
  bitrate: 100_000,
  frame_rate: 10,
  container_format: 'mov,mp4',
};

describe('VideoProcessingService', () => {
  let service: VideoProcessingService;
  let videoRepository: { findOne: jest.Mock; update: jest.Mock };
  let storageService: { presignGetObject: jest.Mock; putObject: jest.Mock };
  let mediaInspector: { probe: jest.Mock; captureThumbnail: jest.Mock };
  let video: Video;
  let workDir: string | undefined;

  beforeEach(() => {
    video = buildVideo('channel-1', { status: VideoStatus.PROCESSING });
    workDir = undefined;
    videoRepository = {
      findOne: jest.fn().mockResolvedValue(video),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    storageService = {
      presignGetObject: jest.fn().mockResolvedValue('http://minio/source'),
      putObject: jest.fn().mockResolvedValue(undefined),
    };
    mediaInspector = {
      probe: jest.fn().mockResolvedValue({ duration: 2, metadata }),
      captureThumbnail: jest.fn(
        async (_input: string, _duration: number, outputPath: string) => {
          workDir = dirname(outputPath);
          await writeFile(outputPath, 'jpeg-bytes');
        },
      ),
    };
    service = new VideoProcessingService(
      videoRepository as never,
      storageService as never,
      mediaInspector as never,
    );
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
  });

  describe('process', () => {
    it('should read the source through an internal URL and mark the video ready', async () => {
      await service.process(video.id);

      expect(storageService.presignGetObject).toHaveBeenCalledWith(
        video.storage_key,
        { expiresIn: 3600, audience: 'internal' },
      );
      expect(mediaInspector.captureThumbnail).toHaveBeenCalledWith(
        'http://minio/source',
        2,
        expect.stringMatching(/thumbnail\.jpg$/),
      );
      expect(storageService.putObject).toHaveBeenCalledWith(
        `videos/${video.id}/thumbnail.jpg`,
        Buffer.from('jpeg-bytes'),
        'image/jpeg',
      );
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: video.id, status: VideoStatus.PROCESSING },
        {
          status: VideoStatus.READY,
          duration: 2,
          metadata,
          thumbnail_key: `videos/${video.id}/thumbnail.jpg`,
          processed_at: expect.any(Date),
        },
      );
    });

    it('should remove its temp directory after a successful run', async () => {
      await service.process(video.id);

      expect(workDir).toBeDefined();
      expect(existsSync(workDir as string)).toBe(false);
    });

    it('should remove its temp directory when storing the thumbnail fails', async () => {
      storageService.putObject.mockRejectedValue(new Error('storage down'));

      await expect(service.process(video.id)).rejects.toThrow('storage down');

      expect(existsSync(workDir as string)).toBe(false);
      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it('should propagate a probe error without changing the status', async () => {
      const invalid = new InvalidMediaError('File is not a valid video');
      mediaInspector.probe.mockRejectedValue(invalid);

      await expect(service.process(video.id)).rejects.toBe(invalid);

      expect(mediaInspector.captureThumbnail).not.toHaveBeenCalled();
      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it('should do nothing for a video that no longer exists', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(service.process('gone')).resolves.toBeUndefined();

      expect(storageService.presignGetObject).not.toHaveBeenCalled();
      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it.each([VideoStatus.DRAFT, VideoStatus.READY, VideoStatus.FAILED])(
      'should do nothing for a %s video',
      async (status) => {
        video.status = status;

        await service.process(video.id);

        expect(mediaInspector.probe).not.toHaveBeenCalled();
        expect(videoRepository.update).not.toHaveBeenCalled();
      },
    );
  });

  describe('markFailed', () => {
    it('should fail only a processing video and store the reason', async () => {
      await service.markFailed(video.id, 'File is not a valid video');

      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: video.id, status: VideoStatus.PROCESSING },
        {
          status: VideoStatus.FAILED,
          failure_reason: 'File is not a valid video',
        },
      );
    });

    it('should truncate a very long reason', async () => {
      await service.markFailed(video.id, 'x'.repeat(2000));

      const [, set] = videoRepository.update.mock.calls[0] as [
        unknown,
        { failure_reason: string },
      ];
      expect(set.failure_reason).toHaveLength(500);
    });
  });
});
