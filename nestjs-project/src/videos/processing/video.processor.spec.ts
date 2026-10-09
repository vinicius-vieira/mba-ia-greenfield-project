import { type Job, UnrecoverableError } from 'bullmq';
import type { ProcessVideoJobData } from '../../queue/queue.constants';
import { InvalidMediaError } from './ffprobe.parser';
import { VideoProcessor } from './video.processor';

function jobWith(
  attemptsMade: number,
  opts: { attempts?: number } = { attempts: 3 },
): Job<ProcessVideoJobData> {
  return {
    id: 'video-1',
    data: { videoId: 'video-1' },
    attemptsMade,
    opts,
  } as Job<ProcessVideoJobData>;
}

describe('VideoProcessor', () => {
  let processor: VideoProcessor;
  let videoProcessing: { process: jest.Mock; markFailed: jest.Mock };

  beforeEach(() => {
    videoProcessing = {
      process: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };
    processor = new VideoProcessor(videoProcessing as never);
    // Silence the expected warn/error logs of the failure paths.
    jest.spyOn(processor['logger'], 'warn').mockImplementation(() => undefined);
    jest
      .spyOn(processor['logger'], 'error')
      .mockImplementation(() => undefined);
  });

  describe('process', () => {
    it('should delegate the video id of the job', async () => {
      await processor.process(jobWith(0));

      expect(videoProcessing.process).toHaveBeenCalledWith('video-1');
    });

    it('should turn invalid media into an unrecoverable job failure', async () => {
      videoProcessing.process.mockRejectedValue(
        new InvalidMediaError('No video stream found'),
      );

      const failure = processor.process(jobWith(0));

      await expect(failure).rejects.toBeInstanceOf(UnrecoverableError);
      await expect(failure).rejects.toThrow('No video stream found');
    });

    it('should rethrow any other error unchanged so the queue retries it', async () => {
      const outage = new Error('ffprobe failed: Connection refused');
      videoProcessing.process.mockRejectedValue(outage);

      await expect(processor.process(jobWith(0))).rejects.toBe(outage);
    });
  });

  describe('onFailed', () => {
    it('should not fail the video while attempts remain', async () => {
      await processor.onFailed(jobWith(1), new Error('transient'));
      await processor.onFailed(jobWith(2), new Error('transient'));

      expect(videoProcessing.markFailed).not.toHaveBeenCalled();
    });

    it('should fail the video with a generic reason after the last attempt', async () => {
      await processor.onFailed(
        jobWith(3),
        new Error('ffprobe failed: http://minio:9000/secret-url refused'),
      );

      expect(videoProcessing.markFailed).toHaveBeenCalledWith(
        'video-1',
        'Video processing failed',
      );
    });

    it('should fail the video immediately on an unrecoverable error, with its reason', async () => {
      await processor.onFailed(
        jobWith(1),
        new UnrecoverableError('File is not a valid video'),
      );

      expect(videoProcessing.markFailed).toHaveBeenCalledWith(
        'video-1',
        'File is not a valid video',
      );
    });

    it('should treat a job without an attempts option as single-attempt', async () => {
      await processor.onFailed(jobWith(1, {}), new Error('boom'));

      expect(videoProcessing.markFailed).toHaveBeenCalledTimes(1);
    });

    it('should ignore an event without a job', async () => {
      await processor.onFailed(undefined, new Error('boom'));

      expect(videoProcessing.markFailed).not.toHaveBeenCalled();
    });

    it('should not throw when the video cannot be marked as failed', async () => {
      videoProcessing.markFailed.mockRejectedValue(new Error('db down'));

      await expect(
        processor.onFailed(jobWith(3), new Error('boom')),
      ).resolves.toBeUndefined();
    });
  });
});
