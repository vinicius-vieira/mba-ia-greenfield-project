import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';

/**
 * Presigned URLs for clients are signed for STORAGE_PUBLIC_ENDPOINT
 * (`localhost:9000` in development), which is not reachable from inside the
 * container where the tests run. Point it at the internal endpoint for the
 * current test process so tests can dereference the URLs they receive.
 *
 * Call before the Nest module (or the config factory) is created.
 */
export function useInternalStorageEndpoint(): void {
  process.env.STORAGE_PUBLIC_ENDPOINT =
    process.env.STORAGE_ENDPOINT ?? 'http://minio:9000';
}

/** A StorageService wired to the real storage of the Compose stack. */
export async function createTestStorageService(): Promise<StorageService> {
  useInternalStorageEndpoint();
  const storage = new StorageService(storageConfig());
  await storage.ensureBucket();
  return storage;
}
