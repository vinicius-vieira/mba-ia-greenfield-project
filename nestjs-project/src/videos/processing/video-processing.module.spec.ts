import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import queueConfig from '../../config/queue.config';
import storageConfig from '../../config/storage.config';
import { createTestDataSource } from '../../test/create-test-data-source';
import { useIsolatedQueuePrefix } from '../../test/queue-test-env';
import { Video } from '../entities/video.entity';
import { VideoProcessingModule } from './video-processing.module';
import { VideoProcessingService } from './video-processing.service';
import { VideoProcessor } from './video.processor';

describe('VideoProcessingModule', () => {
  it('should compile the processor with its queue, storage and repository wiring', async () => {
    // Compiling registers a real worker: keep it off the shared queue.
    useIsolatedQueuePrefix();
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource([Video]).options),
        VideoProcessingModule,
      ],
    }).compile();

    expect(module.get(VideoProcessor)).toBeInstanceOf(VideoProcessor);
    expect(module.get(VideoProcessingService)).toBeInstanceOf(
      VideoProcessingService,
    );
    await module.close();
  }, 30000);
});
