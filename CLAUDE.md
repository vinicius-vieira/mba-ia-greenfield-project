# CLAUDE.md

## Project Overview

StreamTube — a video sharing platform (YouTube-like). Users can upload, manage, and publish videos. Anonymous users can watch freely; social features (comments, subscriptions, likes) require authentication.

More info in the project overview: [docs/project-plan.md](docs/project-plan.md)

## Repository Structure

This is a monorepo with two main areas:

- `nestjs-project/` — Backend (NestJS 11, TypeScript, Express): the REST API and the video worker, two processes built from the same codebase. Modules today: `auth`, `users`, `channels`, `mail`, `videos`, `storage`, `queue`.
- `next-frontend/` — Frontend (Next.js): auth screens of Phase 02. No video UI yet.
- `docs/` — Project documentation, architecture diagrams, and planning.

## Architecture (C4 Container Diagram)

See `docs/diagrams/software-arch.mermaid` for the full diagram. Key containers:

- **Frontend** (Next.js) → calls API via REST, streams from Object Storage
- **API** (Nest.js) → business rules, auth, reads/writes DB, opens uploads in the storage and signs storage URLs, publishes jobs to queue, sends emails
- **Video Worker** (FFmpeg) → consumes jobs from queue, processes videos, updates DB and storage
- **Database** (PostgreSQL) → users, channels, videos (comments and likes arrive in later phases)
- **Object Storage** (S3/MinIO) → video files and thumbnails; clients upload to and stream from it directly through presigned URLs
- **Message Queue** (BullMQ on Redis) → video processing job queue
- **Email Service** (SMTP) → account confirmation and password recovery

## Videos (Phase 03 — Upload and Processing)

Decisions: `docs/decisions/technical-decisions-phase-03-videos.md`. Plan and contracts (Data Model, API Contracts, Error Catalog, Events/Messages): `docs/phases/phase-03-videos/phase-03-videos.md`. Operational detail (commands, env vars, test helpers): `nestjs-project/CLAUDE.md` → "Videos, Storage and Queue".

**Rule that shapes everything here: video bytes never pass through the API.** Uploads go from the client to the object storage through presigned multipart part URLs; playback and download are `302` redirects to presigned storage URLs (the storage answers `Range` requests with `206`). Do not add an endpoint that receives or pipes a video file.

Flow:

1. `POST /videos` — pre-registers the video as `draft` (owned by the caller's channel, with an 11-character unique `public_id`) and opens a multipart upload in the storage. Max size 10GB, fixed 16MB parts.
2. `POST /videos/:id/upload/part-urls` → the client `PUT`s each part to the storage. `GET /videos/:id/upload/parts` lists received parts (resume). `DELETE /videos/:id/upload` aborts.
3. `POST /videos/:id/upload/complete` — assembles the object, confirms its size, sets `processing` and publishes the `process-video` job (queue `video-processing`, `jobId` = video id, 3 attempts, exponential backoff).
4. The **video worker** (separate container `video-worker`, entrypoint `nestjs-project/src/worker.ts`) reads the object through an internal presigned URL with `ffprobe`/`ffmpeg`, stores duration + metadata + a JPEG thumbnail, and sets `ready` — or `failed` with `failure_reason` (immediately for a file that is not a video, otherwise after the last retry).
5. `GET /videos/:id/upload` — the owner follows the status. Public, by `public_id`, only for `ready` videos: `GET /videos/:publicId`, `/stream`, `/download`, `/thumbnail`.

Status lifecycle: `draft → processing → ready | failed`. Each transition has one writer (API for `draft`/`processing`, worker for `ready`/`failed`) and is applied with a conditional update on the current status — keep it that way when adding transitions.

Access in this phase: upload endpoints are owner-only (`403 VIDEO_NOT_OWNED` otherwise); a video that is not `ready` is invisible on the public endpoints (`404 VIDEO_NOT_FOUND`). Visibility (public/unlisted) and publication belong to Phase 04.

## Docker Networking

This project runs entirely in Docker containers. When configuring connections between services (database, cache, queue, etc.), **always use the Docker Compose service name** as the host — never `localhost` or `127.0.0.1`.

Inside a container, `localhost` refers to the container itself, not the host machine or other containers. Services communicate through the Docker Compose network using their service names (e.g., `db`, `redis`, `minio`, `nestjs-api`).

- **Correct:** `DB_HOST=db` (the Compose service name)
- **Wrong:** `DB_HOST=localhost`

This applies to all environment variables, configuration files, and code that references service hosts.

One deliberate exception: `STORAGE_PUBLIC_ENDPOINT` is the host written into presigned URLs that are handed to clients **outside** the Compose network (a browser), so in local development it is `http://localhost:9000`. Everything the API and the worker call themselves uses `STORAGE_ENDPOINT=http://minio:9000`.

## Working Principles

- **Single Responsibility:** each module, service, and function should have a clear, focused responsibility. Re-evaluate adherence at every step — when a module starts owning logic or entities that are not its own (e.g., a service creating an entity from another domain), extract it immediately into the proper module instead of deferring to a later corrective task.
- **Type Safety:** Strict TypeScript usage across all layers.
- **Testing:** Strong emphasis on pyramid testing at all levels to ensure reliability and maintainability.
- **Code Quality:** Use ESLint and Prettier for consistent code style. Code reviews should focus on readability, maintainability, and adherence to best practices.
- **Documentation:** Comprehensive docs for architecture, setup, and troubleshooting in `docs/`.

## Definition of Done (Technical)

A change is only considered complete when **all** of the following pass:

1. The relevant test suite passes (unit + integration + e2e affected by the change).
2. The full test suite passes before finishing the task.
3. TypeScript compiles cleanly: `npx tsc --noEmit` exits with code 0. Compilation errors must never be left as debt for future tasks.
4. Lint passes: `npm run lint`.

If any of these fails, the task is not done — fix the underlying issue before declaring completion.


## Git Conventions

- **Main branch:** `main` — never commit directly to it
- Branches: `feature/*`, `bugfix/*`, `hotfix/*`, `docs/*`
- **Commits:** short, descriptive messages focused on the "why" of the change
- **Workflow:** Git Flow conventions. Two long-lived branches:
  - `main` — stable, production-ready code 
  - `dev` — integration branch; all feature/bugfix/hotfix branches start from `dev` and merge back into `dev`
  - When `dev` is stable, it is merged into `main`

## Testing Policy

Every change must be tested. During development, run only the tests related to the modified code. Before finishing, always run the full test suite to ensure nothing is broken.

## Scope Limits

- Work on **one feature, fix, or refactoring at a time** — do not mix scopes
- Do not include cosmetic changes (formatting, renaming) alongside functional changes
- If something out of scope comes up during work, note it as a separate task instead of acting on it
- Focus on the defined scope for each task to ensure clarity and maintainability of the codebase.
- If you identify a necessary change that is out of scope, create a new issue or task for it instead of including it in the current work.

## Agent Skill Usage

When working on any task (planning, implementing, debugging, refactoring, 
reviewing, etc.), decompose the request into its underlying subtasks and 
concerns, then identify which available skills match any of them and activate 
those skills.

## Library Documentation Lookup

Before implementing any feature, you MUST use the **context7** MCP tool to look up the relevant library APIs and official documentation.

Always:

- Check the installed library version in the project manifest
- Retrieve the corresponding documentation using context7
- Cross-reference APIs to avoid deprecated or incompatible patterns
- Follow the official documentation over training data

Skip documentation lookup only for trivial operations such as:

- Variable declarations
- Basic control flow
- Simple CRUD using established project patterns

If a library is involved and there is uncertainty, documentation lookup is mandatory.
If the documentation returned does not match the installed version, flag the discrepancy before proceeding.