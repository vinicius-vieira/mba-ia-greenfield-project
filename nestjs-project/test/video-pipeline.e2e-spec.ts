import { readFile } from 'node:fs/promises';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { MailService } from '../src/mail/mail.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { useInternalStorageEndpoint } from '../src/test/storage-test-env';
import { generateSampleVideo, SampleVideo } from '../src/test/video-fixture';
import { createE2eApp } from './helpers/video-e2e';

const PROCESSING_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 500;
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

/**
 * The whole phase against the running Compose stack. Unlike the other video
 * suites this one keeps the default QUEUE_PREFIX, so the job published by the
 * API is consumed by the real `video-worker` container (FFmpeg included).
 * Requires `docker compose up -d` with the worker running.
 */
describe('Video pipeline through the real worker (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let authorization: string;
  let sample: SampleVideo;

  /** Real account lifecycle: register → confirm (token from the mail) → login. */
  async function registerConfirmAndLogin(email: string): Promise<string> {
    const password = 'password123';
    const mailService = app.get(MailService);
    let confirmationToken = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_to: string, _name: string, t: string) => {
        confirmationToken = t;
      });
    const server = app.getHttpServer();
    await request(server)
      .post('/auth/register')
      .send({ email, password })
      .expect(201);
    await request(server)
      .get('/auth/confirm-email')
      .query({ token: confirmationToken })
      .expect(204);
    const login = await request(server)
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    return `Bearer ${login.body.access_token}`;
  }

  /** Initiate → PUT the bytes to the storage → complete. Returns the ids. */
  async function upload(
    bytes: Buffer,
    filename: string,
  ): Promise<{ id: string; publicId: string }> {
    const server = app.getHttpServer();
    const created = await request(server)
      .post('/videos')
      .set('Authorization', authorization)
      .send({ filename, content_type: 'video/mp4', size: bytes.length })
      .expect(201);
    const id = created.body.id as string;

    const urls = await request(server)
      .post(`/videos/${id}/upload/part-urls`)
      .set('Authorization', authorization)
      .send({ part_numbers: [1] })
      .expect(200);
    const put = await fetch(urls.body.urls[0].url, {
      method: 'PUT',
      body: new Uint8Array(bytes),
    });
    expect(put.status).toBe(200);

    await request(server)
      .post(`/videos/${id}/upload/complete`)
      .set('Authorization', authorization)
      .send({ parts: [{ part_number: 1, etag: put.headers.get('etag') }] })
      .expect(200);
    return { id, publicId: created.body.public_id as string };
  }

  /** Polls the owner's state endpoint until the worker settles the video. */
  async function waitUntilProcessed(
    id: string,
  ): Promise<{ status: string; failure_reason: string | null }> {
    const deadline = Date.now() + PROCESSING_TIMEOUT_MS;
    let last = 'unknown';
    while (Date.now() < deadline) {
      const res = await request(app.getHttpServer())
        .get(`/videos/${id}/upload`)
        .set('Authorization', authorization)
        .expect(200);
      last = res.body.status;
      if (last === 'ready' || last === 'failed') return res.body;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error(
      `Video ${id} still "${last}" after ${PROCESSING_TIMEOUT_MS}ms — is the video-worker container running (docker compose ps)?`,
    );
  }

  beforeAll(async () => {
    useInternalStorageEndpoint();
    ({ app, dataSource } = await createE2eApp());
    sample = await generateSampleVideo();
  }, 60_000);

  afterAll(async () => {
    await sample.cleanup();
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    authorization = await registerConfirmAndLogin('uploader@example.com');
  });

  it(
    'processes an uploaded video and serves details, streaming, download and thumbnail',
    async () => {
      const bytes = await readFile(sample.path);
      const server = app.getHttpServer();

      const { id, publicId } = await upload(bytes, 'holiday trip.mp4');
      const state = await waitUntilProcessed(id);

      expect(state).toMatchObject({ status: 'ready', failure_reason: null });

      // Unique URL → public details, no token.
      const details = await request(server)
        .get(`/videos/${publicId}`)
        .expect(200);
      expect(details.body.title).toBe('holiday trip');
      expect(details.body.duration).toBeCloseTo(2, 0);
      expect(details.body.metadata).toMatchObject({
        width: 320,
        height: 240,
        video_codec: 'h264',
        audio_codec: 'aac',
      });
      expect(details.body.channel.nickname).toBe('uploader');

      // Streaming: a byte range, not the whole file.
      const stream = await request(server)
        .get(`/videos/${publicId}/stream`)
        .expect(302);
      const ranged = await fetch(stream.headers.location, {
        headers: { Range: 'bytes=0-99' },
      });
      expect(ranged.status).toBe(206);
      expect(ranged.headers.get('content-range')).toBe(
        `bytes 0-99/${bytes.length}`,
      );
      expect(Buffer.from(await ranged.arrayBuffer())).toEqual(
        bytes.subarray(0, 100),
      );

      // Download: the original bytes, as an attachment.
      const download = await request(server)
        .get(`/videos/${publicId}/download`)
        .expect(302);
      const file = await fetch(download.headers.location);
      expect(file.headers.get('content-disposition')).toMatch(
        /^attachment; filename="holiday trip\.mp4"/,
      );
      expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes);

      // Thumbnail generated by FFmpeg in the worker container.
      const thumbnail = await request(server)
        .get(`/videos/${publicId}/thumbnail`)
        .expect(302);
      const image = await fetch(thumbnail.headers.location);
      expect(image.headers.get('content-type')).toBe('image/jpeg');
      const imageBytes = new Uint8Array(await image.arrayBuffer());
      expect(Array.from(imageBytes.subarray(0, 3))).toEqual(JPEG_MAGIC);
    },
    PROCESSING_TIMEOUT_MS + 30_000,
  );

  it(
    'marks a file that is not a video as failed, with a reason, and keeps it private',
    async () => {
      const notAVideo = Buffer.from(
        'plain text uploaded with a video content type\n'.repeat(200),
      );

      const { id, publicId } = await upload(notAVideo, 'notes.mp4');
      const state = await waitUntilProcessed(id);

      expect(state.status).toBe('failed');
      expect(state.failure_reason).toBe('File is not a valid video');
      await request(app.getHttpServer()).get(`/videos/${publicId}`).expect(404);
      await request(app.getHttpServer())
        .get(`/videos/${publicId}/stream`)
        .expect(404);
    },
    PROCESSING_TIMEOUT_MS + 30_000,
  );
});
