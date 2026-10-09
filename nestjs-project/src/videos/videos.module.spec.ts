import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { createTestDataSource } from '../test/create-test-data-source';
import { useIsolatedQueuePrefix } from '../test/queue-test-env';
import { Video } from './entities/video.entity';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

describe('VideosModule', () => {
  it('should compile with its repository, storage, channels and queue wiring', async () => {
    useIsolatedQueuePrefix();
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource([Video]).options),
        VideosModule,
      ],
    }).compile();

    expect(module.get(getRepositoryToken(Video))).toBeDefined();
    expect(module.get(VideosService)).toBeInstanceOf(VideosService);
    await module.close();
  }, 30000);
});
