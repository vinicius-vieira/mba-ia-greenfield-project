> Part of the `testing-guide-nestjs-project` skill (see `../SKILL.md`).

# External System Strategies

How each external system is handled in tests. These strategies were confirmed with the team.

---

## PostgreSQL — Real (Docker)

**Strategy:** Real database via the Docker `db` service (already in `compose.yaml`).

**Connection config for tests:**
```typescript
{
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME ?? 'streamtube',
  password: process.env.DB_PASSWORD ?? 'streamtube',
  database: process.env.DB_DATABASE ?? 'streamtube',
  synchronize: true, // auto-create tables in test setup
}
```

**Test isolation:**
- Use `dataSource.query('DELETE FROM "table_name"')` to clean tables between tests
- Do NOT use `repository.delete({})` — throws `Empty criteria(s) are not allowed`
- Alternative: `repository.clear()` (truncates the table)
- For complex foreign key chains, delete in reverse dependency order or use `TRUNCATE ... CASCADE`
- Use `beforeEach` for cleanup to ensure each test starts with a clean state

**Entity setup:**
- Use `synchronize: true` in test DataSource to auto-create tables from entities
- For integration tests, import only the entities needed by the test — not all entities
- For E2E tests, import `AppModule` which includes all entities via their domain modules

---

## Object Storage — Real S3-Compatible Service (MinIO in Docker)

**Strategy:** Real storage via the Docker `minio` service (in `compose.yaml`). No filesystem adapter and no SDK mock: multipart uploads and presigned URLs — the core of the upload and streaming flows — only exist against a real S3 API. Production uses S3 with the same code.

**Setup:**
- Integration tests build the service directly: `const storage = await createTestStorageService()` (`src/test/storage-test-env.ts`). It reads the `STORAGE_*` variables from `.env` and ensures the bucket exists.
- E2E tests (and any test that compiles a module with `StorageService`) call `useInternalStorageEndpoint()` **before** creating the Nest module. Presigned URLs for clients are signed for `STORAGE_PUBLIC_ENDPOINT` (`http://localhost:9000`), which is not reachable from inside the container; the helper points it at the internal endpoint for the test process.

**Test isolation:**
- Use unique keys per test (`test/${randomUUID()}` or the video id) and delete the objects you created in `afterAll`.
- A test that creates its own bucket must delete it (see `storage.service.integration-spec.ts`).

**What to assert:**
- Dereference the presigned URL with `fetch` instead of inspecting its text: `PUT` the part and read the `ETag`; `GET` with a `Range` header and expect `206` + `Content-Range`; check `Content-Disposition` on download URLs.
- For service unit tests (`*.spec.ts`), mock `StorageService` at the boundary — it is an owned service with its own integration tests.

```typescript
describe('StorageService (integration)', () => {
  let storage: StorageService;

  beforeAll(async () => {
    storage = await createTestStorageService();
  });

  it('should serve a byte range with 206 Partial Content', async () => {
    const key = `test/${randomUUID()}`;
    await storage.putObject(key, Buffer.from('0123456789abcdef'), 'video/mp4');
    const url = await storage.presignGetObject(key, {
      expiresIn: 60,
      audience: 'internal',
    });

    const res = await fetch(url, { headers: { Range: 'bytes=0-9' } });

    expect(res.status).toBe(206);
  });
});
```

---

## Message Queue — Real BullMQ on Redis (Docker)

**Strategy:** Real broker via the Docker `redis` service (in `compose.yaml`), through `@nestjs/bullmq`. No queue mock in integration/E2E tests.

**Test isolation — the worker container is running:**
- The `video-worker` container consumes the `video-processing` queue under the default `QUEUE_PREFIX`. A test that asserts on an enqueued job must call `useIsolatedQueuePrefix()` (`src/test/queue-test-env.ts`) **before** the module/config is created, so its jobs live under a prefix no worker listens to.
- Clear the queue between tests with `emptyQueue(queue)`; never obliterate a queue under the default prefix.
- Compiling a module that contains a `@Processor` class starts a real worker — such module compilation tests also need `useIsolatedQueuePrefix()`.
- The single exception is `test/video-pipeline.e2e-spec.ts`, which keeps the default prefix on purpose so the real `video-worker` container (with FFmpeg) processes the job, and polls the API until the video is `ready`/`failed`.

**Publisher tests:** assert the job in the queue (name, data, `jobId`, options).

```typescript
const queue = app.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
const jobs = await queue.getJobs(['waiting']);
expect(jobs).toHaveLength(1);
expect(jobs[0].id).toBe(videoId);
expect(jobs[0].data).toEqual({ videoId });
```

**Consumer tests:** call the service the processor delegates to (`VideoProcessingService.process(videoId)`) against real DB + storage + FFmpeg, and unit-test the processor class for the retry/failure policy (`onFailed` with `attemptsMade` vs `opts.attempts`, `UnrecoverableError`).

**Media fixtures:** `generateSampleVideo()` (`src/test/video-fixture.ts`) produces a small MP4 with FFmpeg's synthetic sources. Do not commit binary video files.

---

## Email — Mailpit (Real SMTP Capture)

**Strategy:** Mailpit — a local SMTP server that captures all emails for inspection via its API. No emails are actually delivered.

**Setup:**
- Add Mailpit to `compose.yaml`:
```yaml
mailpit:
  image: axllent/mailpit
  ports:
    - "1025:1025"   # SMTP
    - "8025:8025"   # Web UI / API
```

**NestJS configuration:**
```typescript
// In mail module or config
{
  transport: {
    host: process.env.SMTP_HOST ?? 'localhost',
    port: Number(process.env.SMTP_PORT ?? 1025),
  },
}
```

**Integration test:**
```typescript
describe('MailService (integration)', () => {
  beforeEach(async () => {
    // Clear all captured emails via Mailpit API
    await fetch('http://localhost:8025/api/v1/messages', { method: 'DELETE' });
  });

  it('should send confirmation email', async () => {
    await mailService.sendConfirmation('user@test.com', 'token-123');

    // Query Mailpit API for captured emails
    const response = await fetch('http://localhost:8025/api/v1/messages');
    const data = await response.json();

    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].To[0].Address).toBe('user@test.com');
    expect(data.messages[0].Subject).toContain('confirm');
  });
});
```

**Key points:**
- Mailpit captures ALL emails — no mocking, no side effects
- Use Mailpit's REST API (`http://localhost:8025/api/v1/messages`) to inspect sent emails
- Clear captured emails in `beforeEach` to ensure test isolation
- Web UI at `http://localhost:8025` for manual debugging
- Tests the full SMTP transport path — if the SMTP config is wrong, the test fails
