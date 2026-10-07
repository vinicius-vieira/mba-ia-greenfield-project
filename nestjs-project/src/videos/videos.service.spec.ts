import { QueryFailedError } from 'typeorm';
import { ChannelNotFoundException } from '../common/exceptions/domain.exception';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';

const USER_ID = 'user-1';
const CHANNEL_ID = 'channel-1';

function uniqueViolation(column: string): QueryFailedError {
  const err = new QueryFailedError('INSERT', [], new Error('duplicate'));
  Object.assign(err, {
    code: '23505',
    detail: `Key (${column})=(x) already exists.`,
  });
  return err;
}

describe('VideosService', () => {
  let service: VideosService;
  let videoRepository: {
    existsBy: jest.Mock;
    create: jest.Mock;
    insert: jest.Mock;
  };
  let channelsService: { findByUserId: jest.Mock };
  let storageService: {
    createMultipartUpload: jest.Mock;
    abortMultipartUpload: jest.Mock;
  };

  beforeEach(() => {
    videoRepository = {
      existsBy: jest.fn().mockResolvedValue(false),
      create: jest.fn((fields: Partial<Video>) =>
        Object.assign(new Video(), fields),
      ),
      insert: jest.fn().mockResolvedValue(undefined),
    };
    channelsService = {
      findByUserId: jest.fn().mockResolvedValue({ id: CHANNEL_ID }),
    };
    storageService = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    };
    service = new VideosService(
      videoRepository as never,
      channelsService as never,
      storageService as never,
    );
  });

  describe('initiateUpload', () => {
    const dto = {
      filename: 'my holiday.final.mp4',
      content_type: 'video/mp4',
      size: 1024,
    };

    it('should create a draft owned by the caller channel and open the multipart upload', async () => {
      const result = await service.initiateUpload(USER_ID, dto);

      const inserted = videoRepository.insert.mock.calls[0][0] as Video;
      expect(channelsService.findByUserId).toHaveBeenCalledWith(USER_ID);
      expect(inserted.channel_id).toBe(CHANNEL_ID);
      expect(inserted.status).toBe(VideoStatus.DRAFT);
      expect(inserted.storage_key).toBe(`videos/${inserted.id}/original`);
      expect(inserted.upload_id).toBe('upload-1');
      expect(storageService.createMultipartUpload).toHaveBeenCalledWith(
        inserted.storage_key,
        'video/mp4',
      );
      expect(result).toEqual({
        id: inserted.id,
        public_id: inserted.public_id,
        title: 'my holiday.final',
        status: VideoStatus.DRAFT,
        upload: { part_size: 16777216, part_count: 1 },
      });
    });

    it('should keep the title given by the client', async () => {
      const result = await service.initiateUpload(USER_ID, {
        ...dto,
        title: 'Holiday 2026',
      });

      expect(result.title).toBe('Holiday 2026');
    });

    it('should fall back to the file name when it has no base name', async () => {
      const result = await service.initiateUpload(USER_ID, {
        ...dto,
        filename: '.mp4',
      });

      expect(result.title).toBe('.mp4');
    });

    it.each([
      [1, 1],
      [16777216, 1],
      [16777217, 2],
      [10737418240, 640],
    ])('should plan %d bytes as %d part(s)', async (size, partCount) => {
      const result = await service.initiateUpload(USER_ID, { ...dto, size });

      expect(result.upload.part_count).toBe(partCount);
    });

    it('should generate another public id when the first one is taken', async () => {
      videoRepository.existsBy
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      const result = await service.initiateUpload(USER_ID, dto);

      const [first, second] = videoRepository.existsBy.mock.calls.map(
        ([where]) => (where as { public_id: string }).public_id,
      );
      expect(first).not.toBe(second);
      expect(result.public_id).toBe(second);
      expect(videoRepository.insert).toHaveBeenCalledTimes(1);
    });

    it('should retry when a concurrent insert takes the public id', async () => {
      videoRepository.insert
        .mockRejectedValueOnce(uniqueViolation('public_id'))
        .mockResolvedValueOnce(undefined);

      const result = await service.initiateUpload(USER_ID, dto);

      expect(videoRepository.insert).toHaveBeenCalledTimes(2);
      expect(result.public_id).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
    });

    it('should give up after repeated public id collisions and abort the upload', async () => {
      videoRepository.existsBy.mockResolvedValue(true);

      await expect(service.initiateUpload(USER_ID, dto)).rejects.toThrow(
        'Could not allocate a unique video public id',
      );
      expect(videoRepository.insert).not.toHaveBeenCalled();
      expect(storageService.abortMultipartUpload).toHaveBeenCalledTimes(1);
    });

    it('should abort the multipart upload when the insert fails', async () => {
      const failure = new Error('connection lost');
      videoRepository.insert.mockRejectedValue(failure);

      await expect(service.initiateUpload(USER_ID, dto)).rejects.toBe(failure);

      const [key, uploadId] = storageService.abortMultipartUpload.mock.calls[0];
      expect(key).toMatch(/^videos\/.+\/original$/);
      expect(uploadId).toBe('upload-1');
    });

    it('should not touch the storage when the user has no channel', async () => {
      channelsService.findByUserId.mockRejectedValue(
        new ChannelNotFoundException(),
      );

      await expect(service.initiateUpload(USER_ID, dto)).rejects.toBeInstanceOf(
        ChannelNotFoundException,
      );
      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    });
  });
});
