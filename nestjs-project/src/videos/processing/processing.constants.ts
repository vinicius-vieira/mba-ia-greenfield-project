export const FFPROBE_BINARY = 'ffprobe';
export const FFMPEG_BINARY = 'ffmpeg';

export const FFPROBE_TIMEOUT_MS = 60_000;
export const FFMPEG_TIMEOUT_MS = 120_000;

/** ffprobe prints the whole stream description as JSON on stdout. */
export const FFPROBE_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export const THUMBNAIL_POSITION_RATIO = 0.1;
export const THUMBNAIL_MAX_OFFSET_SECONDS = 10;
export const THUMBNAIL_MAX_WIDTH = 1280;
export const THUMBNAIL_FILENAME = 'thumbnail.jpg';

/** Lifetime of the internal URL FFmpeg reads the source from. */
export const SOURCE_URL_TTL_SECONDS = 3600;

export const WORKER_TEMP_DIR_PREFIX = 'streamtube-video-';

export const FAILURE_REASON_MAX_LENGTH = 500;

/**
 * stderr messages that mean "this file is not decodable media" — as opposed
 * to a network or storage failure, which is worth retrying.
 */
export const INVALID_MEDIA_STDERR_PATTERNS = [
  /Invalid data found when processing input/i,
  /moov atom not found/i,
  /could not find codec parameters/i,
] as const;

/** Stored when processing fails for reasons unrelated to the file itself. */
export const GENERIC_FAILURE_REASON = 'Video processing failed';
