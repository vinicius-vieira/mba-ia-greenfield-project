import { randomBytes } from 'node:crypto';
import {
  VIDEO_PUBLIC_ID_ALPHABET,
  VIDEO_PUBLIC_ID_LENGTH,
} from './videos.constants';

/**
 * Short, non-enumerable identifier used in a video's public URL: 11 characters
 * from a 64-symbol URL-safe alphabet (66 bits of entropy). Uniqueness is
 * enforced by the unique index on `videos.public_id`, not here.
 */
export function generateVideoPublicId(): string {
  const bytes = randomBytes(VIDEO_PUBLIC_ID_LENGTH);
  let id = '';
  for (const byte of bytes) {
    // 64 symbols: the low 6 bits of each random byte map uniformly.
    id += VIDEO_PUBLIC_ID_ALPHABET[byte & 63];
  }
  return id;
}
