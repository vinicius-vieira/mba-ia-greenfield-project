import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  // URL the API and the worker use to reach the storage (Compose service name).
  endpoint: process.env.STORAGE_ENDPOINT || 'http://minio:9000',
  // URL written into presigned links handed to clients outside the Compose network.
  publicEndpoint:
    process.env.STORAGE_PUBLIC_ENDPOINT || 'http://localhost:9000',
  region: process.env.STORAGE_REGION || 'us-east-1',
  accessKey: process.env.STORAGE_ACCESS_KEY!,
  secretKey: process.env.STORAGE_SECRET_KEY!,
  bucket: process.env.STORAGE_BUCKET || 'streamtube',
}));
