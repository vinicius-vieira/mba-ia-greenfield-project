import { DataSource, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import {
  buildVideo,
  createUserWithChannel,
  createVideo,
} from '../../test/video-factory';
import { MAX_VIDEO_SIZE_BYTES } from '../videos.constants';
import { Video, VideoStatus } from './video.entity';

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channel: Channel;

  beforeAll(async () => {
    dataSource = createTestDataSource([Video]);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    ({ channel } = await createUserWithChannel(dataSource));
  });

  it('should default status to draft and leave processing fields null', async () => {
    const video = buildVideo(channel.id);
    delete (video as Partial<Video>).status;
    await videoRepository.insert(video);

    const saved = await videoRepository.findOneByOrFail({ id: video.id });

    expect(saved.status).toBe(VideoStatus.DRAFT);
    expect(saved.thumbnail_key).toBeNull();
    expect(saved.duration).toBeNull();
    expect(saved.metadata).toBeNull();
    expect(saved.failure_reason).toBeNull();
    expect(saved.processed_at).toBeNull();
    expect(saved.created_at).toBeInstanceOf(Date);
    expect(saved.updated_at).toBeInstanceOf(Date);
  });

  it('should reject a duplicate public_id', async () => {
    const first = await createVideo(dataSource, channel.id);

    await expect(
      createVideo(dataSource, channel.id, { public_id: first.public_id }),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('should reject a status outside the enum', async () => {
    const video = await createVideo(dataSource, channel.id);

    await expect(
      dataSource.query(
        `UPDATE "videos" SET "status" = 'published' WHERE "id" = $1`,
        [video.id],
      ),
    ).rejects.toThrow(/invalid input value for enum/);
  });

  it('should exclude upload_id from default selects', async () => {
    const video = await createVideo(dataSource, channel.id, {
      upload_id: 'multipart-upload-id',
    });

    const byDefault = await videoRepository.findOneByOrFail({ id: video.id });
    const explicit = await videoRepository
      .createQueryBuilder('video')
      .addSelect('video.upload_id')
      .where('video.id = :id', { id: video.id })
      .getOneOrFail();

    expect(byDefault.upload_id).toBeUndefined();
    expect(explicit.upload_id).toBe('multipart-upload-id');
  });

  it('should round-trip a 10GB size as a number', async () => {
    const video = await createVideo(dataSource, channel.id, {
      size: MAX_VIDEO_SIZE_BYTES,
    });

    const saved = await videoRepository.findOneByOrFail({ id: video.id });

    expect(saved.size).toBe(10737418240);
  });

  it('should store metadata as structured JSON', async () => {
    const metadata = {
      width: 1920,
      height: 1080,
      video_codec: 'h264',
      audio_codec: null,
      bitrate: 4_500_000,
      frame_rate: 29.97,
      container_format: 'mov,mp4,m4a,3gp,3g2,mj2',
    };
    const video = await createVideo(dataSource, channel.id, {
      status: VideoStatus.READY,
      duration: 12.5,
      metadata,
    });

    const saved = await videoRepository.findOneByOrFail({ id: video.id });

    expect(saved.metadata).toEqual(metadata);
    expect(saved.duration).toBe(12.5);
  });

  it('should load the owning channel and list videos from the channel side', async () => {
    const video = await createVideo(dataSource, channel.id);

    const withChannel = await videoRepository.findOneOrFail({
      where: { id: video.id },
      relations: ['channel'],
    });
    const withVideos = await dataSource.getRepository(Channel).findOneOrFail({
      where: { id: channel.id },
      relations: ['videos'],
    });

    expect(withChannel.channel.id).toBe(channel.id);
    expect(withVideos.videos.map((v) => v.id)).toEqual([video.id]);
  });

  it('should require an existing channel', async () => {
    await expect(
      createVideo(dataSource, '00000000-0000-4000-8000-000000000000'),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('should delete videos when their channel is deleted', async () => {
    const video = await createVideo(dataSource, channel.id);

    await dataSource.query('DELETE FROM "channels" WHERE "id" = $1', [
      channel.id,
    ]);

    await expect(
      videoRepository.findOneBy({ id: video.id }),
    ).resolves.toBeNull();
  });
});
