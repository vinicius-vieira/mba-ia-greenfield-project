/** Largest upload accepted: 10GB. */
export const MAX_VIDEO_SIZE_BYTES = 10 * 1024 * 1024 * 1024;

/** Fixed multipart part size: 16MB (640 parts for a 10GB file; S3 allows 10,000). */
export const UPLOAD_PART_SIZE_BYTES = 16 * 1024 * 1024;

/** Lifetime of every presigned URL handed to a client: 1 hour. */
export const PRESIGNED_URL_TTL_SECONDS = 3600;

export const MAX_PART_URLS_PER_REQUEST = 100;

/** S3 caps a multipart upload at 10,000 parts. */
export const MAX_UPLOAD_PARTS = 10_000;

export const VIDEO_PUBLIC_ID_LENGTH = 11;

export const VIDEO_PUBLIC_ID_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

export const VIDEO_PUBLIC_ID_MAX_ATTEMPTS = 5;

export const VIDEO_CONTENT_TYPE_PATTERN = /^video\//;
