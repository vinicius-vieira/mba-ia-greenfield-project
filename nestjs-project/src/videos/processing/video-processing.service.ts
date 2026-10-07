import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  THUMBNAIL_CONTENT_TYPE,
  videoThumbnailKey,
} from '../../storage/storage.constants';
import { StorageService } from '../../storage/storage.service';
import { Video, VideoStatus } from '../entities/video.entity';
import { MediaInspectorService } from './media-inspector.service';
import {
  FAILURE_REASON_MAX_LENGTH,
  SOURCE_URL_TTL_SECONDS,
  THUMBNAIL_FILENAME,
  WORKER_TEMP_DIR_PREFIX,
} from './processing.constants';

@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly mediaInspector: MediaInspectorService,
  ) {}

  /**
   * Turns a `processing` video into `ready`: extracts duration and metadata
   * and stores a thumbnail. Errors propagate so the queue can retry; the
   * `failed` transition is decided by the caller (see `markFailed`).
   */
  async process(videoId: string): Promise<void> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    // Jobs are delivered at least once: a redelivery, or a job for a video
    // that was deleted meanwhile, must be a no-op.
    if (!video || video.status !== VideoStatus.PROCESSING) {
      this.logger.warn(
        `Skipping video ${videoId}: ${video ? `status is ${video.status}` : 'not found'}`,
      );
      return;
    }

    const sourceUrl = await this.storageService.presignGetObject(
      video.storage_key,
      { expiresIn: SOURCE_URL_TTL_SECONDS, audience: 'internal' },
    );
    const { duration, metadata } = await this.mediaInspector.probe(sourceUrl);
    const thumbnailKey = await this.storeThumbnail(
      video.id,
      sourceUrl,
      duration,
    );

    // Conditional: never overwrite a state reached by another delivery.
    await this.videoRepository.update(
      { id: video.id, status: VideoStatus.PROCESSING },
      {
        status: VideoStatus.READY,
        duration,
        metadata,
        thumbnail_key: thumbnailKey,
        processed_at: new Date(),
      },
    );
    this.logger.log(`Video ${video.id} is ready (${duration.toFixed(1)}s)`);
  }

  /** `processing → failed`; any other status is left untouched. */
  async markFailed(videoId: string, reason: string): Promise<void> {
    await this.videoRepository.update(
      { id: videoId, status: VideoStatus.PROCESSING },
      {
        status: VideoStatus.FAILED,
        failure_reason: reason.slice(0, FAILURE_REASON_MAX_LENGTH),
      },
    );
  }

  private async storeThumbnail(
    videoId: string,
    sourceUrl: string,
    duration: number,
  ): Promise<string> {
    const key = videoThumbnailKey(videoId);
    const workDir = await mkdtemp(join(tmpdir(), WORKER_TEMP_DIR_PREFIX));
    try {
      const framePath = join(workDir, THUMBNAIL_FILENAME);
      await this.mediaInspector.captureThumbnail(
        sourceUrl,
        duration,
        framePath,
      );
      await this.storageService.putObject(
        key,
        await readFile(framePath),
        THUMBNAIL_CONTENT_TYPE,
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
    return key;
  }
}
