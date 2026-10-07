import { randomBytes } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { VIDEO_PROCESSING_QUEUE } from '../src/queue/queue.constants';
import { emptyQueue, useIsolatedQueuePrefix } from '../src/test/queue-test-env';
import { StorageService } from '../src/storage/storage.service';
import { useInternalStorageEndpoint } from '../src/test/storage-test-env';
import { createVideo } from '../src/test/video-factory';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import {
  AuthenticatedUser,
  createAuthenticatedUser,
  createE2eApp,
} from './helpers/video-e2e';

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let owner: AuthenticatedUser;
  let processingQueue: Queue;

  beforeAll(async () => {
    // Presigned URLs must be reachable from this container, and enqueued jobs
    // must not be taken by the running video-worker container.
    useInternalStorageEndpoint();
    useIsolatedQueuePrefix();
    ({ app, dataSource } = await createE2eApp());
    videoRepository = dataSource.getRepository(Video);
    processingQueue = app.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await emptyQueue(processingQueue);
    await app.close();
  });

  beforeEach(async () => {
    await emptyQueue(processingQueue);
    await cleanAllTables(dataSource);
    owner = await createAuthenticatedUser(app, dataSource);
  });

  const validBody = {
    filename: 'clip.mp4',
    content_type: 'video/mp4',
    size: 1048576,
  };

  describe('POST /videos', () => {
    it('returns 201 with the upload plan and pre-registers a draft', async () => {
      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', owner.authorization)
        .send(validBody)
        .expect(201);

      expect(res.body).toEqual({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        public_id: expect.stringMatching(/^[A-Za-z0-9_-]{11}$/),
        title: 'clip',
        status: 'draft',
        upload: { part_size: 16777216, part_count: 1 },
      });
      const saved = await videoRepository.findOneByOrFail({ id: res.body.id });
      expect(saved.status).toBe(VideoStatus.DRAFT);
      expect(saved.channel_id).toBe(owner.channel.id);
    });

    it('accepts exactly 10GB and plans 640 parts', async () => {
      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', owner.authorization)
        .send({ ...validBody, size: 10737418240 })
        .expect(201);

      expect(res.body.upload.part_count).toBe(640);
    });

    it('returns different public ids for successive uploads', async () => {
      const first = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', owner.authorization)
        .send(validBody)
        .expect(201);
      const second = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', owner.authorization)
        .send(validBody)
        .expect(201);

      expect(first.body.public_id).not.toBe(second.body.public_id);
    });

    it.each([
      ['a size above 10GB', { size: 10737418241 }],
      ['a non-video content type', { content_type: 'application/pdf' }],
      ['an unknown property', { visibility: 'public' }],
      ['an empty title', { title: '' }],
    ])('returns 400 VALIDATION_ERROR for %s', async (_label, override) => {
      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', owner.authorization)
        .send({ ...validBody, ...override })
        .expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
      expect(await videoRepository.count()).toBe(0);
    });

    it('returns 401 without an Authorization header', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send(validBody)
        .expect(401);
    });

    it('returns 404 CHANNEL_NOT_FOUND when the user has no channel', async () => {
      await dataSource.query('DELETE FROM "channels" WHERE "id" = $1', [
        owner.channel.id,
      ]);

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', owner.authorization)
        .send(validBody)
        .expect(404);

      expect(res.body.error).toBe('CHANNEL_NOT_FOUND');
    });
  });

  describe('owner upload endpoints', () => {
    const fileBytes = randomBytes(4096);
    const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

    async function initiate(size = fileBytes.length): Promise<string> {
      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', owner.authorization)
        .send({ ...validBody, size })
        .expect(201);
      return res.body.id as string;
    }

    async function uploadPart(
      videoId: string,
      bytes = fileBytes,
    ): Promise<string> {
      const res = await request(app.getHttpServer())
        .post(`/videos/${videoId}/upload/part-urls`)
        .set('Authorization', owner.authorization)
        .send({ part_numbers: [1] })
        .expect(200);
      const put = await fetch(res.body.urls[0].url, {
        method: 'PUT',
        body: new Uint8Array(bytes),
      });
      expect(put.status).toBe(200);
      return put.headers.get('etag') as string;
    }

    it('POST part-urls returns a presigned URL that accepts the part bytes', async () => {
      const videoId = await initiate();

      const res = await request(app.getHttpServer())
        .post(`/videos/${videoId}/upload/part-urls`)
        .set('Authorization', owner.authorization)
        .send({ part_numbers: [1] })
        .expect(200);

      expect(res.body).toEqual({
        urls: [{ part_number: 1, url: expect.stringMatching(/^http/) }],
        expires_in: 3600,
      });
      const put = await fetch(res.body.urls[0].url, {
        method: 'PUT',
        body: new Uint8Array(fileBytes),
      });
      expect(put.status).toBe(200);
      expect(put.headers.get('etag')).toBeTruthy();
    });

    it('GET parts lists what the storage already received', async () => {
      const videoId = await initiate();
      const etag = await uploadPart(videoId);

      const res = await request(app.getHttpServer())
        .get(`/videos/${videoId}/upload/parts`)
        .set('Authorization', owner.authorization)
        .expect(200);

      expect(res.body).toEqual({
        parts: [{ part_number: 1, etag, size: fileBytes.length }],
      });
    });

    it('GET upload returns the draft state to its owner', async () => {
      const videoId = await initiate();

      const res = await request(app.getHttpServer())
        .get(`/videos/${videoId}/upload`)
        .set('Authorization', owner.authorization)
        .expect(200);

      expect(res.body).toEqual({
        id: videoId,
        public_id: expect.stringMatching(/^[A-Za-z0-9_-]{11}$/),
        title: 'clip',
        status: 'draft',
        failure_reason: null,
        size: fileBytes.length,
        upload: { part_size: 16777216, part_count: 1 },
        created_at: expect.any(String),
      });
    });

    it('DELETE upload returns 204 and removes the draft', async () => {
      const videoId = await initiate();

      await request(app.getHttpServer())
        .delete(`/videos/${videoId}/upload`)
        .set('Authorization', owner.authorization)
        .expect(204);

      const res = await request(app.getHttpServer())
        .get(`/videos/${videoId}/upload`)
        .set('Authorization', owner.authorization)
        .expect(404);
      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('POST part-urls returns 400 INVALID_UPLOAD_PARTS above the part count', async () => {
      const videoId = await initiate();

      const res = await request(app.getHttpServer())
        .post(`/videos/${videoId}/upload/part-urls`)
        .set('Authorization', owner.authorization)
        .send({ part_numbers: [2] })
        .expect(400);

      expect(res.body.error).toBe('INVALID_UPLOAD_PARTS');
    });

    it.each([
      [
        '101 part numbers',
        { part_numbers: Array.from({ length: 101 }, (_, i) => i + 1) },
      ],
      ['an empty list', { part_numbers: [] }],
      ['a part number of zero', { part_numbers: [0] }],
      ['duplicated part numbers', { part_numbers: [1, 1] }],
    ])(
      'POST part-urls returns 400 VALIDATION_ERROR for %s',
      async (_label, body) => {
        const videoId = await initiate();

        const res = await request(app.getHttpServer())
          .post(`/videos/${videoId}/upload/part-urls`)
          .set('Authorization', owner.authorization)
          .send(body)
          .expect(400);

        expect(res.body.error).toBe('VALIDATION_ERROR');
      },
    );

    const ownerRoutes: [
      'get' | 'post' | 'delete',
      string,
      object | undefined,
    ][] = [
      ['get', 'upload', undefined],
      ['post', 'upload/part-urls', { part_numbers: [1] }],
      ['get', 'upload/parts', undefined],
      ['delete', 'upload', undefined],
    ];

    describe.each(ownerRoutes)('%s /videos/:id/%s', (method, path, body) => {
      function call(videoId: string, authorization?: string) {
        const req = request(app.getHttpServer())[method](
          `/videos/${videoId}/${path}`,
        );
        if (authorization) void req.set('Authorization', authorization);
        return body ? req.send(body) : req;
      }

      it('returns 401 without a token', async () => {
        await call(await initiate()).expect(401);
      });

      it('returns 403 VIDEO_NOT_OWNED for another user', async () => {
        const videoId = await initiate();
        const other = await createAuthenticatedUser(app, dataSource);

        const res = await call(videoId, other.authorization).expect(403);

        expect(res.body.error).toBe('VIDEO_NOT_OWNED');
        expect(await videoRepository.countBy({ id: videoId })).toBe(1);
      });

      it('returns 404 VIDEO_NOT_FOUND for an unknown id', async () => {
        const res = await call(UNKNOWN_ID, owner.authorization).expect(404);

        expect(res.body.error).toBe('VIDEO_NOT_FOUND');
      });

      it('returns 400 for an id that is not a uuid', async () => {
        const res = await call('not-a-uuid', owner.authorization).expect(400);

        expect(res.body.error).toBe('VALIDATION_ERROR');
      });
    });
  });

  describe('POST /videos/:id/upload/complete', () => {
    const fileBytes = randomBytes(4096);

    async function initiateAndUpload(
      uploaded: Buffer = fileBytes,
    ): Promise<{ videoId: string; etag: string }> {
      const created = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', owner.authorization)
        .send({ ...validBody, size: fileBytes.length })
        .expect(201);
      const videoId = created.body.id as string;
      const urls = await request(app.getHttpServer())
        .post(`/videos/${videoId}/upload/part-urls`)
        .set('Authorization', owner.authorization)
        .send({ part_numbers: [1] })
        .expect(200);
      const put = await fetch(urls.body.urls[0].url, {
        method: 'PUT',
        body: new Uint8Array(uploaded),
      });
      return { videoId, etag: put.headers.get('etag') as string };
    }

    function complete(videoId: string, body: object) {
      return request(app.getHttpServer())
        .post(`/videos/${videoId}/upload/complete`)
        .set('Authorization', owner.authorization)
        .send(body);
    }

    it('returns 200, moves the video to processing and publishes the job', async () => {
      const { videoId, etag } = await initiateAndUpload();

      const res = await complete(videoId, {
        parts: [{ part_number: 1, etag }],
      }).expect(200);

      expect(res.body).toEqual({
        id: videoId,
        public_id: expect.stringMatching(/^[A-Za-z0-9_-]{11}$/),
        status: 'processing',
      });
      const state = await request(app.getHttpServer())
        .get(`/videos/${videoId}/upload`)
        .set('Authorization', owner.authorization)
        .expect(200);
      expect(state.body.status).toBe('processing');
      const job = await processingQueue.getJob(videoId);
      expect(job?.data).toEqual({ videoId });
    });

    it('returns 409 on a second completion and does not publish again', async () => {
      const { videoId, etag } = await initiateAndUpload();
      const body = { parts: [{ part_number: 1, etag }] };
      await complete(videoId, body).expect(200);

      const res = await complete(videoId, body).expect(409);

      expect(res.body.error).toBe('VIDEO_UPLOAD_NOT_IN_PROGRESS');
      expect(await processingQueue.getJobCounts('waiting')).toEqual({
        waiting: 1,
      });
    });

    it('returns 409 for part URLs, part listing and abort once processing started', async () => {
      const { videoId, etag } = await initiateAndUpload();
      await complete(videoId, { parts: [{ part_number: 1, etag }] }).expect(
        200,
      );
      const server = app.getHttpServer();

      const responses = await Promise.all([
        request(server)
          .post(`/videos/${videoId}/upload/part-urls`)
          .set('Authorization', owner.authorization)
          .send({ part_numbers: [1] }),
        request(server)
          .get(`/videos/${videoId}/upload/parts`)
          .set('Authorization', owner.authorization),
        request(server)
          .delete(`/videos/${videoId}/upload`)
          .set('Authorization', owner.authorization),
      ]);

      for (const res of responses) {
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('VIDEO_UPLOAD_NOT_IN_PROGRESS');
      }
    });

    it('returns 400 INVALID_UPLOAD_PARTS for an ETag the storage does not know', async () => {
      const { videoId } = await initiateAndUpload();

      const res = await complete(videoId, {
        parts: [{ part_number: 1, etag: '"00000000000000000000000000000000"' }],
      }).expect(400);

      expect(res.body.error).toBe('INVALID_UPLOAD_PARTS');
      const saved = await videoRepository.findOneByOrFail({ id: videoId });
      expect(saved.status).toBe(VideoStatus.DRAFT);
    });

    it('returns 400 UPLOAD_SIZE_MISMATCH and discards the draft when bytes are missing', async () => {
      const { videoId, etag } = await initiateAndUpload(randomBytes(100));

      const res = await complete(videoId, {
        parts: [{ part_number: 1, etag }],
      }).expect(400);

      expect(res.body.error).toBe('UPLOAD_SIZE_MISMATCH');
      await request(app.getHttpServer())
        .get(`/videos/${videoId}/upload`)
        .set('Authorization', owner.authorization)
        .expect(404);
    });

    it.each([
      ['no parts', { parts: [] }],
      ['a part without etag', { parts: [{ part_number: 1 }] }],
      [
        'a non-integer part number',
        { parts: [{ part_number: 'one', etag: '"a"' }] },
      ],
      [
        'an unknown property inside a part',
        { parts: [{ part_number: 1, etag: '"a"', size: 1 }] },
      ],
    ])('returns 400 VALIDATION_ERROR for %s', async (_label, body) => {
      const { videoId } = await initiateAndUpload();

      const res = await complete(videoId, body).expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('returns 403 VIDEO_NOT_OWNED for another user', async () => {
      const { videoId, etag } = await initiateAndUpload();
      const other = await createAuthenticatedUser(app, dataSource);

      const res = await request(app.getHttpServer())
        .post(`/videos/${videoId}/upload/complete`)
        .set('Authorization', other.authorization)
        .send({ parts: [{ part_number: 1, etag }] })
        .expect(403);

      expect(res.body.error).toBe('VIDEO_NOT_OWNED');
    });
  });

  describe('public video endpoints', () => {
    const body = Buffer.from('0123456789'.repeat(50));
    const thumbnail = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    let storage: StorageService;

    beforeAll(() => {
      storage = app.get(StorageService);
    });

    async function givenVideo(status: VideoStatus): Promise<Video> {
      const video = await createVideo(dataSource, owner.channel.id, {
        status,
        size: body.length,
        original_filename: 'my clip.mp4',
        duration: 2,
        metadata: {
          width: 320,
          height: 240,
          video_codec: 'h264',
          audio_codec: 'aac',
          bitrate: 1000,
          frame_rate: 10,
          container_format: 'mov,mp4',
        },
      });
      await storage.putObject(video.storage_key, body, 'video/mp4');
      const thumbnailKey = `videos/${video.id}/thumbnail.jpg`;
      await storage.putObject(thumbnailKey, thumbnail, 'image/jpeg');
      await videoRepository.update(
        { id: video.id },
        { thumbnail_key: thumbnailKey },
      );
      return video;
    }

    it('GET /videos/:publicId returns public details without a token', async () => {
      const video = await givenVideo(VideoStatus.READY);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}`)
        .expect(200);

      expect(res.body).toEqual({
        public_id: video.public_id,
        title: 'Sample clip',
        duration: 2,
        metadata: {
          width: 320,
          height: 240,
          video_codec: 'h264',
          audio_codec: 'aac',
          bitrate: 1000,
          frame_rate: 10,
          container_format: 'mov,mp4',
        },
        size: body.length,
        channel: {
          nickname: owner.channel.nickname,
          name: owner.channel.name,
        },
        created_at: expect.any(String),
      });
    });

    it('GET stream redirects to a storage URL that serves byte ranges', async () => {
      const video = await givenVideo(VideoStatus.READY);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/stream`)
        .expect(302);
      const ranged = await fetch(res.headers.location, {
        headers: { Range: 'bytes=0-99' },
      });

      expect(new URL(res.headers.location).host).toBe(
        new URL(process.env.STORAGE_ENDPOINT as string).host,
      );
      expect(ranged.status).toBe(206);
      expect(ranged.headers.get('content-range')).toBe(
        `bytes 0-99/${body.length}`,
      );
      expect((await ranged.arrayBuffer()).byteLength).toBe(100);
    });

    it('GET download redirects to a storage URL served as an attachment', async () => {
      const video = await givenVideo(VideoStatus.READY);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/download`)
        .expect(302);
      const file = await fetch(res.headers.location);

      expect(file.status).toBe(200);
      expect(file.headers.get('content-disposition')).toMatch(
        /^attachment; filename="my clip\.mp4"/,
      );
      expect(Buffer.from(await file.arrayBuffer())).toEqual(body);
    });

    it('GET thumbnail redirects to the stored JPEG', async () => {
      const video = await givenVideo(VideoStatus.READY);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/thumbnail`)
        .expect(302);
      const image = await fetch(res.headers.location);

      expect(image.status).toBe(200);
      expect(image.headers.get('content-type')).toBe('image/jpeg');
    });

    describe.each(['', '/stream', '/download', '/thumbnail'])(
      'GET /videos/:publicId%s',
      (suffix) => {
        it.each([
          VideoStatus.DRAFT,
          VideoStatus.PROCESSING,
          VideoStatus.FAILED,
        ])('returns 404 VIDEO_NOT_FOUND for a %s video', async (status) => {
          const video = await givenVideo(status);

          const res = await request(app.getHttpServer())
            .get(`/videos/${video.public_id}${suffix}`)
            .expect(404);

          expect(res.body.error).toBe('VIDEO_NOT_FOUND');
        });

        it('returns 404 VIDEO_NOT_FOUND for an unknown public id', async () => {
          const res = await request(app.getHttpServer())
            .get(`/videos/AAAAAAAAAAA${suffix}`)
            .expect(404);

          expect(res.body.error).toBe('VIDEO_NOT_FOUND');
        });
      },
    );
  });
});
