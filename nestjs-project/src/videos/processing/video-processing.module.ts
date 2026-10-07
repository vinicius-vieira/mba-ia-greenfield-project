import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { VIDEO_PROCESSING_QUEUE } from '../../queue/queue.constants';
import { QueueModule } from '../../queue/queue.module';
import { StorageModule } from '../../storage/storage.module';
import { Video } from '../entities/video.entity';
import { MediaInspectorService } from './media-inspector.service';
import { VideoProcessingService } from './video-processing.service';
import { VideoProcessor } from './video.processor';

/** Consumer side of the processing queue; loaded only by the video worker. */
@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    StorageModule,
    QueueModule,
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
  ],
  providers: [MediaInspectorService, VideoProcessingService, VideoProcessor],
})
export class VideoProcessingModule {}
