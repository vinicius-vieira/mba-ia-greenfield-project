import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { useIsolatedQueuePrefix } from './test/queue-test-env';
import { StorageService } from './storage/storage.service';
import { Video } from './videos/entities/video.entity';
import { VideoProcessor } from './videos/processing/video.processor';
import { VideosController } from './videos/videos.controller';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  it('should compile the consumer without any HTTP controller', async () => {
    // Compiling starts a real BullMQ worker: keep it off the shared queue.
    useIsolatedQueuePrefix();
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(module.get(VideoProcessor)).toBeInstanceOf(VideoProcessor);
    expect(module.get(StorageService, { strict: false })).toBeInstanceOf(
      StorageService,
    );
    expect(
      module.get(getRepositoryToken(Video), { strict: false }),
    ).toBeDefined();
    expect(() => module.get(VideosController, { strict: false })).toThrow();
    await module.close();
  }, 30000);
});
