---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-07T01:28:36-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-07T01:28:36-03:00"
  docs/project-plan.md: "2026-10-07T00:41:06-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-07T01:27:40-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-07T00:41:06-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-10-07T00:41:06-03:00"
  docs/phases/phase-02-auth/context.md: "2026-10-07T00:41:06-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-10-07T00:41:06-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver upload of videos up to 10GB without impact on API performance, with the video pre-registered as a draft when the upload starts, automatic background processing after upload (duration and metadata extraction plus a thumbnail generated from a frame), a unique URL per video, playback via streaming and download — backed by an object storage service for videos and thumbnails, a background processing queue and a video worker running in Docker Compose.

---

## Step Implementations

### SI-03.1 — Baseline Repair: Lint and Re-runnable Migration Test

**Description:** Bring the Definition of Done checks to green on the code inherited from Phases 01–02 before any Phase 03 change, so every following SI can prove its own Definition of Done (per `validation.md` → DG-2, user choice (a)). Delivered as a separate commit.

**Technical actions:**

1. Update `eslint.config.mjs` — add an override scoped to test files (`**/*.spec.ts`, `**/*.integration-spec.ts`, `test/**/*.ts`, `src/test/**/*.ts`) turning off `@typescript-eslint/no-unsafe-assignment`, `no-unsafe-member-access`, `no-unsafe-return`, `no-unsafe-call`, `no-unsafe-argument`, `unbound-method` and `require-await` (the rule families behind 141 of the 143 test-file errors measured in DG-2; `no-explicit-any` is already off project-wide)
2. Fix the remaining test-file errors by hand (`@typescript-eslint/no-unused-vars`, 2 occurrences) without changing test behavior
3. Fix the 7 errors in production/support code: type the PostgreSQL driver error in `src/channels/channels.service.ts` (`isPgUniqueViolationOnColumn`) instead of casting to `any`, and replace the `Function` type in `src/test/create-test-data-source.ts` with TypeORM's `EntityTarget`-compatible class type
4. Update `src/database/migrations.integration-spec.ts` — in `beforeAll`, also drop the enum types created by the migrations (`DROP TYPE IF EXISTS "verification_tokens_type_enum"`) so the spec passes against an already-migrated database

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Migration runner | Integration: applies all migrations on a database that was already migrated, reverts the last one, restores the schema | `src/database/migrations.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `npm run lint` exits with code 0 inside the `nestjs-api` container
- `npm test -- --runInBand` passes when executed twice in a row against the same database
- `npm run test:e2e` passes after the unit/integration suite has run (the shared database keeps its tables)
- `npx tsc --noEmit` still exits with code 0

---

### SI-03.2 — Infra: Compose Services, Image, Dependencies and Config Namespaces

**Description:** Add the object storage and queue broker services to Docker Compose, put FFmpeg in the development image, install the Phase 03 libraries, and create the `storage` and `queue` config namespaces following the `registerAs` + Joi pattern from Phase 01.

**Technical actions:**

1. Update `Dockerfile.dev` — add `ffmpeg` to the `apt install` line (provides `ffmpeg` and `ffprobe` for the worker and for tests run in `nestjs-api`) (per `phase-03-videos/TD-04`)
2. Update `compose.yaml` — add service `redis` (image `redis:7-alpine`, healthcheck `redis-cli ping`) and service `minio` (S3-compatible storage, API on port 9000, console on port 9001, named volume, healthcheck); make `nestjs-api` depend on both being healthy (per `phase-03-videos/TD-01`, `phase-03-videos/TD-03`)
3. Install production dependencies in `nestjs-project`: `@nestjs/bullmq@^11.0.5`, `bullmq@^6.3.x`, `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-03`; see `library-refs.md` for the CommonJS pin of `@nestjs/bullmq`)
4. Create `src/config/storage.config.ts` — `registerAs('storage', ...)` reading `STORAGE_ENDPOINT`, `STORAGE_PUBLIC_ENDPOINT`, `STORAGE_REGION`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_BUCKET` (per `phase-03-videos/TD-03`); create `src/config/queue.config.ts` — `registerAs('queue', ...)` reading `REDIS_HOST` (default `'redis'`), `REDIS_PORT` (default `6379`), `QUEUE_PREFIX` (default `'streamtube'`); load both in `AppModule`'s `ConfigModule.forRoot`
5. Update `src/config/env.validation.ts` and `.env.example` — add the keys above to the Joi schema (`STORAGE_ACCESS_KEY` and `STORAGE_SECRET_KEY` required; the others with Compose-compatible defaults: `STORAGE_ENDPOINT=http://minio:9000`, `STORAGE_PUBLIC_ENDPOINT=http://localhost:9000`, `STORAGE_REGION=us-east-1`, `STORAGE_BUCKET=streamtube`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` | Integration: rejects a missing `STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY`, applies the storage and queue defaults | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** SI-03.1 — the baseline must be green before new code is added

**Acceptance criteria:**

- `docker compose up -d` starts `redis` and `minio` alongside `nestjs-api`, `db` and `mailpit`, and both report `healthy` in `docker compose ps`
- `docker compose exec nestjs-api ffprobe -version` and `ffmpeg -version` exit with code 0
- Starting the application without `STORAGE_ACCESS_KEY` causes a Joi validation error at bootstrap
- The existing E2E test `GET /` still returns 200 with the new environment variables provided

---

### SI-03.3 — Storage Module (S3-Compatible Object Storage)

**Description:** Create the storage module that wraps the S3 client for every object operation the phase needs — bucket bootstrap, multipart upload lifecycle, presigned URLs, and simple object reads/writes — so the videos module and the worker never talk to the SDK directly.

**Technical actions:**

1. Create `src/storage/storage.module.ts` — `StorageModule` providing and exporting `StorageService`; the service builds two `S3Client` instances from `storageConfig` with `forcePathStyle: true`: one bound to `STORAGE_ENDPOINT` (operations and internal presigning) and one bound to `STORAGE_PUBLIC_ENDPOINT` (presigning URLs handed to clients) (per `phase-03-videos/TD-03`)
2. Create `src/storage/storage.service.ts` — bucket bootstrap on module init (`HeadBucketCommand`, `CreateBucketCommand` when missing) (per `phase-03-videos/TD-03`); multipart methods `createMultipartUpload(key, contentType)`, `presignUploadPart(key, uploadId, partNumber, expiresIn)`, `listParts(key, uploadId)` (following pagination), `completeMultipartUpload(key, uploadId, parts)`, `abortMultipartUpload(key, uploadId)` (per `phase-03-videos/TD-02`)
3. Add object methods to `StorageService` — `presignGetObject(key, { expiresIn, audience: 'public' | 'internal', responseContentDisposition?, responseContentType? })` (per `phase-03-videos/TD-06`, `phase-03-videos/TD-04`), `putObject(key, body, contentType)`, `headObject(key)` returning the size, `deleteObject(key)`
4. Create `src/storage/storage.constants.ts` — key builders `videoOriginalKey(videoId)` → `videos/{videoId}/original` and `videoThumbnailKey(videoId)` → `videos/{videoId}/thumbnail.jpg` (per `phase-03-videos/TD-03`)
5. Create `src/test/storage-test-env.ts` — test helper that points `STORAGE_PUBLIC_ENDPOINT` at the internal endpoint for the current test process, so presigned URLs are reachable from inside the container (per `phase-03-videos/TD-03` revision — tests run against the real storage)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration (real MinIO): bucket bootstrap is idempotent; a two-part multipart upload through presigned part URLs is listed and completed into one object of the summed size; abort discards the upload; `putObject`/`headObject`/`deleteObject`; a presigned GET answers a `Range` request with `206` and honours `responseContentDisposition` | `src/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Unit: compilation with `storageConfig` | `src/storage/storage.module.spec.ts` |
| Storage key builders | Unit: key format | `src/storage/storage.constants.spec.ts` |

**Dependencies:** SI-03.2 — MinIO service, SDK packages and `storage` config

**Acceptance criteria:**

- Bootstrapping the module against an empty MinIO creates the configured bucket; bootstrapping again succeeds without error
- Bytes sent with HTTP `PUT` to a presigned part URL appear in the part listing with their `ETag` and size
- Completing a multipart upload with the listed parts produces a single object whose size is the sum of the parts
- An HTTP `GET` with `Range: bytes=0-9` on a presigned object URL returns `206` with exactly 10 bytes
- A presigned URL issued for the `public` audience uses the host of `STORAGE_PUBLIC_ENDPOINT`; one issued for the `internal` audience uses the host of `STORAGE_ENDPOINT`

---

### SI-03.4 — Queue Module (BullMQ Connection)

**Description:** Create the shared queue module that configures the BullMQ root connection from the `queue` config namespace, so the API (producer) and the worker (consumer) connect to the same broker with the same key prefix.

**Technical actions:**

1. Create `src/queue/queue.module.ts` — `QueueModule` importing `BullModule.forRootAsync({ inject: [queueConfig.KEY], useFactory })` returning `{ connection: { host, port }, prefix }` (per `phase-03-videos/TD-01`); export `BullModule`
2. Create `src/queue/queue.constants.ts` — `VIDEO_PROCESSING_QUEUE = 'video-processing'`, `PROCESS_VIDEO_JOB = 'process-video'`, and the job options `VIDEO_PROCESSING_JOB_OPTIONS = { attempts: 3, backoff: { type: 'exponential', delay: 5000 } }` (per `### Events/Messages` → process-video, `phase-03-videos/TD-07`)
3. Create `src/test/queue-test-env.ts` — test helper that sets a dedicated `QUEUE_PREFIX` for the current test process, isolating test queues from the running worker container, plus a helper to obliterate a queue between tests

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueModule` | Integration (real Redis): compiles with `queueConfig`; a job added to a registered queue is readable back with its data under the configured prefix | `src/queue/queue.module.integration-spec.ts` |

**Dependencies:** SI-03.2 — Redis service, BullMQ packages and `queue` config

**Acceptance criteria:**

- A job added through a queue registered under `QueueModule` is stored in the `redis` Compose service under the configured `QUEUE_PREFIX`
- Two processes configured with different `QUEUE_PREFIX` values do not see each other's jobs

---

### SI-03.5 — Video Entity and Migration

**Description:** Create the `Video` entity linked to the channel, the inverse relation on `Channel`, the migration that creates the `videos` table, and the `VideosModule` skeleton that registers the entity.

**Technical actions:**

1. Create `src/videos/entities/video.entity.ts` — `@Entity('videos')` with every field of `### Data Model` → Video: application-assigned uuid `id` (`@PrimaryColumn('uuid')`), `status` as PostgreSQL enum backed by a `VideoStatus` TypeScript enum, `size` as `bigint` with a number transformer, `upload_id` with `select: false`, `metadata` as `jsonb` typed by a `VideoMetadata` interface, `@ManyToOne(() => Channel, (channel) => channel.videos, { onDelete: 'CASCADE' })` with `@JoinColumn({ name: 'channel_id' })`, index on `channel_id` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-07`)
2. Update `src/channels/entities/channel.entity.ts` — add `@OneToMany(() => Video, (video) => video.channel) videos: Video[]` (per `### Data Model` → Channel (modified))
3. Create `src/videos/videos.module.ts` — `VideosModule` with `TypeOrmModule.forFeature([Video])`; register it in `AppModule`
4. Generate the migration via `npm run migration:generate -- src/database/migrations/CreateVideos` and review the SQL (table, enum type, unique `public_id`, FK with `ON DELETE CASCADE`, index on `channel_id`)
5. Update `src/test/create-test-data-source.ts` — register the full entity graph (including `Video`) in every test `DataSource` (TypeORM requires every entity reachable through relations) and delete from `videos` first in `cleanAllTables`; update `src/database/migrations.integration-spec.ts` to import the new migration, manage the `videos` table and drop `videos_status_enum`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: unique `public_id`, `status` defaults to `draft` and rejects unknown values, `upload_id` excluded from default selects, `size` round-trips a 10GB value as a number, deleting the channel cascades, nullable processing fields | `src/videos/entities/video.entity.integration-spec.ts` |
| Migration runner | Integration: applies three migrations creating five tables; reverting the last one removes `videos` | `src/database/migrations.integration-spec.ts` |
| `VideosModule` | Unit: compilation with `TypeOrmModule.forFeature([Video])` | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.1 — re-runnable migration spec and green lint

**Acceptance criteria:**

- `npm run migration:run` creates the `videos` table with every column, constraint and index of `### Data Model` → Video
- Inserting two videos with the same `public_id` fails with a unique constraint violation
- A video inserted without `status` is stored as `draft`; a status outside `draft | processing | ready | failed` is rejected by the database
- Deleting a channel deletes its videos
- `npm run migration:revert` drops the `videos` table and its enum type, leaving the Phase 02 tables intact

---

### SI-03.6 — Upload Initiation with Draft Pre-registration

**Description:** Implement `POST /videos`: validate the declared file, pre-register the video as a draft owned by the caller's channel with a unique URL identifier, and open the multipart upload in the storage.

**Technical actions:**

1. Update `src/channels/channels.service.ts` — add `findByUserId(userId): Promise<Channel>` throwing the new `ChannelNotFoundException` (`CHANNEL_NOT_FOUND`, 404) when absent (per `phase-03-videos/TD-02` revision — draft ownership); add the Phase 03 domain exceptions of `### Error Catalog` to `src/common/exceptions/domain.exception.ts`
2. Create `src/videos/video-public-id.util.ts` — `generateVideoPublicId()` producing 11 characters from the URL-safe alphabet with `crypto.randomBytes` (per `phase-03-videos/TD-05`); create `src/videos/videos.constants.ts` with `MAX_VIDEO_SIZE_BYTES` (10737418240), `UPLOAD_PART_SIZE_BYTES` (16777216), `PRESIGNED_URL_TTL_SECONDS` (3600), `MAX_PART_URLS_PER_REQUEST` (100) (per `phase-03-videos/TD-02`)
3. Create `src/videos/dto/initiate-upload.dto.ts` — `InitiateUploadDto` per `### API Contracts` → Validation Rules — Upload (`class-validator`, per `phase-02-auth/TD-06`), and the response DTOs with `@ApiProperty`
4. Create `src/videos/videos.service.ts` — `initiateUpload(userId, dto)`: resolve the channel, generate `id` and `public_id` (pre-check + unique-violation retry, per `phase-03-videos/TD-05`), call `StorageService.createMultipartUpload`, insert the video as `draft` with `storage_key` and `upload_id`; if the insert fails, abort the multipart upload and rethrow (compensation)
5. Create `src/videos/videos.controller.ts` — `@Controller('videos')`, `@SkipThrottle()`, `POST /videos` returning 201 per `### API Contracts` → POST /videos, with the OpenAPI decorators required by the controller rules (per `openapi-docs-nestjs/TD-01`); wire `StorageModule` and `ChannelsModule` into `VideosModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `generateVideoPublicId` | Unit: length 11, URL-safe alphabet only, no repeats across a large sample | `src/videos/video-public-id.util.spec.ts` |
| `VideosService.initiateUpload` | Unit: title defaults to the file name without extension; `part_count` computed from `size`; regenerates `public_id` on collision; aborts the multipart upload when the insert fails (mock repository and storage) | `src/videos/videos.service.spec.ts` |
| `VideosService.initiateUpload` | Integration (real DB + MinIO): persists the draft with `storage_key`, `upload_id` and the caller's `channel_id`; the multipart upload exists in the storage | `src/videos/videos.service.integration-spec.ts` |
| `ChannelsService.findByUserId` | Integration: returns the user's channel; throws `ChannelNotFoundException` for a user without channel | `src/channels/channels.service.integration-spec.ts` |
| `POST /videos` | E2E: 201 with the contract shape and a `draft` row in the database; 400 on invalid body (validation wiring); 401 without token | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.3 — storage multipart API; SI-03.5 — `Video` entity and `VideosModule`

**Acceptance criteria:**

- `POST /videos` with `{ filename: "clip.mp4", content_type: "video/mp4", size: 1048576 }` returns `201` with `status: "draft"`, an 11-character `public_id`, `title: "clip"` and `upload: { part_size: 16777216, part_count: 1 }`
- `POST /videos` with `size: 10737418240` returns `201` with `upload.part_count: 640`; with `size: 10737418241` returns `400` with `error: "VALIDATION_ERROR"`
- `POST /videos` with `content_type: "application/pdf"` returns `400` with `error: "VALIDATION_ERROR"`
- `POST /videos` without an `Authorization` header returns `401`
- After a successful call, the `videos` table has one row with `status = 'draft'` whose `channel_id` is the caller's channel
- Two successive calls return different `public_id` values

---

### SI-03.7 — Upload Parts: Presigned URLs, Resume, State and Abort

**Description:** Implement the owner endpoints that drive an upload in progress: issuing presigned part URLs, listing parts already received (resume), reading the upload/processing state, and aborting the upload.

**Technical actions:**

1. Add `VideosService.getOwnedVideo(userId, videoId)` — loads the video (selecting `upload_id`), throws `VideoNotFoundException` when absent and `VideoNotOwnedException` when the caller's channel differs from `channel_id` (per `### Authorization Matrix`); add `getUploadState(userId, videoId)` returning the shape of `### API Contracts` → GET /videos/:id/upload
2. Add `VideosService.createPartUploadUrls(userId, videoId, partNumbers)` — requires status `draft` (`VideoUploadNotInProgressException`), rejects part numbers above `part_count` (`InvalidUploadPartsException`), presigns each part for the `public` audience with `PRESIGNED_URL_TTL_SECONDS` (per `phase-03-videos/TD-02`)
3. Add `VideosService.listUploadedParts(userId, videoId)` — requires status `draft`, returns the storage part listing (per `phase-03-videos/TD-02`); add `abortUpload(userId, videoId)` — requires status `draft`, aborts the multipart upload and deletes the draft row (per `phase-03-videos/TD-07`)
4. Create `src/videos/dto/create-part-urls.dto.ts` — `CreatePartUrlsDto` per `### API Contracts` → Validation Rules — Upload, plus response DTOs
5. Add to `VideosController` the handlers `GET /videos/:id/upload`, `POST /videos/:id/upload/part-urls` (200), `GET /videos/:id/upload/parts`, `DELETE /videos/:id/upload` (204), each with `ParseUUIDPipe` on `:id` and OpenAPI decorators

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` owner operations | Unit: ownership and status branches for each method; part number above `part_count` rejected (mock repository, storage, channels) | `src/videos/videos.service.spec.ts` |
| `VideosService` owner operations | Integration (real DB + MinIO): a part uploaded through an issued URL appears in `listUploadedParts`; `abortUpload` removes the row and the multipart upload | `src/videos/videos.service.integration-spec.ts` |
| Owner upload endpoints | E2E: 200 with presigned URLs usable for an HTTP `PUT`; parts listing reflects the uploaded part; 204 on abort and the draft is gone; 403 for another user; 404 for an unknown id; 400 for a non-uuid id and an invalid body | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.6 — `VideosService`, controller and draft creation

**Acceptance criteria:**

- `POST /videos/:id/upload/part-urls` with `{ part_numbers: [1] }` on the caller's draft returns `200` with one `{ part_number: 1, url }` and `expires_in: 3600`; an HTTP `PUT` of the file bytes to that `url` returns `200` with an `ETag` header
- `GET /videos/:id/upload/parts` after that `PUT` returns `200` with one part whose `part_number` is `1` and whose `size` is the number of bytes sent
- `POST /videos/:id/upload/part-urls` with a part number greater than `part_count` returns `400` with `error: "INVALID_UPLOAD_PARTS"`; with 101 part numbers returns `400` with `error: "VALIDATION_ERROR"`
- `GET /videos/:id/upload` returns `200` with `status: "draft"` and `failure_reason: null` for the owner
- Any owner endpoint called by a different authenticated user returns `403` with `error: "VIDEO_NOT_OWNED"`; with an unknown uuid returns `404` with `error: "VIDEO_NOT_FOUND"`; with a non-uuid `:id` returns `400`
- `DELETE /videos/:id/upload` on a draft returns `204`; a following `GET /videos/:id/upload` returns `404`

---

### SI-03.8 — Upload Completion and Processing Job Publishing

**Description:** Implement `POST /videos/:id/upload/complete`: finish the multipart upload in the storage, confirm the stored size, move the video to `processing` and publish the `process-video` job — the single trigger for background processing.

**Technical actions:**

1. Update `src/videos/videos.module.ts` — import `QueueModule` and `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })` (producer only; no processor is registered in the API) (per `phase-03-videos/TD-01`, `phase-03-videos/TD-04`)
2. Create `src/videos/dto/complete-upload.dto.ts` — `CompleteUploadDto` with nested `parts` validation per `### API Contracts` → Validation Rules — Upload, plus the response DTO
3. Add `VideosService.completeUpload(userId, videoId, parts)` — requires status `draft`; when `upload_id` is still set, call `StorageService.completeMultipartUpload` (storage rejection → `InvalidUploadPartsException`) and clear `upload_id`; read the stored size with `headObject` and, when it differs from `size`, delete the object and the draft and throw `UploadSizeMismatchException` (per `### Error Catalog`)
4. In the same method, move the video to `processing` with a conditional update (`WHERE status = 'draft'`) and publish `process-video` with `{ videoId }`, `jobId` = video `id` and `VIDEO_PROCESSING_JOB_OPTIONS`; if publishing fails, revert the status to `draft` and rethrow (compensation — the call can be retried because `upload_id` is already cleared) (per `### Events/Messages` → process-video, `phase-03-videos/TD-07`)
5. Add the handler `POST /videos/:id/upload/complete` (200) to `VideosController` with OpenAPI decorators

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: status guard; storage rejection mapped to `InvalidUploadPartsException`; size mismatch discards object and draft; publish failure reverts to `draft`; retry with cleared `upload_id` skips the storage completion (mock repository, storage, queue) | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration (real DB + MinIO + Redis): the object exists with the declared size, the row is `processing` with `upload_id` null, and exactly one `process-video` job with `{ videoId }` and `jobId` = video id is waiting in the queue | `src/videos/videos.service.integration-spec.ts` |
| `POST /videos/:id/upload/complete` | E2E: 200 with `status: "processing"`; 409 on a second completion; 400 `INVALID_UPLOAD_PARTS` with a wrong ETag; 400 `UPLOAD_SIZE_MISMATCH` when fewer bytes than declared were uploaded; 400 on an invalid body | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.4 — queue module and constants; SI-03.7 — part upload and ownership checks

**Acceptance criteria:**

- `POST /videos/:id/upload/complete` with the `{ part_number, etag }` pairs returned by the storage returns `200` with `status: "processing"`, and `GET /videos/:id/upload` then reports `status: "processing"`
- After a successful completion, one `process-video` job whose payload is `{ videoId: <id> }` exists in the `video-processing` queue
- Calling the endpoint again for the same video returns `409` with `error: "VIDEO_UPLOAD_NOT_IN_PROGRESS"` and no second job is created
- Completion with an `etag` the storage does not recognize returns `400` with `error: "INVALID_UPLOAD_PARTS"` and the video stays `draft`
- Completion of an upload whose stored size differs from the declared `size` returns `400` with `error: "UPLOAD_SIZE_MISMATCH"`, and `GET /videos/:id/upload` then returns `404`
- Part URLs, part listing and abort on a `processing` video return `409` with `error: "VIDEO_UPLOAD_NOT_IN_PROGRESS"`

---

### SI-03.9 — Media Inspection with FFmpeg

**Description:** Create the service that wraps the FFmpeg binaries: `ffprobe` to extract duration and metadata and `ffmpeg` to capture one thumbnail frame, both reading the source from a URL so the file is never downloaded in full.

**Technical actions:**

1. Create `src/videos/processing/ffprobe.parser.ts` — pure function `parseFfprobeOutput(json)` mapping `ffprobe -show_format -show_streams` output to `{ duration, metadata: { width, height, video_codec, audio_codec, bitrate, frame_rate, container_format } }`; throws `InvalidMediaError` when there is no video stream or no positive duration (per `phase-03-videos/TD-04`)
2. Create `src/videos/processing/media-inspector.service.ts` — `MediaInspectorService.probe(inputUrl)` running `ffprobe` through `execFile` (JSON output, timeout) and mapping a non-zero exit to `InvalidMediaError` (per `phase-03-videos/TD-04`)
3. Add `MediaInspectorService.captureThumbnail(inputUrl, durationSeconds, outputPath)` — runs `ffmpeg` seeking to `min(duration * 0.1, 10)` seconds, one frame, scaled to a maximum width of 1280px, JPEG output (per `phase-03-videos/TD-04`); export `thumbnailTimestamp(duration)` as a pure helper
4. Create `src/test/video-fixture.ts` — test helper that generates a short MP4 (video + audio) and a video-only MP4 with `ffmpeg`'s synthetic sources into a temp directory (no binary fixture committed)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `parseFfprobeOutput`, `thumbnailTimestamp` | Unit: full mapping; missing audio stream → `audio_codec: null`; fractional frame rate; no video stream → `InvalidMediaError`; timestamp is 10% capped at 10s | `src/videos/processing/ffprobe.parser.spec.ts` |
| `MediaInspectorService` | Integration (real `ffprobe`/`ffmpeg`): probing a generated MP4 returns its duration, dimensions and codecs; probing a non-media file throws `InvalidMediaError`; `captureThumbnail` writes a JPEG no wider than 1280px; works with an HTTP URL input served by MinIO | `src/videos/processing/media-inspector.service.integration-spec.ts` |

**Dependencies:** SI-03.3 — storage (URL input in the integration test); SI-03.2 — FFmpeg in the image

**Acceptance criteria:**

- Probing a generated 2-second 320×240 H.264/AAC MP4 returns `duration` ≈ 2, `width: 320`, `height: 240`, `video_codec: "h264"`, `audio_codec: "aac"` and a `container_format` containing `mp4`
- Probing a video-only file returns `audio_codec: null`
- Probing a text file fails with `InvalidMediaError`
- The captured thumbnail is a valid JPEG image
- Probing through a presigned storage URL returns the same values as probing the local file

---

### SI-03.10 — Video Processing Service, Processor and Failure Policy

**Description:** Implement the consumer side of `process-video`: the service that turns a `processing` video into `ready` (metadata + thumbnail) or `failed`, and the BullMQ processor that delegates to it and applies the retry/failure policy.

**Technical actions:**

1. Create `src/videos/processing/video-processing.service.ts` — `process(videoId)`: load the video; return without work when it is missing or not `processing` (idempotency, per `### Events/Messages`); presign the object for the `internal` audience, `probe`, `captureThumbnail` into a temp file, `putObject` to `videoThumbnailKey(videoId)`, remove the temp file, then update `status = 'ready'`, `duration`, `metadata`, `thumbnail_key`, `processed_at` with a conditional update (`WHERE status = 'processing'`) (per `phase-03-videos/TD-04`)
2. Add `VideoProcessingService.markFailed(videoId, reason)` — conditional update to `status = 'failed'` with `failure_reason` (only from `processing`) (per `phase-03-videos/TD-07`)
3. Create `src/videos/processing/video.processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE)` extending `WorkerHost`; `process(job)` calls `VideoProcessingService.process(job.data.videoId)` and rethrows `InvalidMediaError` as BullMQ's `UnrecoverableError`; `@OnWorkerEvent('failed')` calls `markFailed` only on the final failure (`UnrecoverableError`, or `job.attemptsMade >= job.opts.attempts`), logging and not rethrowing inside the event handler (background-task rule) (per `phase-03-videos/TD-01`, `phase-03-videos/TD-07`)
4. Create `src/videos/processing/video-processing.module.ts` — `VideoProcessingModule` importing `TypeOrmModule.forFeature([Video])`, `StorageModule`, `QueueModule`, `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`; providers `MediaInspectorService`, `VideoProcessingService`, `VideoProcessor` (per `phase-03-videos/TD-04`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingService` | Unit: skips a missing or non-`processing` video; propagates probe errors without touching the status; removes the temp file on success and on failure (mock repository, storage, inspector) | `src/videos/processing/video-processing.service.spec.ts` |
| `VideoProcessingService` | Integration (real DB + MinIO + FFmpeg): a `processing` video with a real MP4 object becomes `ready` with duration, metadata, `processed_at` and a JPEG stored at the thumbnail key; a non-media object raises `InvalidMediaError`; `markFailed` sets `failed` + reason and does not overwrite a `ready` video | `src/videos/processing/video-processing.service.integration-spec.ts` |
| `VideoProcessor` | Unit: delegates `job.data.videoId`; maps `InvalidMediaError` to `UnrecoverableError`; `failed` handler marks failed on the last attempt and on `UnrecoverableError`, and does nothing on an attempt that will be retried | `src/videos/processing/video.processor.spec.ts` |
| `VideoProcessingModule` | Unit: compilation with the queue and storage wiring | `src/videos/processing/video-processing.module.spec.ts` |

**Dependencies:** SI-03.4 — queue; SI-03.5 — `Video` entity; SI-03.9 — media inspection

**Acceptance criteria:**

- Processing a `processing` video whose object is a valid MP4 — the row becomes `ready` with `duration`, `metadata` (all seven keys) and `processed_at` set, and a JPEG object exists at `videos/{videoId}/thumbnail.jpg`
- Processing a video whose object is not a media file — the job fails without retry and the row becomes `failed` with a non-empty `failure_reason`; the uploaded object still exists
- A transient error on an attempt that still has retries left leaves the row in `processing`
- A job for a video that is already `ready` (or was deleted) completes without changing any row
- `markFailed` on a `ready` video leaves it `ready`

---

### SI-03.11 — Video Worker Entrypoint and Compose Service

**Description:** Give the consumer its own process and container: a worker module and entrypoint without HTTP listener, the npm scripts to run it, and the `video-worker` service in Docker Compose.

**Technical actions:**

1. Create `src/database/database.module.ts` — `DatabaseModule` holding the existing `TypeOrmModule.forRootAsync` block (moved from `AppModule`, unchanged options) so the API and the worker share one database configuration; `AppModule` imports it
2. Create `src/worker.module.ts` — `WorkerModule` importing `ConfigModule.forRoot` (global, same `load` list and Joi schema as `AppModule`), `DatabaseModule`, `UsersModule` and `ChannelsModule` (entity graph of `Video`), and `VideoProcessingModule` (per `phase-03-videos/TD-04`)
3. Create `src/worker.ts` — `NestFactory.createApplicationContext(WorkerModule)` with `enableShutdownHooks()`; add scripts `start:worker` (`nest start --entryFile worker`) and `start:worker:dev` (`nest start --entryFile worker --watch`) to `package.json` (per `phase-03-videos/TD-04`)
4. Update `compose.yaml` — add service `video-worker` built from the same `Dockerfile.dev`, same bind mount, `depends_on` `db`, `redis` and `minio` healthy, command that waits for `node_modules` to be installed and then runs `npm run start:worker:dev`, `restart: unless-stopped` (per `phase-03-videos/TD-04`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `WorkerModule` | Unit: compilation — the processor, storage and repository resolve without the HTTP modules | `src/worker.module.spec.ts` |
| `DatabaseModule` | Covered by the existing `AppModule`-based E2E suites (`test/app.e2e-spec.ts`) | `test/app.e2e-spec.ts` |

**Dependencies:** SI-03.10 — processing module and processor

**Acceptance criteria:**

- `docker compose up -d` starts a `video-worker` container that stays running and logs that the Nest application context started
- The `video-worker` container exposes no HTTP port and the `nestjs-api` container runs no queue consumer
- Stopping `video-worker` leaves `process-video` jobs waiting in the queue; starting it again consumes them
- The existing E2E suites still pass with `AppModule` importing `DatabaseModule`

---

### SI-03.12 — Public Video Details, Streaming, Download and Thumbnail

**Description:** Implement the public endpoints addressed by the video's unique URL identifier: details, and the three redirects to presigned storage URLs (playback with range support, download as attachment, thumbnail).

**Technical actions:**

1. Add `VideosService.findReadyByPublicId(publicId)` — loads the video with its channel by `public_id`; throws `VideoNotFoundException` when absent or not `ready` (per `phase-03-videos/TD-06` revision — access policy); add `getPublicDetails(publicId)` returning the shape of `### API Contracts` → GET /videos/:publicId
2. Add `VideosService.getStreamUrl(publicId)`, `getDownloadUrl(publicId)` and `getThumbnailUrl(publicId)` — presigned GET for the `public` audience with `PRESIGNED_URL_TTL_SECONDS`; stream sets `responseContentType` to the video's `content_type`; download sets `responseContentDisposition` to `attachment` with a sanitized `original_filename` (per `phase-03-videos/TD-06`)
3. Create `src/videos/dto/video-details.dto.ts` — response DTO for the public details with `@ApiProperty` on every field
4. Add to `VideosController` the `@Public()` handlers `GET /videos/:publicId`, `GET /videos/:publicId/stream`, `GET /videos/:publicId/download`, `GET /videos/:publicId/thumbnail` — the three redirects answer `302` with the `Location` header; OpenAPI decorators without `@ApiBearerAuth`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` public operations | Unit: not-found for unknown and for each non-`ready` status; download disposition built from `original_filename` with unsafe characters removed (mock repository and storage) | `src/videos/videos.service.spec.ts` |
| `VideosService` public operations | Integration (real DB + MinIO): the stream URL answers a `Range` request with `206`; the download URL answers with `Content-Disposition: attachment` | `src/videos/videos.service.integration-spec.ts` |
| Public video endpoints | E2E: details 200 without token for a `ready` video; 404 for `draft`, `processing`, `failed` and unknown ids; stream/download/thumbnail answer 302 with a `Location` on the storage host | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.8 — completed uploads; SI-03.10 — processing result fields (`ready`, `thumbnail_key`, `metadata`)

**Acceptance criteria:**

- `GET /videos/:publicId` without an `Authorization` header returns `200` for a `ready` video with `public_id`, `title`, `duration`, `metadata`, `size`, `channel { nickname, name }` and `created_at`, and no storage key or upload id in the body
- `GET /videos/:publicId` returns `404` with `error: "VIDEO_NOT_FOUND"` for an unknown `public_id` and for a video in `draft`, `processing` or `failed`
- `GET /videos/:publicId/stream` returns `302`; requesting its `Location` with `Range: bytes=0-99` returns `206` with a `Content-Range` header and 100 bytes
- `GET /videos/:publicId/download` returns `302`; requesting its `Location` returns `200` with `Content-Disposition` starting with `attachment` and containing the original file name
- `GET /videos/:publicId/thumbnail` returns `302`; requesting its `Location` returns `200` with `Content-Type: image/jpeg`
- Two different videos never share a `public_id`, so each URL resolves to exactly one video

---

### SI-03.13 — End-to-End Pipeline Through the Real Worker and Contract Export

**Description:** Prove the phase as a whole against the running infrastructure — API, storage, queue and the `video-worker` container — and refresh the committed API contract and request collection.

**Technical actions:**

1. Create `test/video-pipeline.e2e-spec.ts` — using the default `QUEUE_PREFIX` (so the `video-worker` container consumes the job): register/confirm/login a user, initiate, upload a generated MP4 through the presigned part URL, complete, poll `GET /videos/:id/upload` until `ready`, then exercise details, stream (`206`), download and thumbnail; a second scenario uploads a non-media file and polls until `failed`
2. Regenerate `openapi.json` with `npm run openapi:export` and sync it to the frontend with `scripts/sync-openapi.sh` (per `openapi-docs-nestjs/TD-02`)
3. Update `api.http` — add the video requests (initiate, part URLs, parts, complete, state, abort, details, stream, download, thumbnail)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Upload → processing → playback pipeline | E2E (real API + MinIO + Redis + `video-worker` container): happy path to `ready` with streaming/download/thumbnail; invalid media ends in `failed` with a reason | `test/video-pipeline.e2e-spec.ts` |
| OpenAPI export | Integration: exported document still valid and now contains the `/videos` paths | `src/openapi-export.integration-spec.ts` |

**Dependencies:** SI-03.11 — worker container; SI-03.12 — public endpoints

**Acceptance criteria:**

- With `docker compose up -d` running, a video uploaded through the API reaches `status: "ready"` without any manual step, with `duration` and a thumbnail produced by the `video-worker` container
- A file that is not a video, uploaded with a `video/*` content type, reaches `status: "failed"` with a non-empty `failure_reason`
- `openapi.json` lists every endpoint of `### API Contracts` under the `videos` tag
- `npm test -- --runInBand` and `npm run test:e2e` both pass in full

---

### SI-03.14 — AI Foundation and Documentation Update

**Description:** Update the AI-facing documentation so it describes the code as it now exists: the videos module, endpoints, queue/worker and storage.

**Technical actions:**

1. Update `CLAUDE.md` (repository root) — add the videos section (module, upload flow, endpoints, queue/worker, storage), set the Message Queue container to its chosen technology, and correct the Repository Structure entry for `next-frontend/`
2. Update `nestjs-project/CLAUDE.md` — services list (`redis`, `minio`, `video-worker`), readiness checks, worker commands, new environment variables, the videos architecture section and the test isolation helpers (`QUEUE_PREFIX`, storage endpoint)
3. Update `.claude/skills/testing-guide-nestjs-project/references/external-systems.md` — Object Storage strategy becomes "real S3-compatible service (MinIO) in Docker" and the Message Queue section names BullMQ on Redis (per `phase-03-videos/TD-03` revision — testing strategy, `phase-03-videos/TD-01`)
4. Update `docs/diagrams/software-arch.mermaid` — Message Queue technology from "TBD" to "BullMQ (Redis)" (per `phase-03-videos/TD-01`); update `nestjs-project/README.md` setup notes for the new services

**Tests:** _(empty — documentation only; verified by the full-suite Deliverables)_

**Dependencies:** SI-03.13 — final shape of the code and infrastructure

**Acceptance criteria:**

- Every file path, endpoint, service name, command and environment variable cited in the two `CLAUDE.md` files exists in the repository
- The testing guide no longer prescribes a filesystem storage adapter
- The architecture diagram no longer shows the queue as "TBD"

---

## Technical Specifications

### Data Model

#### Video

Table `videos`. Written by the API (creation, upload completion, abort) and by the worker (processing result) — the single writer of each status transition is listed in `### Events/Messages` → _Status lifecycle_.

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| id | uuid | PK | Generated by the application before insert, because `storage_key` embeds it |
| channel_id | uuid | FK → channels.id, not null, `ON DELETE CASCADE` | Owning channel (per `phase-03-videos/TD-02` revision — draft ownership) |
| public_id | varchar(11) | unique, not null | Unique URL identifier: 11 characters from the URL-safe alphabet `A-Z a-z 0-9 _ -` (per `phase-03-videos/TD-05`) |
| title | varchar(255) | not null | From the initiate request, or the file name without extension (per `phase-03-videos/TD-02`) |
| status | enum `videos_status_enum` | not null, default `'draft'`, values: `'draft'`, `'processing'`, `'ready'`, `'failed'` | Per `phase-03-videos/TD-07` |
| original_filename | varchar(255) | not null | File name declared at initiate; used as the download file name |
| content_type | varchar(100) | not null | MIME type declared at initiate |
| size | bigint | not null | Declared size in bytes at initiate; confirmed against the stored object at completion |
| storage_key | varchar(255) | not null | `videos/{videoId}/original` (per `phase-03-videos/TD-03`) |
| upload_id | varchar(255) | nullable, `select: false` | Storage multipart upload ID; set at initiate, cleared once the multipart upload is completed |
| thumbnail_key | varchar(255) | nullable | `videos/{videoId}/thumbnail.jpg`, set by the worker (per `phase-03-videos/TD-03`, `phase-03-videos/TD-04`) |
| duration | double precision | nullable | Seconds, set by the worker (per `phase-03-videos/TD-04`) |
| metadata | jsonb | nullable | `{ width, height, video_codec, audio_codec, bitrate, frame_rate, container_format }`, set by the worker (per `phase-03-videos/TD-04`); `audio_codec` is `null` when the file has no audio stream |
| failure_reason | text | nullable | Set by the worker when status becomes `failed` (per `phase-03-videos/TD-07`) |
| processed_at | timestamp | nullable | Set by the worker when status becomes `ready` |
| created_at | timestamp | not null, auto-generated | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto-generated | `@UpdateDateColumn` |

**Relations:** `Video` → `Channel` (many-to-one, owning side via `channel_id`); `Channel` → `Video` (one-to-many, inverse side `videos`)
**Indexes:** unique on `public_id`; index on `channel_id`

#### Channel (modified)

No column change. Adds the inverse relation `videos` (`@OneToMany(() => Video, (video) => video.channel)`) so both sides of the relationship are declared.

**Relations:** `Channel` → `Video` (one-to-many)
**Indexes:** unchanged

### API Contracts

All bodies are JSON with snake_case field names (same convention as the Phase 02 endpoints). Owner endpoints address the video by its `id` (uuid); public endpoints address it by its `public_id` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-06`). The controller is exempt from the auth rate limit with `@SkipThrottle()` (rate limiting is scoped to auth endpoints per `phase-02-auth/TD-08`).

#### POST /videos (SI-03.6)

Initiates an upload: pre-registers the video as a draft and opens the multipart upload in the storage (per `phase-03-videos/TD-02`).

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- filename: string, required — 1 to 255 characters
- content_type: string, required — must start with `video/`, max 100 characters
- size: integer, required — bytes, min 1, max 10737418240 (10GB)
- title: string, optional — 1 to 255 characters; defaults to `filename` without its extension

**Response 201:**
- id: string (uuid)
- public_id: string (11 characters)
- title: string
- status: string (`draft`)
- upload: object
  - part_size: integer (bytes, 16777216)
  - part_count: integer (`ceil(size / part_size)`)

**Error responses:**
- 400 validation error: when the request body fails schema validation (including `size` above 10GB or a non-video `content_type`)
- 401: when the access token is missing or invalid
- 404 CHANNEL_NOT_FOUND: when the authenticated user has no channel

---

#### GET /videos/:id/upload (SI-03.7)

Returns the upload/processing state of a video to its owner (the way the uploader follows `draft → processing → ready | failed`).

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- id: string (uuid)
- public_id: string
- title: string
- status: string (`draft` | `processing` | `ready` | `failed`)
- failure_reason: string | null
- size: integer
- upload: object
  - part_size: integer
  - part_count: integer
- created_at: string (ISO 8601)

**Error responses:**
- 400 validation error: when `id` is not a uuid
- 401: when the access token is missing or invalid
- 403 VIDEO_NOT_OWNED: when the video belongs to another channel
- 404 VIDEO_NOT_FOUND: when no video has this `id`

---

#### POST /videos/:id/upload/part-urls (SI-03.7)

Issues presigned `PUT` URLs for a batch of parts; the client sends each part's bytes directly to the storage (per `phase-03-videos/TD-02`).

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- part_numbers: integer[], required — 1 to 100 unique items, each between 1 and the video's `part_count`

**Response 200:**
- urls: array of
  - part_number: integer
  - url: string (presigned storage URL, HTTP `PUT`)
- expires_in: integer (seconds, 3600)

**Error responses:**
- 400 validation error: when the body fails schema validation or `id` is not a uuid
- 400 INVALID_UPLOAD_PARTS: when a part number is greater than the video's `part_count`
- 401: when the access token is missing or invalid
- 403 VIDEO_NOT_OWNED: when the video belongs to another channel
- 404 VIDEO_NOT_FOUND: when no video has this `id`
- 409 VIDEO_UPLOAD_NOT_IN_PROGRESS: when the video status is not `draft`

---

#### GET /videos/:id/upload/parts (SI-03.7)

Lists the parts the storage has already received, so an interrupted upload can resume (per `phase-03-videos/TD-02`).

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- parts: array of
  - part_number: integer
  - etag: string
  - size: integer

**Error responses:**
- 400 validation error: when `id` is not a uuid
- 401: when the access token is missing or invalid
- 403 VIDEO_NOT_OWNED: when the video belongs to another channel
- 404 VIDEO_NOT_FOUND: when no video has this `id`
- 409 VIDEO_UPLOAD_NOT_IN_PROGRESS: when the video status is not `draft`

---

#### DELETE /videos/:id/upload (SI-03.7)

Aborts an unfinished upload: discards the multipart upload in the storage and deletes the draft (per `phase-03-videos/TD-07`).

**Request headers:**
- Authorization: Bearer <access_token>

**Response 204:** No content.

**Error responses:**
- 400 validation error: when `id` is not a uuid
- 401: when the access token is missing or invalid
- 403 VIDEO_NOT_OWNED: when the video belongs to another channel
- 404 VIDEO_NOT_FOUND: when no video has this `id`
- 409 VIDEO_UPLOAD_NOT_IN_PROGRESS: when the video status is not `draft`

---

#### POST /videos/:id/upload/complete (SI-03.8)

Completes the multipart upload and triggers processing: the video moves to `processing` and the processing job is published (per `phase-03-videos/TD-02`, `phase-03-videos/TD-07`).

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- parts: array, required — 1 to 10000 items
  - part_number: integer, required — min 1
  - etag: string, required — the `ETag` response header the storage returned for that part

**Response 200:**
- id: string (uuid)
- public_id: string
- status: string (`processing`)

**Error responses:**
- 400 validation error: when the body fails schema validation or `id` is not a uuid
- 400 INVALID_UPLOAD_PARTS: when the storage rejects the part list (unknown part, wrong ETag, undersized part)
- 400 UPLOAD_SIZE_MISMATCH: when the stored object's size differs from the `size` declared at initiate (the object and the draft are discarded)
- 401: when the access token is missing or invalid
- 403 VIDEO_NOT_OWNED: when the video belongs to another channel
- 404 VIDEO_NOT_FOUND: when no video has this `id`
- 409 VIDEO_UPLOAD_NOT_IN_PROGRESS: when the video status is not `draft`

---

#### GET /videos/:publicId (SI-03.12)

Public details of a processed video, addressed by its unique URL identifier (per `phase-03-videos/TD-05`, `phase-03-videos/TD-06` revision — access policy).

**Response 200:**
- public_id: string
- title: string
- duration: number (seconds)
- metadata: object
  - width: integer
  - height: integer
  - video_codec: string
  - audio_codec: string | null
  - bitrate: integer | null
  - frame_rate: number | null
  - container_format: string
- size: integer
- channel: object
  - nickname: string
  - name: string
- created_at: string (ISO 8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video has this `public_id` or the video is not `ready`

---

#### GET /videos/:publicId/stream (SI-03.12)

Playback entry point (per `phase-03-videos/TD-06`).

**Response 302:** `Location` header with a presigned storage `GET` URL valid for 3600 seconds. The storage answers `Range` requests on that URL with `206 Partial Content`.

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video has this `public_id` or the video is not `ready`

---

#### GET /videos/:publicId/download (SI-03.12)

Download entry point (per `phase-03-videos/TD-06`).

**Response 302:** `Location` header with a presigned storage `GET` URL valid for 3600 seconds, signed with `ResponseContentDisposition: attachment; filename=...` built from `original_filename`.

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video has this `public_id` or the video is not `ready`

---

#### GET /videos/:publicId/thumbnail (SI-03.12)

Thumbnail entry point (per `phase-03-videos/TD-06`).

**Response 302:** `Location` header with a presigned storage `GET` URL (JPEG) valid for 3600 seconds.

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video has this `public_id` or the video is not `ready`

#### Validation Rules — Upload

| Field | Rule |
|-------|------|
| `filename` | required, string, 1–255 characters |
| `content_type` | required, string, matches `^video/`, max 100 characters |
| `size` | required, integer, min 1, max 10737418240 |
| `title` | optional, string, 1–255 characters |
| `part_numbers` | required, array of integers, 1–100 unique items, each ≥ 1 |
| `parts` | required, array of `{ part_number: integer ≥ 1, etag: non-empty string }`, 1–10000 items |
| `:id` | uuid (rejected with 400 before reaching the service) |

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| POST /videos | ✗ | ✓ | — |
| GET /videos/:id/upload | ✗ | ✗ | ✓ |
| POST /videos/:id/upload/part-urls | ✗ | ✗ | ✓ |
| GET /videos/:id/upload/parts | ✗ | ✗ | ✓ |
| DELETE /videos/:id/upload | ✗ | ✗ | ✓ |
| POST /videos/:id/upload/complete | ✗ | ✗ | ✓ |
| GET /videos/:publicId | ✓ | ✓ | ✓ |
| GET /videos/:publicId/stream | ✓ | ✓ | ✓ |
| GET /videos/:publicId/download | ✓ | ✓ | ✓ |
| GET /videos/:publicId/thumbnail | ✓ | ✓ | ✓ |

"Owner" = the authenticated user whose channel is the video's `channel_id`; an authenticated non-owner receives `403 VIDEO_NOT_OWNED`. Public rows are marked `@Public()` and serve only videos with status `ready` (per `phase-03-videos/TD-06` revision — access policy); protected rows rely on the global `JwtAuthGuard` (per `phase-02-auth/TD-02`).

### Error Catalog

Error response format is inherited from Phase 02 (`{ statusCode, error, message }`, per `phase-02-auth/TD-07`). New codes introduced by this phase:

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | Owner endpoint with an unknown `id`; public endpoint with an unknown `public_id` or a video that is not `ready` |
| VIDEO_NOT_OWNED | 403 | Owner endpoint called by a user whose channel is not the video's channel |
| CHANNEL_NOT_FOUND | 404 | `POST /videos` (or any owner endpoint) when the authenticated user has no channel |
| VIDEO_UPLOAD_NOT_IN_PROGRESS | 409 | Part URLs, list parts, abort or complete on a video whose status is not `draft` |
| INVALID_UPLOAD_PARTS | 400 | Requested part number above `part_count`; storage rejects the part list at completion |
| UPLOAD_SIZE_MISMATCH | 400 | Stored object size differs from the size declared at initiate |

### Events/Messages

Queue `video-processing` on Redis (per `phase-03-videos/TD-01`). Connection and key prefix come from the `queue` config namespace (`REDIS_HOST`, `REDIS_PORT`, `QUEUE_PREFIX`).

#### process-video

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService.completeUpload` in the API (per `phase-03-videos/TD-02`, `phase-03-videos/TD-07`)
**Consumer:** `VideoProcessor` in the video worker, delegating to `VideoProcessingService` (per `phase-03-videos/TD-04`)
**Trigger:** the owner completes the upload (`POST /videos/:id/upload/complete`) and the video has moved from `draft` to `processing`
**Delivery semantics:** at-least-once (per `phase-03-videos/TD-01`). Job options: `jobId` = the video `id` (a repeated completion cannot enqueue twice), `attempts: 3`, `backoff: { type: 'exponential', delay: 5000 }` (per `phase-03-videos/TD-07`). The consumer is idempotent: a job for a video that no longer exists or whose status is not `processing` is acknowledged without work.

**Consumer outcome:**

- Success → the worker reads the object through a presigned URL, extracts `duration` and `metadata` with `ffprobe`, generates the thumbnail with `ffmpeg` (one JPEG frame at 10% of the duration, capped at 10 seconds, max width 1280px), stores it at `videos/{videoId}/thumbnail.jpg`, and sets `status = 'ready'`, `duration`, `metadata`, `thumbnail_key`, `processed_at` (per `phase-03-videos/TD-04`).
- Invalid media (no video stream / `ffprobe` cannot read the file) → unrecoverable: no retry; `status = 'failed'` with `failure_reason` (per `phase-03-videos/TD-07`).
- Any other error → retried by the queue; after the last failed attempt `status = 'failed'` with `failure_reason`. The uploaded object is kept.

#### Status lifecycle

| Transition | Writer | Condition |
|------------|--------|-----------|
| (none) → `draft` | API — `POST /videos` | Upload initiated |
| `draft` → (deleted) | API — `DELETE /videos/:id/upload` | Upload aborted |
| `draft` → `processing` | API — `POST /videos/:id/upload/complete` | Multipart upload completed in the storage and size confirmed; reverted to `draft` if the job cannot be published |
| `processing` → `ready` | Worker — `VideoProcessingService` | Metadata extracted and thumbnail stored |
| `processing` → `failed` | Worker — `VideoProcessingService` | Invalid media, or last attempt failed |

---

## Dependency Map

```
SI-03.1 (root — baseline repair)
├── SI-03.2 — depends on SI-03.1 (green baseline before new infra/config)
│   ├── SI-03.3 — depends on SI-03.2 (MinIO service, SDK, storage config)
│   └── SI-03.4 — depends on SI-03.2 (Redis service, BullMQ, queue config)
└── SI-03.5 — depends on SI-03.1 (re-runnable migration spec)

SI-03.3 + SI-03.5
└── SI-03.6 — upload initiation needs storage multipart API and the Video entity
    └── SI-03.7 — owner upload endpoints build on VideosService/controller

SI-03.4 + SI-03.7
└── SI-03.8 — completion publishes the job (queue) after parts are uploaded

SI-03.2 + SI-03.3
└── SI-03.9 — media inspection needs FFmpeg in the image and storage URLs

SI-03.4 + SI-03.5 + SI-03.9
└── SI-03.10 — processing service/processor
    └── SI-03.11 — worker entrypoint and Compose service

SI-03.8 + SI-03.10
└── SI-03.12 — public endpoints serve videos made ready by processing

SI-03.11 + SI-03.12
└── SI-03.13 — full pipeline through the real worker + contract export
    └── SI-03.14 — documentation reflects the final code
```

Linearized implementation order: SI-03.1 → SI-03.2 → SI-03.3 → SI-03.4 → SI-03.5 → SI-03.6 → SI-03.7 → SI-03.8 → SI-03.9 → SI-03.10 → SI-03.11 → SI-03.12 → SI-03.13 → SI-03.14

---

## Deliverables

- [ ] SI-03.1 — Baseline Repair: Lint and Re-runnable Migration Test
- [ ] SI-03.2 — Infra: Compose Services, Image, Dependencies and Config Namespaces
- [ ] SI-03.3 — Storage Module (S3-Compatible Object Storage)
- [ ] SI-03.4 — Queue Module (BullMQ Connection)
- [ ] SI-03.5 — Video Entity and Migration
- [ ] SI-03.6 — Upload Initiation with Draft Pre-registration
- [ ] SI-03.7 — Upload Parts: Presigned URLs, Resume, State and Abort
- [ ] SI-03.8 — Upload Completion and Processing Job Publishing
- [ ] SI-03.9 — Media Inspection with FFmpeg
- [ ] SI-03.10 — Video Processing Service, Processor and Failure Policy
- [ ] SI-03.11 — Video Worker Entrypoint and Compose Service
- [ ] SI-03.12 — Public Video Details, Streaming, Download and Thumbnail
- [ ] SI-03.13 — End-to-End Pipeline Through the Real Worker and Contract Export
- [ ] SI-03.14 — AI Foundation and Documentation Update

**Full test suites:**

- [ ] Backend tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully (`cd nestjs-project && docker compose exec nestjs-api npm run build`)
