export interface UploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

/**
 * Who will dereference a presigned URL: `public` URLs are signed for the host
 * clients reach from outside the Compose network, `internal` ones for the host
 * the API and the worker use.
 */
export type UrlAudience = 'public' | 'internal';

export interface PresignGetOptions {
  expiresIn: number;
  audience: UrlAudience;
  responseContentDisposition?: string;
  responseContentType?: string;
}
