---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-10-07T00:41:06-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-07T01:27:40-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-07T00:41:06-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-10-07T00:41:06-03:00"
  docs/phases/phase-02-auth/context.md: "2026-10-07T00:41:06-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-07T01:41:15-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-10-07T02:01:12-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Edição das informações do vídeo, categorias, visibilidade (público/unlisted), fluxo de rascunho → publicação e painel do canal (Fase 04); player, página de visualização, contagem de visualizações e sugestões (Fase 05); interações sociais (Fase 06); home e busca (Fase 07).

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — the video UI is not part of this phase; the phase is delivered as API + worker + infrastructure.

**Sequencing notes:** Depends on Fase 01 — Configuração Base do Projeto and Fase 02 — Cadastro, Login e Gerenciamento de Conta. `docs/project-plan.md` § Pontos de Atenção applies: large uploads must not block the system and must be resumable after a connection failure; video processing runs in the background; each video needs a short unique URL; playback must start without downloading the whole file.

**Neighbors (for boundary detection only):**

- **Fase 02 (prior):** Cadastro, Login e Gerenciamento de Conta — users, channels (one channel per user), JWT session.
- **Fase 04 (next):** Gerenciamento de Vídeos e Canal — video editing (title, description, category, custom thumbnail), visibility, draft → publication flow, channel panel and public page.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Queue Technology | decided | A (BullMQ on Redis) | `@nestjs/bullmq@^11.0.5`, `bullmq@^6.3.x` |
| phase-03-videos/TD-02 | phase | Cross-layer | Large-File Upload Strategy | decided | A (S3 multipart upload with presigned part URLs) | — |
| └─ Last revision: 2026-10-07 — Draft ownership | | | | | | |
| phase-03-videos/TD-03 | phase | Backend | Object Storage Client and Bucket/Key Organization | decided | A (AWS SDK v3, single private bucket with key prefixes) | `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x` |
| └─ Last revision: 2026-10-07 — Testing strategy | | | | | | |
| phase-03-videos/TD-04 | phase | Backend | Worker Runtime and Media Extraction | decided | A (Separate worker container, same codebase, FFmpeg CLI over presigned URL) | — |
| phase-03-videos/TD-05 | phase | Backend | Unique Video URL Identifier | decided | A (Random 11-character URL-safe ID with unique index) | — |
| phase-03-videos/TD-06 | phase | Cross-layer | Streaming and Download Delivery | decided | A (302 redirect to presigned GET URL) | — |
| └─ Last revision: 2026-10-07 — Access policy for this phase | | | | | | |
| phase-03-videos/TD-07 | phase | Backend | Video Status Lifecycle and Processing Failure Policy | decided | A (`draft → processing → ready \| failed` with bounded retries) | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-02, phase-03-videos/TD-07 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04, phase-03-videos/TD-07 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-04 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-05 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-06 |
| Download do vídeo pelo usuário | phase-03-videos/TD-06 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** Option A (BullMQ on Redis) — it is the only option with a first-party NestJS 11 integration that gives retries, backoff, deduplication and inspectable job state out of the box, which is exactly what one long-running "process video" job needs; Redis is a small, well-understood addition to `compose.yaml`, while RabbitMQ would require hand-building the retry/state machinery and pg-boss would break the "queue as its own container" architecture and the CommonJS build.

**Libraries:** `@nestjs/bullmq@^11.0.5`, `bullmq@^6.3.x`

### phase-03-videos/TD-02

**Recommendation:** Option A (S3 multipart with presigned part URLs) — it is the only option where the API never carries file bytes, which is the literal requirement ("sem impacto na performance"), and per-part retry plus a "list uploaded parts" call satisfies the resume attention point without introducing a tus server. Parameters: maximum declared size 10GB (`10 * 1024^3` bytes) validated at initiate; fixed part size of 16MB (640 parts for 10GB, far below the 10,000-part cap); presigned part URLs valid for 1 hour and issued in batches of at most 100 part numbers; the video row is created with status `draft` in the same initiate call, with the title taken from the request or defaulting to the file name without extension; completion is the only trigger for processing (depends on TD-01 and TD-07).

**Libraries:** —

**Revisions:**
- 2026-10-07 — Draft ownership: the draft video is owned by the authenticated user's channel, resolved through a channel-by-user lookup added to `ChannelsService` in this phase (the channels module owns the lookup; the videos module consumes it). Rationale: DG-1 — Phase 02 exposes only channel creation and the JWT payload carries `{ sub, email }`.

### phase-03-videos/TD-03

**Recommendation:** Option A (AWS SDK v3, single private bucket) — the project's stated production target is S3, so the official SDK keeps MinIO strictly a local stand-in, and a single private bucket avoids deciding public exposure before Fase 04 defines visibility. Canonical environment keys: `STORAGE_ENDPOINT` (internal URL, Compose service name), `STORAGE_PUBLIC_ENDPOINT` (URL used when signing links handed to clients), `STORAGE_REGION`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_BUCKET`. The bucket is created by the application at startup when missing, so no extra provisioning container is needed.

**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

**Revisions:**
- 2026-10-07 — Testing strategy: storage code is tested against the real S3-compatible service in Compose (MinIO), with no filesystem adapter; the "Object Storage" strategy in the `testing-guide-nestjs-project` skill is updated in this phase. Rationale: IC-1 — presigned URLs and multipart uploads cannot be exercised by a filesystem adapter.

### phase-03-videos/TD-04

**Recommendation:** Option A (separate container, same codebase, FFmpeg CLI over presigned URL) — it honours the diagram's worker container without forking the codebase, avoids both the deprecated wrapper and a 10GB scratch download, and keeps the extraction to two short CLI calls. Extracted metadata: `duration` (seconds), `width`, `height`, `video_codec`, `audio_codec`, `bitrate`, `frame_rate`, `container_format` from `ffprobe -show_format -show_streams`; an object with no video stream is treated as an unrecoverable processing failure (see TD-07). Thumbnail: one JPEG frame taken at 10% of the duration (capped at 10 seconds), scaled to a maximum width of 1280px.

**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** Option A (random 11-character URL-safe ID with a unique index) — it satisfies "short" and "never conflicts" with zero dependencies, and non-enumerability matters because Fase 04 introduces unlisted videos that are reachable only by link. The retry reuses the pre-check + unique-violation pattern already established by `ChannelsService` for nicknames.

**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** Option A (302 redirect to a presigned GET URL) — it delivers real `206 Partial Content` streaming and download without routing media through the API, consistent with TD-02 and with the diagram's `Frontend → Object Storage` stream; HLS is out of the phase's stated capabilities. Parameters: presigned playback/download URLs valid for 1 hour; playback and download are available only when the video status is `ready` (TD-07); the same redirect approach serves the thumbnail.

**Libraries:** —

**Revisions:**
- 2026-10-07 — Access policy for this phase: video details, playback, download and thumbnail of a `ready` video are public by link (anyone holding the unique URL; no listing endpoint exists); upload operations and reading a video that is not `ready` are restricted to the owning channel. Visibility rules arrive in Fase 04. Rationale: AMB-1 — the capabilities do not state who may reach playback/download.

### phase-03-videos/TD-07

**Recommendation:** Option A (`draft → processing → ready | failed` with bounded retries) — it is the smallest state machine that covers the phase and makes failure observable. Policy: the processing job is enqueued with the video ID as job ID (a repeated completion cannot enqueue twice), 3 attempts with exponential backoff starting at 5 seconds; after the last failed attempt, or immediately for an invalid media file, the worker sets `failed` and stores the reason; completing an upload is only accepted from `draft`, and aborting an upload deletes the draft row. Stale drafts (abandoned uploads) are left as-is in this phase.

**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.

**Libraries:** `@nestjs/throttler@^6.x`

### openapi-docs-nestjs/TD-01

**Recommendation:** Option A (`@nestjs/swagger`) — é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo.

**Libraries:** @nestjs/swagger

### openapi-docs-nestjs/TD-02

**Recommendation:** Option C (Ambos) — o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam.

**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- `TypeOrmModule.forRootAsync` with `autoLoadEntities: true`, `synchronize: false`; schema changes go through versioned migrations in `src/database/migrations/`. _(from phase 01)_
- All services run in Docker Compose (`nestjs-project/compose.yaml`); hosts are always Compose service names (e.g., `db`, `mailpit`), never `localhost`. _(from phase 01)_
- Error responses use the envelope `{ statusCode, error, message }`; services throw `DomainException` subclasses (`src/common/exceptions/domain.exception.ts`) mapped by `DomainExceptionFilter`; validation errors use `error: "VALIDATION_ERROR"`. _(from phase 02)_
- Global `ValidationPipe` with `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`; request DTOs use `class-validator` decorators. _(from phase 02)_
- `JwtAuthGuard` is registered globally as `APP_GUARD`; endpoints are protected by default and public ones opt out with `@Public()`; the authenticated user is read with `@CurrentUser()` as `JwtPayload { sub, email }`. _(from phase 02)_
- `ThrottlerGuard` is global (10 req/min per IP); E2E suites clear `ThrottlerStorage` in `beforeEach`. _(from phase 02)_
- Each user owns exactly one channel (`channels.user_id` unique FK → `users.id`), created at registration by `ChannelsService`. _(from phase 02)_
- Entities use `@Entity('table_name')`, UUID primary keys, snake_case column properties, `@CreateDateColumn`/`@UpdateDateColumn`; every entity is registered in its owning module's `TypeOrmModule.forFeature`. _(from phase 02)_
- Tests: `*.spec.ts` (unit), `*.integration-spec.ts` (real DB/services, next to source), `test/*.e2e-spec.ts` (supertest, reproducing `main.ts` global pipes/filters); suites share one database and run with `--runInBand`; the migration runner test imports migration classes explicitly and restores the schema in `afterAll`. _(from phase 02)_
- Every controller is documented with `@nestjs/swagger` decorators (`@ApiTags`, `@ApiOperation`, `@ApiResponse` per status, `ApiErrorEnvelope` for errors, `@ApiBearerAuth('access-token')` on protected handlers) and the exported `nestjs-project/openapi.json` is the committed contract artifact. _(from task openapi-docs-nestjs)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |

## UI Inventory

_No screen inventory — UI↔API sync deferred. Run /screen-inventory 03 and then rerun /plan-context 03 to activate UI checks._

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

_(from `testing-guide-nestjs-project` — § 3 Feature Implementation Checklist, `artifacts/future-types.md` and `references/external-systems.md`)_

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Queue consumer / processor with business logic | Unit (mock deps) + Integration (real DB/storage); test the `process` method directly |
| Queue publisher | Integration against the real broker in Docker: assert the job is enqueued with the correct data; isolate with dedicated test queues or clean queues between tests |

External-system strategies recorded in the guide: PostgreSQL — real (Docker `db`); Message Queue — real broker in Docker ("technology TBD"); Email — Mailpit; Object Storage — "Local filesystem storage in development and tests. S3 in production", behind a storage abstraction.

### next-frontend

_Deferred subproject — not in scope for this phase._
