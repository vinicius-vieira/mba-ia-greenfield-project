import { DeleteBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { randomBytes, randomUUID } from 'node:crypto';
import storageConfig from '../config/storage.config';
import { createTestStorageService } from '../test/storage-test-env';
import { InvalidMultipartPartsError } from './storage.errors';
import { StorageService } from './storage.service';

const MIN_PART_SIZE = 5 * 1024 * 1024;

async function removeBucket(
  config: ReturnType<typeof storageConfig>,
): Promise<void> {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
    forcePathStyle: true,
  });
  await client.send(new DeleteBucketCommand({ Bucket: config.bucket }));
  client.destroy();
}

async function putPart(url: string, body: Buffer): Promise<string> {
  const res = await fetch(url, { method: 'PUT', body: new Uint8Array(body) });
  expect(res.status).toBe(200);
  const etag = res.headers.get('etag');
  expect(etag).toBeTruthy();
  return etag as string;
}

describe('StorageService (integration)', () => {
  let storage: StorageService;
  const createdKeys: string[] = [];

  function newKey(): string {
    const key = `test/${randomUUID()}`;
    createdKeys.push(key);
    return key;
  }

  beforeAll(async () => {
    storage = await createTestStorageService();
  });

  afterAll(async () => {
    await Promise.all(createdKeys.map((key) => storage.deleteObject(key)));
  });

  describe('ensureBucket', () => {
    it('should succeed when the bucket already exists', async () => {
      await expect(storage.ensureBucket()).resolves.toBeUndefined();
    });

    it('should create a missing bucket', async () => {
      const config = { ...storageConfig(), bucket: `test-${randomUUID()}` };
      const other = new StorageService(config);

      await other.ensureBucket();

      await expect(other.headObject('missing')).resolves.toBeNull();
      await removeBucket(config);
    });
  });

  describe('multipart upload', () => {
    it('should assemble parts sent through presigned URLs into one object', async () => {
      const key = newKey();
      const first = randomBytes(MIN_PART_SIZE);
      const second = randomBytes(1024);
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

      const etag1 = await putPart(
        await storage.presignUploadPart(key, uploadId, 1, 60),
        first,
      );
      const etag2 = await putPart(
        await storage.presignUploadPart(key, uploadId, 2, 60),
        second,
      );

      const listed = await storage.listParts(key, uploadId);
      expect(listed).toEqual([
        { partNumber: 1, etag: etag1, size: first.length },
        { partNumber: 2, etag: etag2, size: second.length },
      ]);

      // Parts given out of order are sorted before reaching the storage.
      await storage.completeMultipartUpload(key, uploadId, [
        { partNumber: 2, etag: etag2 },
        { partNumber: 1, etag: etag1 },
      ]);

      await expect(storage.headObject(key)).resolves.toBe(
        first.length + second.length,
      );
    }, 30_000);

    it('should reject a part list with an unknown ETag', async () => {
      const key = newKey();
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
      await putPart(
        await storage.presignUploadPart(key, uploadId, 1, 60),
        randomBytes(64),
      );

      await expect(
        storage.completeMultipartUpload(key, uploadId, [
          { partNumber: 1, etag: '"00000000000000000000000000000000"' },
        ]),
      ).rejects.toBeInstanceOf(InvalidMultipartPartsError);

      await storage.abortMultipartUpload(key, uploadId);
    });

    it('should discard the upload on abort and tolerate a second abort', async () => {
      const key = newKey();
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
      const etag = await putPart(
        await storage.presignUploadPart(key, uploadId, 1, 60),
        randomBytes(64),
      );

      await storage.abortMultipartUpload(key, uploadId);

      await expect(
        storage.completeMultipartUpload(key, uploadId, [
          { partNumber: 1, etag },
        ]),
      ).rejects.toBeInstanceOf(InvalidMultipartPartsError);
      await expect(storage.headObject(key)).resolves.toBeNull();
      await expect(
        storage.abortMultipartUpload(key, uploadId),
      ).resolves.toBeUndefined();
    });
  });

  describe('objects', () => {
    it('should store, measure and delete an object', async () => {
      const key = newKey();

      await storage.putObject(key, Buffer.from('hello'), 'text/plain');
      await expect(storage.headObject(key)).resolves.toBe(5);

      await storage.deleteObject(key);
      await expect(storage.headObject(key)).resolves.toBeNull();
    });
  });

  describe('presignGetObject', () => {
    it('should serve a byte range with 206 Partial Content', async () => {
      const key = newKey();
      await storage.putObject(
        key,
        Buffer.from('0123456789abcdef'),
        'video/mp4',
      );
      const url = await storage.presignGetObject(key, {
        expiresIn: 60,
        audience: 'internal',
      });

      const res = await fetch(url, { headers: { Range: 'bytes=0-9' } });

      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe('bytes 0-9/16');
      expect(await res.text()).toBe('0123456789');
    });

    it('should override the response headers it was signed with', async () => {
      const key = newKey();
      await storage.putObject(
        key,
        Buffer.from('data'),
        'application/octet-stream',
      );
      const url = await storage.presignGetObject(key, {
        expiresIn: 60,
        audience: 'internal',
        responseContentDisposition: 'attachment; filename="clip.mp4"',
        responseContentType: 'video/mp4',
      });

      const res = await fetch(url);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toBe(
        'attachment; filename="clip.mp4"',
      );
      expect(res.headers.get('content-type')).toBe('video/mp4');
    });

    it('should sign for the host of the requested audience', async () => {
      const config = {
        ...storageConfig(),
        endpoint: 'http://minio:9000',
        publicEndpoint: 'http://localhost:9000',
      };
      const split = new StorageService(config);

      const publicUrl = await split.presignGetObject('k', {
        expiresIn: 60,
        audience: 'public',
      });
      const internalUrl = await split.presignGetObject('k', {
        expiresIn: 60,
        audience: 'internal',
      });
      const partUrl = await split.presignUploadPart('k', 'upload', 1, 60);

      expect(new URL(publicUrl).host).toBe('localhost:9000');
      expect(new URL(internalUrl).host).toBe('minio:9000');
      expect(new URL(partUrl).host).toBe('localhost:9000');
    });
  });
});
