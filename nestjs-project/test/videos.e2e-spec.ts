import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { useIsolatedQueuePrefix } from '../src/test/queue-test-env';
import { useInternalStorageEndpoint } from '../src/test/storage-test-env';
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

  beforeAll(async () => {
    // Presigned URLs must be reachable from this container, and enqueued jobs
    // must not be taken by the running video-worker container.
    useInternalStorageEndpoint();
    useIsolatedQueuePrefix();
    ({ app, dataSource } = await createE2eApp());
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
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
});
