---
libs:
  "@nestjs/bullmq":
    version: "^11.0.5"
    context7_id: "/nestjs/docs.nestjs.com"
    fetched_at: "2026-10-07T01:28:36-03:00"
  bullmq:
    version: "^6.3.x"
    context7_id: "/websites/bullmq_io"
    fetched_at: "2026-10-07T01:28:36-03:00"
  "@aws-sdk/client-s3":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-07T01:28:36-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-07T01:28:36-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-07T01:27:40-03:00"
---

# phase-03-videos — Library References

Distilled docs for the libraries decided in this phase. Pulled via Context7 on 2026-10-07; versions checked against the npm registry from inside the `nestjs-api` container on the same day. Re-fetch when the underlying TD changes.

## @nestjs/bullmq

**Source:** `/nestjs/docs.nestjs.com` (content/application/queues.md, content/application-context.md) and `/nestjs/bull` (API reference). Maps to `phase-03-videos/TD-01` Decision A and `phase-03-videos/TD-04` Decision A.

**Version pin:** `^11.0.5`. Registry check: `@nestjs/bullmq@12.0.0` declares `"type": "module"` (ESM-only); the 11.x line is CommonJS with peers `@nestjs/common`/`@nestjs/core` `^10 || ^11` and `bullmq` `^3 || ^4 || ^5 || ^6`. The project compiles to CommonJS (ts-jest, `nest build`), so 11.x is the line to install.

### Root configuration (async, from typed config)

```typescript
import { BullModule } from '@nestjs/bullmq';

BullModule.forRootAsync({
  inject: [queueConfig.KEY],
  useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
    connection: { host: cfg.host, port: cfg.port },
    prefix: cfg.prefix,
  }),
});
```

`forRootAsync` registers a global module; the factory returns BullMQ `QueueOptions` (`connection`, `prefix`, `defaultJobOptions`). `extraOptions` is a top-level property of the async config, not part of the factory result.

### Registering a queue and producing jobs

```typescript
BullModule.registerQueue({ name: 'audio', defaultJobOptions: { attempts: 2 } });

@Injectable()
export class AudioService {
  constructor(@InjectQueue('audio') private audioQueue: Queue) {}
}
```

`@InjectQueue(name)` identifies the queue by the name passed to `registerQueue()`. In tests the instance is obtained with `module.get<Queue>(getQueueToken(name))`.

### Consumers

```typescript
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';

@Processor('audio', { concurrency: 5 })
export class AudioConsumer extends WorkerHost {
  async process(job: Job<any, any, string>): Promise<any> {
    switch (job.name) {
      case 'transcode':
        return {};
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) {}
}
```

- BullMQ consumers extend `WorkerHost` and implement `process(job)`; the legacy `@Process()` decorator does not exist in `@nestjs/bullmq` — named jobs are routed by `job.name` inside `process`.
- `@Processor(queueName, workerOptions)` accepts raw BullMQ `WorkerOptions` as second argument (`concurrency`, `lockDuration`, `limiter`).
- Worker events are declared inside the `@Processor` class with `@OnWorkerEvent('active' | 'completed' | 'failed' | ...)`.
- The worker is created from the queue's root connection/prefix and is closed on application shutdown.
- A processor is only instantiated in the application that lists it as a provider: registering the queue without the consumer class gives a producer-only process.

### Standalone application (worker process, no HTTP listener)

```typescript
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
}
```

A standalone application wraps the Nest IoC container without network listeners. `app.close()` triggers the shutdown lifecycle hooks; `app.enableShutdownHooks()` makes SIGTERM/SIGINT run them.

## bullmq

**Source:** `/websites/bullmq_io` (docs.bullmq.io). Maps to `phase-03-videos/TD-01` Decision A and `phase-03-videos/TD-07` Decision A.

**Version pin:** `^6.3.x` (registry latest 6.3.11, `main: ./dist/cjs/index.js`, `engines.node >= 14.17`).

**Redis client peer:** `bullmq@6` declares `ioredis` (`>=5.0.0`) as an *optional* peer dependency and does not install it; with `connection: { host, port }` options it loads `ioredis` at runtime and fails with "BullMQ could not load the optional 'ioredis' package" when absent. The project installs `ioredis@^5` alongside it (found during SI-03.4).

### Job options used by this phase

```typescript
await queue.add('process', data, {
  jobId: customJobId,
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: true,
  removeOnFail: 1000,
});
```

- `jobId`: adding a job whose ID already exists in the queue is ignored — the deduplication primitive. Because the ID stays reserved while the job is retained, a job that must be re-addable later has to be removed on completion/failure (or removed explicitly).
- `attempts` + `backoff`: the job is retried up to `attempts` times; `exponential` backoff waits `delay * 2^(attemptsMade - 1)`.
- `removeOnComplete` / `removeOnFail`: `true` removes immediately; a number keeps the last N jobs.

### Stop retrying

```typescript
import { UnrecoverableError } from 'bullmq';
throw new UnrecoverableError('Unrecoverable');
```

Throwing `UnrecoverableError` moves the job directly to the failed set, overriding `attempts`.

### Failure events

```typescript
worker.on('failed', (job: Job, error: Error) => {});
```

The `failed` event fires every time the process function throws — including attempts that will still be retried. A final failure is the one where `job.attemptsMade >= job.opts.attempts` or the error is an `UnrecoverableError`. `job.attemptsMade` is available inside `process` as well.

### Stalled jobs

A job whose lock expires (worker crashed or the event loop was blocked longer than `lockDuration`) is moved back to waiting by the stalled checker, or to failed after exhausting the maximum stalled count (default 1). CPU-bound work must not block the worker's event loop — spawning a child process (FFmpeg) keeps the loop free to renew the lock.

## @aws-sdk/client-s3

**Source:** `/aws/aws-sdk-js-v3` (clients/client-s3 command sources, supplemental-docs/CLIENTS.md and EFFECTIVE_PRACTICES.md). Maps to `phase-03-videos/TD-02`, `phase-03-videos/TD-03` and `phase-03-videos/TD-06` Decision A.

**Version pin:** `^3.x` (registry latest 3.1147.0, `engines.node >= 20`).

### Client for an S3-compatible endpoint

```typescript
const client = new S3Client({
  endpoint: 'http://localhost:8888',
  region,
  credentials: { accessKeyId, secretAccessKey },
  forcePathStyle: true,
});
```

A static `endpoint` overrides the rule-based endpoint resolution. MinIO requires path-style addressing (`forcePathStyle: true`). Create one client per set of credentials/region/endpoint and reuse it.

### Multipart upload commands

| Command | Required input | Relevant output |
|---------|----------------|-----------------|
| `CreateMultipartUploadCommand` | `Bucket`, `Key` (optional `ContentType`) | `UploadId` |
| `UploadPartCommand` | `Bucket`, `Key`, `UploadId`, `PartNumber` (1–10000), `Body` | `ETag` |
| `ListPartsCommand` | `Bucket`, `Key`, `UploadId` | `Parts[] { PartNumber, ETag, Size }`, `IsTruncated`, `NextPartNumberMarker` |
| `CompleteMultipartUploadCommand` | `Bucket`, `Key`, `UploadId`, `MultipartUpload: { Parts: [{ PartNumber, ETag }] }` (ascending part numbers) | `Location`, `ETag` |
| `AbortMultipartUploadCommand` | `Bucket`, `Key`, `UploadId` | — |

S3 limits: parts are 5MB–5GB (the last part may be smaller), at most 10,000 parts per upload, object size up to 5TB. `UploadPartCommand` is not sent by the API in this phase — it is only the command that gets presigned for the client.

### Other commands used

`HeadBucketCommand` / `CreateBucketCommand` (bucket bootstrap), `HeadObjectCommand` (`ContentLength`, `ContentType`), `PutObjectCommand` (thumbnail upload: `Bucket`, `Key`, `Body`, `ContentType`), `GetObjectCommand` (presigned for playback/download; accepts `ResponseContentDisposition` and `ResponseContentType` to override response headers), `DeleteObjectCommand`.

## @aws-sdk/s3-request-presigner

**Source:** `/aws/aws-sdk-js-v3` (packages/s3-request-presigner/README.md). Maps to `phase-03-videos/TD-02` and `phase-03-videos/TD-06` Decision A.

**Version pin:** `^3.x` (same release train as `@aws-sdk/client-s3`).

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const url = await getSignedUrl(client, command, { expiresIn: 3600 });
```

- Works with any command object: `UploadPartCommand` (per-part upload URL, HTTP `PUT`), `GetObjectCommand` (playback/download URL, HTTP `GET`).
- `expiresIn` is in seconds and defaults to 900.
- The signature covers the host of the client's `endpoint`: a URL signed with the internal endpoint is not valid when requested through another host name. A client that must hand URLs to browsers is constructed with the externally reachable endpoint.
- Signing is a local computation (no network call to the storage).
- A presigned `GET` is served by the storage like any object read, so `Range` requests are answered with `206 Partial Content`.
