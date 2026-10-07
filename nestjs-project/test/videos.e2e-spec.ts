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
});
