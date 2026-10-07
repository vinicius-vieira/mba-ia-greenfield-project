import { randomUUID } from 'node:crypto';
import { parse } from 'node:path';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { isUniqueViolationOn } from '../common/database/pg-errors.util';
import { videoOriginalKey } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { UploadInitiatedDto, UploadPlanDto } from './dto/upload-state.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { generateVideoPublicId } from './video-public-id.util';
import {
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
