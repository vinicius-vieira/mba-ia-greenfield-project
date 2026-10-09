import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { INVALID_PARTS_ERROR_CODES } from './storage.constants';
import { InvalidMultipartPartsError } from './storage.errors';
import type {
  CompletedPart,
  PresignGetOptions,
  UploadedPart,
  UrlAudience,
} from './storage.types';

const BUCKET_ALREADY_EXISTS_CODES = [
  'BucketAlreadyOwnedByYou',
  'BucketAlreadyExists',
];

function isS3Error(err: unknown, codes: readonly string[]): boolean {
  return err instanceof S3ServiceException && codes.includes(err.name);
}

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly client: S3Client;
  private readonly publicClient: S3Client;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.client = this.createClient(config.endpoint);
    this.publicClient = this.createClient(config.publicEndpoint);
  }

  async onModuleInit(): Promise<void> {
    await this.ensureBucket();
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(
        new HeadBucketCommand({ Bucket: this.config.bucket }),
      );
      return;
    } catch (err) {
      if (!isS3Error(err, ['NotFound', 'NoSuchBucket'])) throw err;
    }

    try {
      await this.client.send(
        new CreateBucketCommand({ Bucket: this.config.bucket }),
      );
    } catch (err) {
      // Another process (API vs. worker) created it between the two calls.
      if (!isS3Error(err, BUCKET_ALREADY_EXISTS_CODES)) throw err;
    }
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const { UploadId } = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!UploadId) {
      throw new Error('Storage did not return a multipart upload id');
    }
    return UploadId;
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn: number,
  ): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new UploadPartCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn },
    );
  }

  async listParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let marker: string | undefined;

    do {
      const page = await this.client.send(
        new ListPartsCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumberMarker: marker,
        }),
      );
      for (const part of page.Parts ?? []) {
        parts.push({
          partNumber: part.PartNumber ?? 0,
          etag: part.ETag ?? '',
          size: part.Size ?? 0,
        });
      }
      marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
    } while (marker);

    return parts;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);

    try {
      await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: ordered.map((part) => ({
              PartNumber: part.partNumber,
              ETag: part.etag,
            })),
          },
        }),
      );
    } catch (err) {
      if (
        err instanceof S3ServiceException &&
        isS3Error(err, INVALID_PARTS_ERROR_CODES)
      ) {
        throw new InvalidMultipartPartsError(err.name);
      }
      throw err;
    }
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
    } catch (err) {
      // Already aborted or completed: nothing left to discard.
      if (!isS3Error(err, ['NoSuchUpload'])) throw err;
    }
  }

  async presignGetObject(
    key: string,
    options: PresignGetOptions,
  ): Promise<string> {
    return getSignedUrl(
      this.clientFor(options.audience),
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        ResponseContentDisposition: options.responseContentDisposition,
        ResponseContentType: options.responseContentType,
      }),
      { expiresIn: options.expiresIn },
    );
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  /** Size in bytes of the stored object, or `null` when it does not exist. */
  async headObject(key: string): Promise<number | null> {
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      return head.ContentLength ?? 0;
    } catch (err) {
      if (isS3Error(err, ['NotFound', 'NoSuchKey'])) return null;
      throw err;
    }
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
  }

  private clientFor(audience: UrlAudience): S3Client {
    return audience === 'public' ? this.publicClient : this.client;
  }

  private createClient(endpoint: string): S3Client {
    return new S3Client({
      endpoint,
      region: this.config.region,
      credentials: {
        accessKeyId: this.config.accessKey,
        secretAccessKey: this.config.secretKey,
      },
      // MinIO addresses buckets by path, not by subdomain.
      forcePathStyle: true,
      // Presigned part URLs are used with a plain HTTP PUT; without this the
      // SDK signs a checksum header the browser would also have to send.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }
}
