---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-10-07
scope_description: "Backend foundation for video upload and processing: queue technology, direct-to-storage upload of files up to 10GB, object storage usage (S3/MinIO), video worker runtime with FFmpeg metadata/thumbnail extraction, unique video URL, streaming/download delivery, and the video status lifecycle with its failure policy."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the videos module (API), the object storage integration, the processing queue, and the video worker (FFmpeg), plus the new infrastructure services in `nestjs-project/compose.yaml`. Every TD below covers this subproject.
- `next-frontend/` — no open decision in this document. The video UI is out of scope for this phase (the phase is delivered as API + worker + infrastructure); TD-02 and TD-06 are marked `Cross-layer` because the HTTP handshake they define is the contract a future frontend phase will consume, but no frontend code or frontend-only choice is decided here.

_Constraints inherited (not reopened):_ object storage is S3-compatible (MinIO locally, S3 in production) per `docs/project-plan.md` § Arquitetura and `docs/diagrams/software-arch.mermaid`; error envelope `{ statusCode, error, message }` and domain exceptions per `phase-02-auth/TD-07`; request validation with `class-validator` per `phase-02-auth/TD-06`; namespaced `registerAs` config + Joi schema per `phase-01-configuracao-base/TD-01..TD-03`; global JWT guard with `@Public()` opt-out per `phase-02-auth/TD-02`.

---

## TD-01: Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram lists the Message Queue container as "TBD". The API must publish a processing job when an upload completes and a separate worker must consume it, with retries and visibility into failures. This is the main open stack choice of the phase and it adds a new infrastructure service to `compose.yaml`. Installed stack: NestJS 11 (CommonJS build), Node 25, PostgreSQL 17; no Redis or AMQP broker exists yet.

**Options:**

### Option A: BullMQ on Redis (`@nestjs/bullmq`)
- Job queue library backed by Redis. `@nestjs/bullmq` is the integration documented in the official NestJS queues guide: `BullModule.forRootAsync` + `registerQueue`, producers via `@InjectQueue`, consumers as `@Processor` classes extending `WorkerHost`.
- **Pros:** first-party NestJS integration with DI in the processor; built-in attempts/backoff, `UnrecoverableError`, stalled-job recovery, job deduplication by `jobId`, and inspectable job states (`waiting`/`active`/`failed`) that integration tests can assert; `@nestjs/bullmq@11` is CommonJS and targets NestJS 11; already the pattern named by the project's `nestjs-best-practices` skill and testing guide.
- **Cons:** adds Redis as a new stateful service; it is a job queue, not a general message broker (no routing/exchanges, Node-centric consumers); `@nestjs/bullmq@12` is ESM-only, so the 11.x line must be pinned while the project builds as CommonJS.

### Option B: RabbitMQ (AMQP)
- Dedicated message broker; the API publishes to an exchange and the worker consumes from a durable queue with manual ack. Integrated through `@nestjs/microservices` (RMQ transport) or `@golevelup/nestjs-rabbitmq`.
- **Pros:** language-agnostic broker (a non-Node worker could consume later); rich routing, dead-letter exchanges, management UI; strong delivery guarantees with acks.
- **Cons:** retries with backoff, deduplication and job-state inspection must be hand-built (DLX + TTL queues); heavier service to operate; more code for the single "process this video" job the phase needs; job progress/state is not queryable for tests without extra plumbing.

### Option C: pg-boss (PostgreSQL-backed queue)
- Job queue stored in the existing PostgreSQL using `SKIP LOCKED`. No new infrastructure service.
- **Pros:** zero new containers; job enqueue can share a transaction with the video row update; retries and backoff built in.
- **Cons:** no official NestJS integration (manual provider wiring and lifecycle); couples queue throughput to the primary database; recent major versions are ESM-only, conflicting with the CommonJS build; contradicts the architecture diagram, which models the queue as its own container.

**Recommendation:** **Option A (BullMQ on Redis)** — it is the only option with a first-party NestJS 11 integration that gives retries, backoff, deduplication and inspectable job state out of the box, which is exactly what one long-running "process video" job needs; Redis is a small, well-understood addition to `compose.yaml`, while RabbitMQ would require hand-building the retry/state machinery and pg-boss would break the "queue as its own container" architecture and the CommonJS build.

**Decision:** A (BullMQ on Redis)
**Libraries:** `@nestjs/bullmq@^11.0.5`, `bullmq@^6.3.x`

---

## TD-02: Large-File Upload Strategy

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** A 10GB file cannot travel through the NestJS process without holding a connection (and memory/disk) for the entire transfer, and `docs/project-plan.md` § Pontos de Atenção also asks that an interrupted upload can be resumed. The strategy defines the handshake between client and API (hence Cross-layer: a future frontend implements the client side) and the moment the draft video row is created. S3 limits that constrain every option: a single `PutObject` is capped at 5GB; multipart uploads allow up to 10,000 parts of 5MB–5GB each.

**Options:**

### Option A: S3 multipart upload with presigned part URLs (direct to storage)
- The client calls the API to initiate: the API creates the video row as a draft, calls `CreateMultipartUpload`, and returns the video identifiers plus the part size/count. The client requests presigned `UploadPart` URLs in batches, `PUT`s each part straight to the storage, then calls the API to complete (`CompleteMultipartUpload` with the part ETags), which is the trigger for processing. An abort endpoint discards an unfinished upload.
- **Pros:** file bytes never touch the API (only small JSON calls), so API performance is independent of file size; parts upload in parallel and a failed part is retried alone, which gives resumability (the client can ask the API which parts the storage already has); works identically on MinIO and S3; no extra server component.
- **Cons:** the client must implement chunking and collect ETags (more client code than a form post); presigned URLs must be signed for the host the client can reach, so the storage needs a "public" endpoint setting distinct from the internal one; unfinished multipart uploads leave orphan parts until aborted.

### Option B: tus resumable upload protocol
- A tus server (`@tus/server` with the S3 store) receives `PATCH` chunks and assembles the object in the storage; mature browser clients exist (tus-js-client, Uppy).
- **Pros:** standardized resumable protocol with ready-made clients; pause/resume handled by the protocol.
- **Cons:** every byte still flows through a server process we run (the API or one more service), which is exactly the load the phase wants to avoid; `@tus/server` is ESM-only; adds a second upload-state store alongside the video row.

### Option C: Streaming multipart/form-data through the API
- The client posts the file to the API, which pipes the request stream to the storage (`@aws-sdk/lib-storage` `Upload`), without buffering to disk.
- **Pros:** simplest client (a single form post); the API authorizes and observes the whole transfer.
- **Cons:** the API holds one long-lived connection per upload for the full 10GB — API capacity becomes bound to upload traffic; no resumability (a dropped connection restarts from zero); reverse-proxy body-size and timeout limits must be raised globally.

**Recommendation:** **Option A (S3 multipart with presigned part URLs)** — it is the only option where the API never carries file bytes, which is the literal requirement ("sem impacto na performance"), and per-part retry plus a "list uploaded parts" call satisfies the resume attention point without introducing a tus server. Parameters: maximum declared size 10GB (`10 * 1024^3` bytes) validated at initiate; fixed part size of 16MB (640 parts for 10GB, far below the 10,000-part cap); presigned part URLs valid for 1 hour and issued in batches of at most 100 part numbers; the video row is created with status `draft` in the same initiate call, with the title taken from the request or defaulting to the file name without extension; completion is the only trigger for processing (depends on TD-01 and TD-07).

**Decision:** A (S3 multipart upload with presigned part URLs)
**Libraries:** —

**Revisions:**
- 2026-10-07 — Draft ownership: the draft video is owned by the authenticated user's channel, resolved through a channel-by-user lookup added to `ChannelsService` in this phase (the channels module owns the lookup; the videos module consumes it). Rationale: DG-1 — Phase 02 exposes only channel creation and the JWT payload carries `{ sub, email }`.

---

## TD-03: Object Storage Client and Bucket/Key Organization

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The storage backend itself is given (S3-compatible; MinIO in Docker). What is open is which client library talks to it, how buckets and object keys are organized for originals and thumbnails, and the canonical set of environment variable keys — the latter is a cross-component contract (Joi schema + `compose.yaml` + `.env.example` + API and worker runtime). Presigned URLs (TD-02, TD-06) must be signed for a host reachable by the client, while the API and worker reach the storage through the Compose service name.

**Options:**

### Option A: AWS SDK v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`), single private bucket with key prefixes
- One private bucket; keys `videos/{videoId}/original` and `videos/{videoId}/thumbnail.jpg`. The S3 client is configured with a custom `endpoint` and `forcePathStyle: true` for MinIO; a second client instance bound to the public endpoint is used only for presigning.
- **Pros:** the same code runs against MinIO and real S3 (only env values change); official, modular, typed SDK with every multipart and presign command needed; one bucket keeps all objects of a video under one prefix (simple cleanup and lifecycle rules); nothing is publicly readable by default.
- **Cons:** larger dependency tree than a MinIO-specific client; thumbnails also need a presigned URL (or a redirect) to be displayed.

### Option B: MinIO JavaScript SDK (`minio`)
- MinIO's own client, with helper methods for presigned URLs.
- **Pros:** smaller API surface; first-class against MinIO.
- **Cons:** ties the code to a MinIO-flavoured client when production is S3; presigned multipart part URLs are not a first-class helper (needs the generic presign with query params); less TypeScript coverage of S3 features.

### Option C: AWS SDK v3 with two buckets (private videos, public-read thumbnails)
- Same SDK as A, but thumbnails live in a second bucket with an anonymous read policy and are served by plain URL.
- **Pros:** thumbnails load without signing; clear separation of sensitive originals.
- **Cons:** two buckets and a bucket policy to provision and keep in sync across environments; thumbnails of videos that are not yet published would be world-readable, pre-empting the visibility rules that belong to Fase 04.

**Recommendation:** **Option A (AWS SDK v3, single private bucket)** — the project's stated production target is S3, so the official SDK keeps MinIO strictly a local stand-in, and a single private bucket avoids deciding public exposure before Fase 04 defines visibility. Canonical environment keys: `STORAGE_ENDPOINT` (internal URL, Compose service name), `STORAGE_PUBLIC_ENDPOINT` (URL used when signing links handed to clients), `STORAGE_REGION`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_BUCKET`. The bucket is created by the application at startup when missing, so no extra provisioning container is needed.

**Decision:** A (AWS SDK v3, single private bucket with key prefixes)
**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

**Revisions:**
- 2026-10-07 — Testing strategy: storage code is tested against the real S3-compatible service in Compose (MinIO), with no filesystem adapter; the "Object Storage" strategy in the `testing-guide-nestjs-project` skill is updated in this phase. Rationale: IC-1 — presigned URLs and multipart uploads cannot be exercised by a filesystem adapter.

---

## TD-04: Worker Runtime and Media Extraction

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** Processing is CPU- and I/O-heavy and must not run inside the API's event loop or share its container resources. Two coupled choices: where the consumer runs, and how it reads a file of up to 10GB to extract metadata and one frame. `fluent-ffmpeg`, the usual Node wrapper, is flagged as deprecated/unsupported on npm.

**Options:**

### Option A: Separate worker container, same NestJS codebase, FFmpeg CLI over a presigned URL
- A second entrypoint (`NestFactory.createApplicationContext` on a worker module, no HTTP server) runs in its own Compose service built from an image that includes `ffmpeg`. The processor calls `ffprobe`/`ffmpeg` with `execFile`, passing a presigned GET URL as input, so FFmpeg reads only the byte ranges it needs. The thumbnail frame is written to a temp file and uploaded to the storage.
- **Pros:** API and worker scale and fail independently while sharing entities, config and storage code (no duplication); no 10GB download to worker disk — metadata and one frame need only a few range requests; no wrapper dependency, just the FFmpeg binaries; matches the diagram's "Video Worker (FFmpeg)" container.
- **Cons:** the worker image must carry FFmpeg; `ffprobe` JSON output is parsed by our code; files whose index sits at the end need extra seeks (handled by HTTP range requests, slower than local disk).

### Option B: Processor inside the API process
- Register the `@Processor` in the API's module so the same process consumes jobs.
- **Pros:** one container, simplest wiring.
- **Cons:** FFmpeg child processes compete with HTTP handling for CPU and memory; violates the architecture (worker as its own container) and the phase requirement of a separate worker.

### Option C: Separate worker container, `fluent-ffmpeg`, download-then-process
- Same separation as A, but the worker downloads the object to local disk and drives FFmpeg through `fluent-ffmpeg`.
- **Pros:** fluent API; local file avoids network seeks.
- **Cons:** `fluent-ffmpeg` is deprecated on npm; each job needs up to 10GB of scratch disk and a full download before work starts; more moving parts for the same output.

**Recommendation:** **Option A (separate container, same codebase, FFmpeg CLI over presigned URL)** — it honours the diagram's worker container without forking the codebase, avoids both the deprecated wrapper and a 10GB scratch download, and keeps the extraction to two short CLI calls. Extracted metadata: `duration` (seconds), `width`, `height`, `video_codec`, `audio_codec`, `bitrate`, `frame_rate`, `container_format` from `ffprobe -show_format -show_streams`; an object with no video stream is treated as an unrecoverable processing failure (see TD-07). Thumbnail: one JPEG frame taken at 10% of the duration (capped at 10 seconds), scaled to a maximum width of 1280px.

**Decision:** A (Separate worker container, same codebase, FFmpeg CLI over presigned URL)
**Libraries:** —

---

## TD-05: Unique Video URL Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short, URL-safe identifier that never collides (`docs/project-plan.md` § Pontos de Atenção: "URL curta e única que nunca conflite"). The identifier is generated when the draft is created (TD-02), stored on the video row, and is the public key used by the playback endpoints (TD-06).

**Options:**

### Option A: Random URL-safe ID from `node:crypto`, unique column, retry on collision
- Generate 11 characters from a 64-symbol URL-safe alphabet (`A-Z a-z 0-9 _ -`, 66 bits of entropy) with `crypto.randomBytes`; a unique index on the column is the source of truth and an insert collision triggers regeneration.
- **Pros:** short and non-enumerable (cannot be guessed or scraped sequentially); no dependency; the unique constraint guarantees "never conflicts" even under concurrent inserts.
- **Cons:** requires a small retry loop (using a pre-check plus unique-violation handling, as channels do for nicknames); IDs carry no ordering.

### Option B: Expose the UUID primary key
- Use the row's UUID in URLs.
- **Pros:** nothing to generate or store; collision-free.
- **Cons:** 36-character URLs are not "curta"; couples the public URL to the internal primary key.

### Option C: Encoded sequential number (Sqids/Hashids)
- Encode a database sequence value into a short string.
- **Pros:** short, collision-free by construction, no retry.
- **Cons:** reversible/enumerable when the alphabet is known, exposing upload volume and letting anyone walk through videos; adds a dependency plus a dedicated sequence.

**Recommendation:** **Option A (random 11-character URL-safe ID with a unique index)** — it satisfies "short" and "never conflicts" with zero dependencies, and non-enumerability matters because Fase 04 introduces unlisted videos that are reachable only by link. The retry reuses the pre-check + unique-violation pattern already established by `ChannelsService` for nicknames.

**Decision:** A (Random 11-character URL-safe ID with unique index)
**Libraries:** —

---

## TD-06: Streaming and Download Delivery

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** A player must start playback without fetching the whole file, which in HTTP terms means byte-range requests answered with `206 Partial Content`. The architecture diagram already draws `Frontend → Object Storage: Streams`. The choice is who serves the bytes and what the API endpoint returns (Cross-layer: the response shape is what a player/front-end consumes). Depends on TD-03 (private bucket → links must be signed).

**Options:**

### Option A: API redirects to a short-lived presigned GET URL; the storage serves ranges
- `GET` playback/download endpoints on the API look the video up by its public ID, check that it is ready, and answer `302` with a presigned storage URL. The player follows the redirect and issues `Range` requests directly to the storage, which answers `206`. The download variant signs the URL with `ResponseContentDisposition: attachment; filename=...`.
- **Pros:** video bytes never pass through the API (same principle as TD-02); range support, caching headers and throughput come from the storage for free; works with a plain `<video src>` and matches the diagram; the API keeps the authorization decision.
- **Cons:** the signed URL is usable by anyone who obtains it until it expires; players that outlive the URL's lifetime must hit the API again; the storage's public endpoint must be reachable by clients.

### Option B: API proxies the object with Range passthrough
- The API parses the `Range` header, requests that range from the storage, and pipes it back with `206` and `Content-Range`.
- **Pros:** storage stays fully private; per-request authorization and accounting.
- **Cons:** every watched byte flows through the API process — playback traffic becomes API load, the opposite of the diagram; more code (range parsing, backpressure, aborts).

### Option C: Transcode to HLS and serve segments
- The worker transcodes to adaptive HLS renditions; players fetch a playlist and small segments.
- **Pros:** adaptive bitrate; best playback experience on poor networks.
- **Cons:** transcoding a 10GB source multiplies processing time and storage; the phase asks only for duration/metadata extraction and a thumbnail — transcoding is not a listed capability.

**Recommendation:** **Option A (302 redirect to a presigned GET URL)** — it delivers real `206 Partial Content` streaming and download without routing media through the API, consistent with TD-02 and with the diagram's `Frontend → Object Storage` stream; HLS is out of the phase's stated capabilities. Parameters: presigned playback/download URLs valid for 1 hour; playback and download are available only when the video status is `ready` (TD-07); the same redirect approach serves the thumbnail.

**Decision:** A (302 redirect to presigned GET URL)
**Libraries:** —

**Revisions:**
- 2026-10-07 — Access policy for this phase: video details, playback, download and thumbnail of a `ready` video are public by link (anyone holding the unique URL; no listing endpoint exists); upload operations and reading a video that is not `ready` are restricted to the owning channel. Visibility rules arrive in Fase 04. Rationale: AMB-1 — the capabilities do not state who may reach playback/download.

---

## TD-07: Video Status Lifecycle and Processing Failure Policy

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The video row is written by two processes (API and worker) and its status drives what each endpoint allows. The states, the transitions, who performs them, and what happens when processing fails must be one shared definition. Depends on TD-01 (retry primitives) and TD-02 (completion triggers processing).

**Options:**

### Option A: Four states — `draft → processing → ready | failed` — with bounded retries
- `draft`: row created at upload initiate, upload in progress. `processing`: set by the API when the upload completes, in the same operation that enqueues the job. `ready`: set by the worker together with duration, metadata and thumbnail key. `failed`: set by the worker after the last attempt fails, with a stored reason. Transient errors are retried by the queue; a file that is not a valid video fails immediately without retry.
- **Pros:** matches the cycle the phase describes; every state has exactly one writer and one entry condition; failures are visible to the owner instead of leaving the video stuck in `processing`; the uploaded object is kept on failure for diagnosis.
- **Cons:** does not distinguish "uploading" from "upload abandoned" (both are `draft`); a failed video needs a new upload to recover (no reprocess endpoint in this phase).

### Option B: Finer-grained states (`uploading`, `uploaded`, `queued`, `processing`, `ready`, `failed`)
- One state per pipeline step.
- **Pros:** precise progress reporting.
- **Cons:** more transitions to keep consistent across two processes for no consumer in this phase; `uploaded` and `queued` are instantaneous since completion enqueues immediately.

### Option C: No failure state — delete the video when processing fails
- A failed job removes the row and the object.
- **Pros:** no failed rows to manage.
- **Cons:** the uploader gets no explanation (the video silently disappears); a transient infrastructure error destroys a 10GB upload.

**Recommendation:** **Option A (`draft → processing → ready | failed` with bounded retries)** — it is the smallest state machine that covers the phase and makes failure observable. Policy: the processing job is enqueued with the video ID as job ID (a repeated completion cannot enqueue twice), 3 attempts with exponential backoff starting at 5 seconds; after the last failed attempt, or immediately for an invalid media file, the worker sets `failed` and stores the reason; completing an upload is only accepted from `draft`, and aborting an upload deletes the draft row. Stale drafts (abandoned uploads) are left as-is in this phase.

**Decision:** A (`draft → processing → ready | failed` with bounded retries)
**Libraries:** —

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Queue Technology | BullMQ on Redis (`@nestjs/bullmq`) | A (BullMQ on Redis) |
| TD-02 | Cross-layer | Large-File Upload Strategy | S3 multipart upload with presigned part URLs | A (S3 multipart upload with presigned part URLs) |
| TD-03 | Backend | Object Storage Client and Bucket/Key Organization | AWS SDK v3, single private bucket with key prefixes | A (AWS SDK v3, single private bucket with key prefixes) |
| TD-04 | Backend | Worker Runtime and Media Extraction | Separate container, same codebase, FFmpeg CLI over presigned URL | A (Separate worker container, same codebase, FFmpeg CLI over presigned URL) |
| TD-05 | Backend | Unique Video URL Identifier | Random 11-character URL-safe ID with unique index | A (Random 11-character URL-safe ID with unique index) |
| TD-06 | Cross-layer | Streaming and Download Delivery | 302 redirect to presigned GET URL (storage serves ranges) | A (302 redirect to presigned GET URL) |
| TD-07 | Backend | Video Status Lifecycle and Processing Failure Policy | `draft → processing → ready \| failed` with bounded retries | A (`draft → processing → ready \| failed` with bounded retries) |
