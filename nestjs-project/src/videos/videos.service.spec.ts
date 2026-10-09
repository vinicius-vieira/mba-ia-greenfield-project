import { QueryFailedError } from 'typeorm';
import {
  ChannelNotFoundException,
  InvalidUploadPartsException,
  UploadSizeMismatchException,
  VideoNotFoundException,
  VideoNotOwnedException,
  VideoUploadNotInProgressException,
} from '../common/exceptions/domain.exception';
import { InvalidMultipartPartsError } from '../storage/storage.errors';
import { buildVideo } from '../test/video-factory';
import { Video, VideoStatus } from './entities/video.entity';
import { attachmentDisposition, VideosService } from './videos.service';

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
    findOne: jest.Mock;
    delete: jest.Mock;
    update: jest.Mock;
  };
  let channelsService: { findByUserId: jest.Mock };
  let storageService: {
    createMultipartUpload: jest.Mock;
    abortMultipartUpload: jest.Mock;
    presignUploadPart: jest.Mock;
    listParts: jest.Mock;
    deleteObject: jest.Mock;
    completeMultipartUpload: jest.Mock;
    headObject: jest.Mock;
    presignGetObject: jest.Mock;
  };
  let processingQueue: { add: jest.Mock };

  beforeEach(() => {
    videoRepository = {
      existsBy: jest.fn().mockResolvedValue(false),
      create: jest.fn((fields: Partial<Video>) =>
        Object.assign(new Video(), fields),
      ),
      insert: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn().mockResolvedValue(null),
      delete: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    channelsService = {
      findByUserId: jest.fn().mockResolvedValue({ id: CHANNEL_ID }),
    };
    storageService = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      presignUploadPart: jest.fn(),
      listParts: jest.fn().mockResolvedValue([]),
      deleteObject: jest.fn().mockResolvedValue(undefined),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      headObject: jest.fn().mockResolvedValue(null),
      presignGetObject: jest.fn(),
    };
    processingQueue = { add: jest.fn().mockResolvedValue(undefined) };
    service = new VideosService(
      videoRepository as never,
      channelsService as never,
      storageService as never,
      processingQueue as never,
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

  describe('owner upload operations', () => {
    const VIDEO_ID = 'video-1';

    function givenVideo(
      overrides: Partial<Video> = {},
      uploadId: string | null = 'upload-1',
    ): Video {
      const video = buildVideo(CHANNEL_ID, {
        id: VIDEO_ID,
        size: 40_000_000,
        ...overrides,
      });
      videoRepository.findOne.mockImplementation(
        ({ select }: { select?: unknown }) =>
          Promise.resolve(
            select ? { id: VIDEO_ID, upload_id: uploadId } : video,
          ),
      );
      return video;
    }

    describe('getOwnedVideo', () => {
      it('should return the video when the caller channel owns it', async () => {
        const video = givenVideo();

        await expect(service.getOwnedVideo(USER_ID, VIDEO_ID)).resolves.toBe(
          video,
        );
      });

      it('should throw VideoNotFoundException for an unknown id', async () => {
        videoRepository.findOne.mockResolvedValue(null);

        await expect(
          service.getOwnedVideo(USER_ID, VIDEO_ID),
        ).rejects.toBeInstanceOf(VideoNotFoundException);
        expect(channelsService.findByUserId).not.toHaveBeenCalled();
      });

      it('should throw VideoNotOwnedException for another channel', async () => {
        givenVideo({ channel_id: 'someone-else' });

        await expect(
          service.getOwnedVideo(USER_ID, VIDEO_ID),
        ).rejects.toBeInstanceOf(VideoNotOwnedException);
      });
    });

    describe('getUploadState', () => {
      it('should expose status, failure reason and the upload plan', async () => {
        const video = givenVideo({
          status: VideoStatus.FAILED,
          failure_reason: 'No video stream found',
          created_at: new Date('2026-10-07T12:00:00Z'),
        });

        await expect(
          service.getUploadState(USER_ID, VIDEO_ID),
        ).resolves.toEqual({
          id: VIDEO_ID,
          public_id: video.public_id,
          title: video.title,
          status: VideoStatus.FAILED,
          failure_reason: 'No video stream found',
          size: 40_000_000,
          upload: { part_size: 16777216, part_count: 3 },
          created_at: new Date('2026-10-07T12:00:00Z'),
        });
      });
    });

    describe('createPartUploadUrls', () => {
      it('should presign each requested part with a one-hour lifetime', async () => {
        const video = givenVideo();
        storageService.presignUploadPart.mockImplementation(
          (_key: string, _uploadId: string, partNumber: number) =>
            Promise.resolve(`https://storage/part-${partNumber}`),
        );

        const result = await service.createPartUploadUrls(
          USER_ID,
          VIDEO_ID,
          [1, 3],
        );

        expect(result).toEqual({
          urls: [
            { part_number: 1, url: 'https://storage/part-1' },
            { part_number: 3, url: 'https://storage/part-3' },
          ],
          expires_in: 3600,
        });
        expect(storageService.presignUploadPart).toHaveBeenCalledWith(
          video.storage_key,
          'upload-1',
          1,
          3600,
        );
      });

      it('should reject a part number above the part count', async () => {
        givenVideo();

        await expect(
          service.createPartUploadUrls(USER_ID, VIDEO_ID, [1, 4]),
        ).rejects.toBeInstanceOf(InvalidUploadPartsException);
        expect(storageService.presignUploadPart).not.toHaveBeenCalled();
      });

      it.each([VideoStatus.PROCESSING, VideoStatus.READY, VideoStatus.FAILED])(
        'should reject a %s video',
        async (status) => {
          givenVideo({ status });

          await expect(
            service.createPartUploadUrls(USER_ID, VIDEO_ID, [1]),
          ).rejects.toBeInstanceOf(VideoUploadNotInProgressException);
        },
      );

      it('should reject a draft whose multipart upload is already completed', async () => {
        givenVideo({}, null);

        await expect(
          service.createPartUploadUrls(USER_ID, VIDEO_ID, [1]),
        ).rejects.toBeInstanceOf(VideoUploadNotInProgressException);
      });
    });

    describe('listUploadedParts', () => {
      it('should map the storage listing to the API shape', async () => {
        givenVideo();
        storageService.listParts.mockResolvedValue([
          { partNumber: 1, etag: '"abc"', size: 16777216 },
        ]);

        await expect(
          service.listUploadedParts(USER_ID, VIDEO_ID),
        ).resolves.toEqual({
          parts: [{ part_number: 1, etag: '"abc"', size: 16777216 }],
        });
      });

      it('should return no parts once the multipart upload is completed', async () => {
        givenVideo({}, null);

        await expect(
          service.listUploadedParts(USER_ID, VIDEO_ID),
        ).resolves.toEqual({
          parts: [],
        });
        expect(storageService.listParts).not.toHaveBeenCalled();
      });

      it('should reject a video that is not a draft', async () => {
        givenVideo({ status: VideoStatus.PROCESSING });

        await expect(
          service.listUploadedParts(USER_ID, VIDEO_ID),
        ).rejects.toBeInstanceOf(VideoUploadNotInProgressException);
      });
    });

    describe('abortUpload', () => {
      it('should abort the multipart upload and delete the draft', async () => {
        const video = givenVideo();

        await service.abortUpload(USER_ID, VIDEO_ID);

        expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
          video.storage_key,
          'upload-1',
        );
        expect(videoRepository.delete).toHaveBeenCalledWith({ id: VIDEO_ID });
      });

      it('should delete the stored object when the multipart upload is already completed', async () => {
        const video = givenVideo({}, null);

        await service.abortUpload(USER_ID, VIDEO_ID);

        expect(storageService.deleteObject).toHaveBeenCalledWith(
          video.storage_key,
        );
        expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
        expect(videoRepository.delete).toHaveBeenCalledWith({ id: VIDEO_ID });
      });

      it('should keep a video that is not a draft', async () => {
        givenVideo({ status: VideoStatus.READY });

        await expect(
          service.abortUpload(USER_ID, VIDEO_ID),
        ).rejects.toBeInstanceOf(VideoUploadNotInProgressException);
        expect(videoRepository.delete).not.toHaveBeenCalled();
      });

      it("should not delete another channel's draft", async () => {
        givenVideo({ channel_id: 'someone-else' });

        await expect(
          service.abortUpload(USER_ID, VIDEO_ID),
        ).rejects.toBeInstanceOf(VideoNotOwnedException);
        expect(videoRepository.delete).not.toHaveBeenCalled();
      });
    });
  });

  describe('completeUpload', () => {
    const VIDEO_ID = 'video-1';
    const parts = [{ part_number: 1, etag: '"abc"' }];

    function givenDraft(
      uploadId: string | null = 'upload-1',
      overrides: Partial<Video> = {},
    ): Video {
      const video = buildVideo(CHANNEL_ID, {
        id: VIDEO_ID,
        size: 2048,
        ...overrides,
      });
      videoRepository.findOne.mockImplementation(
        ({ select }: { select?: unknown }) =>
          Promise.resolve(
            select ? { id: VIDEO_ID, upload_id: uploadId } : video,
          ),
      );
      storageService.headObject.mockResolvedValue(video.size);
      return video;
    }

    it('should assemble the object, move the video to processing and publish the job', async () => {
      const video = givenDraft();

      const result = await service.completeUpload(USER_ID, VIDEO_ID, parts);

      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        video.storage_key,
        'upload-1',
        [{ partNumber: 1, etag: '"abc"' }],
      );
      expect(videoRepository.update).toHaveBeenNthCalledWith(
        1,
        { id: VIDEO_ID },
        { upload_id: null },
      );
      expect(videoRepository.update).toHaveBeenNthCalledWith(
        2,
        { id: VIDEO_ID, status: VideoStatus.DRAFT },
        { status: VideoStatus.PROCESSING },
      );
      expect(processingQueue.add).toHaveBeenCalledWith(
        'process-video',
        { videoId: VIDEO_ID },
        expect.objectContaining({
          jobId: VIDEO_ID,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        }),
      );
      expect(result).toEqual({
        id: VIDEO_ID,
        public_id: video.public_id,
        status: VideoStatus.PROCESSING,
      });
    });

    it('should publish only after the status change is stored', async () => {
      givenDraft();
      const order: string[] = [];
      videoRepository.update.mockImplementation(
        (_where: unknown, set: Partial<Video>) => {
          if (set.status) order.push(`status:${set.status}`);
          return Promise.resolve({ affected: 1 });
        },
      );
      processingQueue.add.mockImplementation(() => {
        order.push('publish');
        return Promise.resolve();
      });

      await service.completeUpload(USER_ID, VIDEO_ID, parts);

      expect(order).toEqual(['status:processing', 'publish']);
    });

    it.each([VideoStatus.PROCESSING, VideoStatus.READY, VideoStatus.FAILED])(
      'should reject a %s video without touching storage or queue',
      async (status) => {
        givenDraft('upload-1', { status });

        await expect(
          service.completeUpload(USER_ID, VIDEO_ID, parts),
        ).rejects.toBeInstanceOf(VideoUploadNotInProgressException);
        expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
        expect(processingQueue.add).not.toHaveBeenCalled();
      },
    );

    it('should map a storage rejection to InvalidUploadPartsException and stay draft', async () => {
      givenDraft();
      storageService.completeMultipartUpload.mockRejectedValue(
        new InvalidMultipartPartsError('InvalidPart'),
      );

      await expect(
        service.completeUpload(USER_ID, VIDEO_ID, parts),
      ).rejects.toBeInstanceOf(InvalidUploadPartsException);
      expect(videoRepository.update).not.toHaveBeenCalled();
      expect(processingQueue.add).not.toHaveBeenCalled();
    });

    it('should propagate an unexpected storage error unchanged', async () => {
      givenDraft();
      const outage = new Error('storage unreachable');
      storageService.completeMultipartUpload.mockRejectedValue(outage);

      await expect(
        service.completeUpload(USER_ID, VIDEO_ID, parts),
      ).rejects.toBe(outage);
    });

    it.each([
      ['smaller', 100],
      ['larger', 4096],
      ['missing', null],
    ])(
      'should discard object and draft when the stored object is %s',
      async (_label, storedSize) => {
        const video = givenDraft();
        storageService.headObject.mockResolvedValue(storedSize);

        await expect(
          service.completeUpload(USER_ID, VIDEO_ID, parts),
        ).rejects.toBeInstanceOf(UploadSizeMismatchException);
        expect(storageService.deleteObject).toHaveBeenCalledWith(
          video.storage_key,
        );
        expect(videoRepository.delete).toHaveBeenCalledWith({ id: VIDEO_ID });
        expect(processingQueue.add).not.toHaveBeenCalled();
      },
    );

    it('should lose to a concurrent completion that already moved the video', async () => {
      givenDraft();
      videoRepository.update.mockImplementation(
        (_where: unknown, set: Partial<Video>) =>
          Promise.resolve({ affected: set.status ? 0 : 1 }),
      );

      await expect(
        service.completeUpload(USER_ID, VIDEO_ID, parts),
      ).rejects.toBeInstanceOf(VideoUploadNotInProgressException);
      expect(processingQueue.add).not.toHaveBeenCalled();
    });

    it('should revert to draft and rethrow when the job cannot be published', async () => {
      givenDraft();
      const brokerDown = new Error('redis unavailable');
      processingQueue.add.mockRejectedValue(brokerDown);

      await expect(
        service.completeUpload(USER_ID, VIDEO_ID, parts),
      ).rejects.toBe(brokerDown);

      expect(videoRepository.update).toHaveBeenLastCalledWith(
        { id: VIDEO_ID, status: VideoStatus.PROCESSING },
        { status: VideoStatus.DRAFT },
      );
    });

    it('should skip the storage completion on a retry with the upload id already cleared', async () => {
      givenDraft(null);

      const result = await service.completeUpload(USER_ID, VIDEO_ID, parts);

      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
      expect(processingQueue.add).toHaveBeenCalledTimes(1);
      expect(result.status).toBe(VideoStatus.PROCESSING);
    });
  });

  describe('public operations', () => {
    const metadata = {
      width: 320,
      height: 240,
      video_codec: 'h264',
      audio_codec: null,
      bitrate: 1000,
      frame_rate: 10,
      container_format: 'mov,mp4',
    };

    function givenReadyVideo(overrides: Partial<Video> = {}): Video {
      const video = buildVideo(CHANNEL_ID, {
        status: VideoStatus.READY,
        duration: 2,
        metadata,
        thumbnail_key: 'videos/v/thumbnail.jpg',
        created_at: new Date('2026-10-07T12:00:00Z'),
        channel: { nickname: 'john_doe', name: 'John' } as Video['channel'],
        ...overrides,
      });
      videoRepository.findOne.mockResolvedValue(video);
      return video;
    }

    beforeEach(() => {
      storageService.presignGetObject.mockResolvedValue(
        'https://storage/signed',
      );
    });

    describe('findReadyByPublicId', () => {
      it('should look up only ready videos, with their channel', async () => {
        const video = givenReadyVideo();

        await expect(
          service.findReadyByPublicId(video.public_id),
        ).resolves.toBe(video);
        expect(videoRepository.findOne).toHaveBeenCalledWith({
          where: { public_id: video.public_id, status: VideoStatus.READY },
          relations: ['channel'],
        });
      });

      it('should throw VideoNotFoundException when nothing matches', async () => {
        videoRepository.findOne.mockResolvedValue(null);

        await expect(
          service.findReadyByPublicId('unknown'),
        ).rejects.toBeInstanceOf(VideoNotFoundException);
      });
    });

    describe('getPublicDetails', () => {
      it('should expose public fields only', async () => {
        const video = givenReadyVideo();

        const details = await service.getPublicDetails(video.public_id);

        expect(details).toEqual({
          public_id: video.public_id,
          title: video.title,
          duration: 2,
          metadata,
          size: video.size,
          channel: { nickname: 'john_doe', name: 'John' },
          created_at: new Date('2026-10-07T12:00:00Z'),
        });
      });

      it('should treat a ready row without processing results as not found', async () => {
        givenReadyVideo({ duration: null, metadata: null });

        await expect(service.getPublicDetails('x')).rejects.toBeInstanceOf(
          VideoNotFoundException,
        );
      });
    });

    describe('presigned URLs', () => {
      it('should sign the stream URL for clients with the video content type', async () => {
        const video = givenReadyVideo();

        await expect(service.getStreamUrl(video.public_id)).resolves.toBe(
          'https://storage/signed',
        );
        expect(storageService.presignGetObject).toHaveBeenCalledWith(
          video.storage_key,
          {
            expiresIn: 3600,
            audience: 'public',
            responseContentType: 'video/mp4',
          },
        );
      });

      it('should sign the download URL as an attachment named after the upload', async () => {
        const video = givenReadyVideo({
          original_filename: 'férias "2026"/final.mp4',
        });

        await service.getDownloadUrl(video.public_id);

        expect(storageService.presignGetObject).toHaveBeenCalledWith(
          video.storage_key,
          {
            expiresIn: 3600,
            audience: 'public',
            responseContentType: 'video/mp4',
            responseContentDisposition:
              'attachment; filename="f_rias _2026__final.mp4"; ' +
              "filename*=UTF-8''f%C3%A9rias%20%222026%22%2Ffinal.mp4",
          },
        );
      });

      it('should sign the thumbnail URL from the thumbnail key', async () => {
        const video = givenReadyVideo();

        await service.getThumbnailUrl(video.public_id);

        expect(storageService.presignGetObject).toHaveBeenCalledWith(
          'videos/v/thumbnail.jpg',
          { expiresIn: 3600, audience: 'public' },
        );
      });

      it('should report a ready video without thumbnail as not found', async () => {
        givenReadyVideo({ thumbnail_key: null });

        await expect(service.getThumbnailUrl('x')).rejects.toBeInstanceOf(
          VideoNotFoundException,
        );
      });

      it.each(['getStreamUrl', 'getDownloadUrl', 'getThumbnailUrl'] as const)(
        'should not sign anything in %s when the video is not public',
        async (method) => {
          videoRepository.findOne.mockResolvedValue(null);

          await expect(service[method]('x')).rejects.toBeInstanceOf(
            VideoNotFoundException,
          );
          expect(storageService.presignGetObject).not.toHaveBeenCalled();
        },
      );
    });
  });

  describe('attachmentDisposition', () => {
    it.each([
      [
        'clip.mp4',
        `attachment; filename="clip.mp4"; filename*=UTF-8''clip.mp4`,
      ],
      [
        "it's (1).mp4",
        `attachment; filename="it_s _1_.mp4"; filename*=UTF-8''it%27s%20%281%29.mp4`,
      ],
      [
        'a"b\r\nX-Injected: 1.mp4',
        `attachment; filename="a_b__X-Injected_ 1.mp4"; filename*=UTF-8''a%22b%0D%0AX-Injected%3A%201.mp4`,
      ],
    ])('should build a safe header for %j', (filename, expected) => {
      expect(attachmentDisposition(filename)).toBe(expected);
    });
  });
});
