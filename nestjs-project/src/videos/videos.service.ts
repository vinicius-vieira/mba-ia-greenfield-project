import { randomUUID } from 'node:crypto';
import { parse } from 'node:path';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { isUniqueViolationOn } from '../common/database/pg-errors.util';
import {
  InvalidUploadPartsException,
  UploadSizeMismatchException,
  VideoNotFoundException,
  VideoNotOwnedException,
  VideoUploadNotInProgressException,
} from '../common/exceptions/domain.exception';
import {
  PROCESS_VIDEO_JOB,
  type ProcessVideoJobData,
  VIDEO_PROCESSING_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';
import { videoOriginalKey } from '../storage/storage.constants';
import { InvalidMultipartPartsError } from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import {
  CompletedPartDto,
  UploadCompletedDto,
} from './dto/complete-upload.dto';
import { PartUrlsDto, UploadedPartsDto } from './dto/create-part-urls.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { VideoDetailsDto } from './dto/video-details.dto';
import {
  UploadInitiatedDto,
  UploadPlanDto,
  UploadStateDto,
} from './dto/upload-state.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { generateVideoPublicId } from './video-public-id.util';
import {
  PRESIGNED_URL_TTL_SECONDS,
  UPLOAD_PART_SIZE_BYTES,
  VIDEO_PUBLIC_ID_MAX_ATTEMPTS,
} from './videos.constants';

const PUBLIC_ID_COLUMN = 'public_id';
const TITLE_MAX_LENGTH = 255;

export function uploadPlanFor(size: number): UploadPlanDto {
  return {
    part_size: UPLOAD_PART_SIZE_BYTES,
    part_count: Math.ceil(size / UPLOAD_PART_SIZE_BYTES),
  };
}

/**
 * `Content-Disposition` for a download: an ASCII-only fallback name plus the
 * exact name in RFC 5987 form for clients that understand it.
 */
export function attachmentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\w.\- ]/g, '_');
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function defaultTitle(filename: string): string {
  const withoutExtension = parse(filename).name.trim();
  return (withoutExtension || filename).slice(0, TITLE_MAX_LENGTH);
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly processingQueue: Queue<ProcessVideoJobData>,
  ) {}

  /**
   * Pre-registers the video as a draft and opens the multipart upload. The
   * file bytes never reach the API: the client sends them to the storage
   * through presigned part URLs.
   */
  async initiateUpload(
    userId: string,
    dto: InitiateUploadDto,
  ): Promise<UploadInitiatedDto> {
    const channel = await this.channelsService.findByUserId(userId);
    const id = randomUUID();
    const storageKey = videoOriginalKey(id);
    const uploadId = await this.storageService.createMultipartUpload(
      storageKey,
      dto.content_type,
    );

    let video: Video;
    try {
      video = await this.insertDraft({
        id,
        channel_id: channel.id,
        title: dto.title ?? defaultTitle(dto.filename),
        original_filename: dto.filename,
        content_type: dto.content_type,
        size: dto.size,
        storage_key: storageKey,
        upload_id: uploadId,
      });
    } catch (err) {
      // No draft row will ever reference this upload: discard it.
      await this.storageService.abortMultipartUpload(storageKey, uploadId);
      throw err;
    }

    return {
      id: video.id,
      public_id: video.public_id,
      title: video.title,
      status: video.status,
      upload: uploadPlanFor(video.size),
    };
  }

  /** The video, provided the caller's channel owns it. */
  async getOwnedVideo(userId: string, videoId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    const channel = await this.channelsService.findByUserId(userId);
    if (video.channel_id !== channel.id) {
      throw new VideoNotOwnedException();
    }
    return video;
  }

  async getUploadState(
    userId: string,
    videoId: string,
  ): Promise<UploadStateDto> {
    const video = await this.getOwnedVideo(userId, videoId);
    return {
      id: video.id,
      public_id: video.public_id,
      title: video.title,
      status: video.status,
      failure_reason: video.failure_reason,
      size: video.size,
      upload: uploadPlanFor(video.size),
      created_at: video.created_at,
    };
  }

  async createPartUploadUrls(
    userId: string,
    videoId: string,
    partNumbers: number[],
  ): Promise<PartUrlsDto> {
    const video = await this.getOwnedDraft(userId, videoId);
    const uploadId = await this.findUploadId(video.id);
    if (!uploadId) {
      // The multipart upload was already completed in the storage.
      throw new VideoUploadNotInProgressException();
    }

    const { part_count: partCount } = uploadPlanFor(video.size);
    if (partNumbers.some((partNumber) => partNumber > partCount)) {
      throw new InvalidUploadPartsException(
        `Part numbers must be between 1 and ${partCount}`,
      );
    }

    const urls = await Promise.all(
      partNumbers.map(async (partNumber) => ({
        part_number: partNumber,
        url: await this.storageService.presignUploadPart(
          video.storage_key,
          uploadId,
          partNumber,
          PRESIGNED_URL_TTL_SECONDS,
        ),
      })),
    );
    return { urls, expires_in: PRESIGNED_URL_TTL_SECONDS };
  }

  /** Parts the storage already holds — what a client needs to resume. */
  async listUploadedParts(
    userId: string,
    videoId: string,
  ): Promise<UploadedPartsDto> {
    const video = await this.getOwnedDraft(userId, videoId);
    const uploadId = await this.findUploadId(video.id);
    if (!uploadId) {
      return { parts: [] };
    }

    const parts = await this.storageService.listParts(
      video.storage_key,
      uploadId,
    );
    return {
      parts: parts.map((part) => ({
        part_number: part.partNumber,
        etag: part.etag,
        size: part.size,
      })),
    };
  }

  async abortUpload(userId: string, videoId: string): Promise<void> {
    const video = await this.getOwnedDraft(userId, videoId);
    const uploadId = await this.findUploadId(video.id);
    if (uploadId) {
      await this.storageService.abortMultipartUpload(
        video.storage_key,
        uploadId,
      );
    } else {
      await this.storageService.deleteObject(video.storage_key);
    }
    await this.videoRepository.delete({ id: video.id });
  }

  /**
   * Finishes the upload and hands the video to background processing. This
   * is the only trigger for processing.
   */
  async completeUpload(
    userId: string,
    videoId: string,
    parts: CompletedPartDto[],
  ): Promise<UploadCompletedDto> {
    const video = await this.getOwnedDraft(userId, videoId);

    // Skipped on a retry after a failed publish: the object is already whole.
    const uploadId = await this.findUploadId(video.id);
    if (uploadId) {
      await this.assembleObject(video, uploadId, parts);
    }

    const storedSize = await this.storageService.headObject(video.storage_key);
    if (storedSize !== video.size) {
      await this.storageService.deleteObject(video.storage_key);
      await this.videoRepository.delete({ id: video.id });
      throw new UploadSizeMismatchException();
    }

    // Conditional: a concurrent completion of the same video loses here.
    const moved = await this.videoRepository.update(
      { id: video.id, status: VideoStatus.DRAFT },
      { status: VideoStatus.PROCESSING },
    );
    if (!moved.affected) {
      throw new VideoUploadNotInProgressException();
    }

    try {
      await this.processingQueue.add(
        PROCESS_VIDEO_JOB,
        { videoId: video.id },
        { ...VIDEO_PROCESSING_JOB_OPTIONS, jobId: video.id },
      );
    } catch (err) {
      // Nothing will process it: give the caller back a draft it can retry.
      await this.videoRepository.update(
        { id: video.id, status: VideoStatus.PROCESSING },
        { status: VideoStatus.DRAFT },
      );
      throw err;
    }

    return {
      id: video.id,
      public_id: video.public_id,
      status: VideoStatus.PROCESSING,
    };
  }

  /**
   * The video behind a public URL. Only `ready` videos are public; anything
   * else is indistinguishable from an unknown id.
   */
  async findReadyByPublicId(publicId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId, status: VideoStatus.READY },
      relations: ['channel'],
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  async getPublicDetails(publicId: string): Promise<VideoDetailsDto> {
    const video = await this.findReadyByPublicId(publicId);
    if (video.duration === null || video.metadata === null) {
      // A ready video always has both; treat a broken row as absent.
      throw new VideoNotFoundException();
    }
    return {
      public_id: video.public_id,
      title: video.title,
      duration: video.duration,
      metadata: video.metadata,
      size: video.size,
      channel: {
        nickname: video.channel.nickname,
        name: video.channel.name,
      },
      created_at: video.created_at,
    };
  }

  /** Presigned URL the player streams from (the storage serves byte ranges). */
  async getStreamUrl(publicId: string): Promise<string> {
    const video = await this.findReadyByPublicId(publicId);
    return this.storageService.presignGetObject(video.storage_key, {
      expiresIn: PRESIGNED_URL_TTL_SECONDS,
      audience: 'public',
      responseContentType: video.content_type,
    });
  }

  async getDownloadUrl(publicId: string): Promise<string> {
    const video = await this.findReadyByPublicId(publicId);
    return this.storageService.presignGetObject(video.storage_key, {
      expiresIn: PRESIGNED_URL_TTL_SECONDS,
      audience: 'public',
      responseContentType: video.content_type,
      responseContentDisposition: attachmentDisposition(
        video.original_filename,
      ),
    });
  }

  async getThumbnailUrl(publicId: string): Promise<string> {
    const video = await this.findReadyByPublicId(publicId);
    if (!video.thumbnail_key) {
      throw new VideoNotFoundException();
    }
    return this.storageService.presignGetObject(video.thumbnail_key, {
      expiresIn: PRESIGNED_URL_TTL_SECONDS,
      audience: 'public',
    });
  }

  private async assembleObject(
    video: Video,
    uploadId: string,
    parts: CompletedPartDto[],
  ): Promise<void> {
    try {
      await this.storageService.completeMultipartUpload(
        video.storage_key,
        uploadId,
        parts.map((part) => ({
          partNumber: part.part_number,
          etag: part.etag,
        })),
      );
    } catch (err) {
      if (err instanceof InvalidMultipartPartsError) {
        throw new InvalidUploadPartsException(
          'Storage rejected the uploaded parts',
        );
      }
      throw err;
    }
    await this.videoRepository.update({ id: video.id }, { upload_id: null });
  }

  private async getOwnedDraft(userId: string, videoId: string): Promise<Video> {
    const video = await this.getOwnedVideo(userId, videoId);
    if (video.status !== VideoStatus.DRAFT) {
      throw new VideoUploadNotInProgressException();
    }
    return video;
  }

  // `upload_id` is `select: false`; it is loaded only by the upload operations.
  private async findUploadId(videoId: string): Promise<string | null> {
    const row = await this.videoRepository.findOne({
      where: { id: videoId },
      select: { id: true, upload_id: true },
    });
    return row?.upload_id ?? null;
  }

  private async insertDraft(fields: Partial<Video>): Promise<Video> {
    for (let attempt = 0; attempt < VIDEO_PUBLIC_ID_MAX_ATTEMPTS; attempt++) {
      const publicId = generateVideoPublicId();
      if (await this.videoRepository.existsBy({ public_id: publicId })) {
        continue;
      }

      const video = this.videoRepository.create({
        ...fields,
        public_id: publicId,
        status: VideoStatus.DRAFT,
      });
      try {
        await this.videoRepository.insert(video);
        return video;
      } catch (err) {
        // Concurrent insert took the same id between the pre-check and now.
        if (!isUniqueViolationOn(err, PUBLIC_ID_COLUMN)) throw err;
      }
    }

    throw new Error('Could not allocate a unique video public id');
  }
}
