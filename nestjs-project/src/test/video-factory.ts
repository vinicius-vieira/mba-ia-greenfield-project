import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { videoOriginalKey } from '../storage/storage.constants';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { generateVideoPublicId } from '../videos/video-public-id.util';

let sequence = 0;

/** Persists a user with its channel, as registration would. */
export async function createUserWithChannel(
  dataSource: DataSource,
): Promise<{ user: User; channel: Channel }> {
  const n = `${process.pid}_${++sequence}`;
  const user = await dataSource.getRepository(User).save(
    dataSource.getRepository(User).create({
      email: `video_owner_${n}@example.com`,
      password: 'hashed',
      is_confirmed: true,
    }),
  );
  const channel = await dataSource.getRepository(Channel).save(
    dataSource.getRepository(Channel).create({
      name: `owner_${n}`,
      nickname: `owner_${n}`,
      user_id: user.id,
    }),
  );
  return { user, channel };
}

/** Builds (without saving) a draft video for the channel; override any field. */
export function buildVideo(
  channelId: string,
  overrides: Partial<Video> = {},
): Video {
  const id = overrides.id ?? randomUUID();
  return Object.assign(new Video(), {
    id,
    channel_id: channelId,
    public_id: generateVideoPublicId(),
    title: 'Sample clip',
    status: VideoStatus.DRAFT,
    original_filename: 'sample clip.mp4',
    content_type: 'video/mp4',
    size: 1024,
    storage_key: videoOriginalKey(id),
    upload_id: null,
    ...overrides,
  });
}

export async function createVideo(
  dataSource: DataSource,
  channelId: string,
  overrides: Partial<Video> = {},
): Promise<Video> {
  return dataSource.getRepository(Video).save(buildVideo(channelId, overrides));
}
