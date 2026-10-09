import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { type Job, UnrecoverableError } from 'bullmq';
import {
  type ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from '../../queue/queue.constants';
import { InvalidMediaError } from './ffprobe.parser';
import { GENERIC_FAILURE_REASON } from './processing.constants';
import { VideoProcessingService } from './video-processing.service';

/** Queue adapter: delegates the work and applies the retry/failure policy. */
@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(private readonly videoProcessing: VideoProcessingService) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    try {
      await this.videoProcessing.process(job.data.videoId);
    } catch (err) {
      // A file that is not a video will not become one on the next attempt.
      if (err instanceof InvalidMediaError) {
        throw new UnrecoverableError(err.message);
      }
      throw err;
    }
  }

  /** Fires on every failed attempt; only the last one fails the video. */
  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<ProcessVideoJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;

    const unrecoverable = error instanceof UnrecoverableError;
    const attempts = job.opts.attempts ?? 1;
    this.logger.warn(
      `Job ${job.id} failed (attempt ${job.attemptsMade}/${attempts}): ${error.message}`,
    );
    if (!unrecoverable && job.attemptsMade < attempts) return;

    // The raw error of a transient failure can carry internal URLs; the owner
    // only sees a reason for failures caused by the file itself.
    const reason = unrecoverable ? error.message : GENERIC_FAILURE_REASON;
    try {
      await this.videoProcessing.markFailed(job.data.videoId, reason);
    } catch (err) {
      // Event handler in a background worker: rethrowing would crash it.
      this.logger.error(
        `Could not mark video ${job.data.videoId} as failed`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
