import { Test } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { createTestDataSource } from '../test/create-test-data-source';
import { Video } from './entities/video.entity';
import { VideosModule } from './videos.module';

describe('VideosModule', () => {
  it('should compile and register the Video repository', async () => {
    const module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(createTestDataSource([Video]).options),
        VideosModule,
      ],
    }).compile();

    expect(module.get(getRepositoryToken(Video))).toBeDefined();
    await module.close();
  }, 30000);
});
