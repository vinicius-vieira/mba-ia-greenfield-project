export const VIDEO_KEY_PREFIX = 'videos';

export function videoOriginalKey(videoId: string): string {
  return `${VIDEO_KEY_PREFIX}/${videoId}/original`;
}

export function videoThumbnailKey(videoId: string): string {
  return `${VIDEO_KEY_PREFIX}/${videoId}/thumbnail.jpg`;
}

export const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';

/** S3 error codes meaning the client sent a part list the storage cannot assemble. */
export const INVALID_PARTS_ERROR_CODES = [
  'InvalidPart',
  'InvalidPartOrder',
  'EntityTooSmall',
  'NoSuchUpload',
] as const;
