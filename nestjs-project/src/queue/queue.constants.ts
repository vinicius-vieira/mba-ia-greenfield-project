export const VIDEO_PROCESSING_QUEUE = 'video-processing';

export const PROCESS_VIDEO_JOB = 'process-video';

/**
 * Retry policy for the processing job: 3 attempts, 5s → 10s backoff.
 * Finished jobs are removed (the video row is the record of the outcome);
 * the last failed jobs are kept for inspection.
 */
export const VIDEO_PROCESSING_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: true,
  removeOnFail: 1000,
} as const;

export interface ProcessVideoJobData {
  videoId: string;
}
