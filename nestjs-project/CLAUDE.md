# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`
- **MinIO:** `docker compose exec minio mc ready local` — expect `The cluster 'local' is ready`
- **Video worker:** `docker compose logs video-worker | grep "Video worker started"` — the worker is infrastructure for the upload flow and starts with `docker compose up -d` (unlike the API server, see below). On a fresh clone it logs `waiting for npm install` until dependencies are installed through `nestjs-api`.

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000` (container idles; the server is started on demand)
- `video-worker` — video processing worker (BullMQ consumer + FFmpeg), no port; runs `npm run start:worker:dev` from the same image and bind mount as `nestjs-api`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP capture, ports `1025` (SMTP) and `8025` (web UI / API)
- `redis` — Redis 7, port `6379`, backs the BullMQ queue
- `minio` — S3-compatible object storage, port `9000` (API) and `9001` (console, user `streamtube` / password `streamtube-secret`). Image is `cgr.dev/chainguard/minio:latest` because the official `minio/minio` image is no longer published.

The image (`Dockerfile.dev`) includes `ffmpeg`/`ffprobe`; after changing it run `docker compose up -d --build`.

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm run start:worker                     # Video worker, one-off (ts-node)
npm run start:worker:dev                 # Video worker with reload (what the video-worker container runs)
npm run start:worker:prod                # Video worker from the compiled build (dist/worker.js)

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (the script passes --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

### Tests and the running infrastructure

Storage, queue and FFmpeg are exercised for real — there is no filesystem storage adapter and no queue mock. Three helpers keep that safe next to a running stack:

- `src/test/storage-test-env.ts` → `useInternalStorageEndpoint()` — presigned URLs for clients are signed for `STORAGE_PUBLIC_ENDPOINT` (`localhost:9000`), unreachable from inside the container; the helper points it at the internal endpoint for the test process. Call it **before** the Nest module is created. `createTestStorageService()` builds a `StorageService` for integration tests.
- `src/test/queue-test-env.ts` → `useIsolatedQueuePrefix()` — gives the test process its own `QUEUE_PREFIX` so the `video-worker` container does not consume jobs a test wants to assert on; `emptyQueue(queue)` clears a queue between tests. Any test that compiles a module containing `VideoProcessor` (it starts a real BullMQ worker) must call it too.
- `src/test/video-fixture.ts` → `generateSampleVideo()` — builds a small MP4 with FFmpeg; no binary fixtures are committed. `src/test/video-factory.ts` creates users/channels/videos directly in the database.

`test/video-pipeline.e2e-spec.ts` is the one suite that deliberately keeps the default `QUEUE_PREFIX`: it needs the `video-worker` container running and fails after 90s when it is not.

`createTestDataSource()` always registers every entity (`ALL_ENTITIES`), because TypeORM needs the whole relation graph; add new entities to that list and to `cleanAllTables()` in `src/test/create-test-data-source.ts`.

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `start:worker`, `start:worker:dev`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

New in Phase 03 (all validated by `src/config/env.validation.ts`):

| Variable | Default | Purpose |
|----------|---------|---------|
| `STORAGE_ENDPOINT` | `http://minio:9000` | Storage URL used by the API and the worker (Compose service name) |
| `STORAGE_PUBLIC_ENDPOINT` | `http://localhost:9000` | Host signed into presigned URLs handed to clients |
| `STORAGE_REGION` | `us-east-1` | S3 region |
| `STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY` | — (required) | Storage credentials |
| `STORAGE_BUCKET` | `streamtube` | Single private bucket; created at startup when missing |
| `REDIS_HOST` / `REDIS_PORT` | `redis` / `6379` | BullMQ connection |
| `QUEUE_PREFIX` | `streamtube` | Redis key prefix of the queues; the API and the worker must share it |

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`; infrastructure wrappers (`StorageModule`, `QueueModule`, `DatabaseModule`) are imported by the modules that need them
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Videos, Storage and Queue

Two processes share this codebase: the API (`src/main.ts` → `AppModule`) and the video worker (`src/worker.ts` → `WorkerModule`, a Nest application context with no HTTP listener). Both load the same configuration (`src/config/config-module.options.ts`) and database connection (`src/database/database.module.ts`).

| Path | Role |
|------|------|
| `src/videos/videos.controller.ts` | `@Controller('videos')`, `@SkipThrottle()`. Owner endpoints by uuid `:id`; public endpoints (`@Public()`) by `:publicId` |
| `src/videos/videos.service.ts` | Upload lifecycle (initiate, part URLs, list parts, abort, complete + publish job) and public reads (details, stream/download/thumbnail URLs) |
| `src/videos/entities/video.entity.ts` | `Video` (`videos` table), `VideoStatus`, `VideoMetadata`; belongs to `Channel` (`channel_id`, cascade delete) |
| `src/videos/videos.constants.ts` | 10GB limit, 16MB part size, 1h presigned URL lifetime, public id alphabet/length |
| `src/videos/video-public-id.util.ts` | 11-character URL-safe id; uniqueness comes from the unique index + retry in the service |
| `src/videos/processing/` | Worker side only: `VideoProcessor` (BullMQ consumer, retry/failure policy), `VideoProcessingService` (`process`, `markFailed`), `MediaInspectorService` (`ffprobe`/`ffmpeg` via `execFile`), `ffprobe.parser.ts` |
| `src/storage/` | `StorageService` — the only code that talks to the S3 SDK; key builders in `storage.constants.ts` (`videos/{videoId}/original`, `videos/{videoId}/thumbnail.jpg`) |
| `src/queue/` | `QueueModule` (BullMQ root connection from `queueConfig`), queue/job names and job options in `queue.constants.ts` |

Endpoints (contracts in `docs/phases/phase-03-videos/phase-03-videos.md` → API Contracts; exported to `openapi.json`):

| Method and path | Auth | Purpose |
|-----------------|------|---------|
| `POST /videos` | Bearer | Initiate upload, create draft |
| `GET /videos/:id/upload` | Owner | Upload/processing state |
| `POST /videos/:id/upload/part-urls` | Owner | Presigned `PUT` URLs (≤ 100 parts per call) |
| `GET /videos/:id/upload/parts` | Owner | Parts already in the storage (resume) |
| `DELETE /videos/:id/upload` | Owner | Abort upload, delete draft |
| `POST /videos/:id/upload/complete` | Owner | Assemble object, set `processing`, publish job |
| `GET /videos/:publicId` | Public | Details of a `ready` video |
| `GET /videos/:publicId/stream` · `/download` · `/thumbnail` | Public | `302` to a presigned storage URL |

Things that are easy to get wrong:

- **Never route file bytes through the API.** Uploads use presigned part URLs; playback/download are redirects. `StorageService.presignGetObject` takes an `audience`: `public` for URLs returned to clients, `internal` for URLs the worker hands to FFmpeg.
- **`VideoProcessor` belongs to `VideoProcessingModule`, which only `WorkerModule` imports.** `VideosModule` registers the queue as a producer; importing the processing module into `AppModule` would make the API consume jobs.
- **`upload_id` is `select: false`.** Load it explicitly (see `VideosService.findUploadId`) — a plain `findOne` returns `undefined` for it.
- **Status changes are conditional updates** (`update({ id, status: <expected> }, …)`), because the API and the worker write the same row. Check `affected` when the outcome matters.
- **Worker failures:** throw `InvalidMediaError` only for "this file is not a video" (no retry, reason shown to the owner). Any other error is retried by the queue and ends as the generic reason — FFmpeg's stderr contains the presigned source URL and must not reach `failure_reason`.
- **FFmpeg runs as a child process** (`execFile`), never in-process, so the worker's event loop stays free to renew the job lock.
- **`@nestjs/bullmq` is pinned to 11.x** (12.x is ESM-only; this project builds CommonJS), and `bullmq@6` needs `ioredis` installed explicitly.
- **`openapi.json` request bodies are exported empty** (`npm run openapi:export` runs under ts-node, where the Swagger CLI plugin does not run). Paths and response DTOs are complete. After changing a controller: `npm run openapi:export`, then `scripts/sync-openapi.sh` from the repo root.

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
