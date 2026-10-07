import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { emptyQueue } from '../test/queue-test-env';
import { QueueModule } from './queue.module';

const QUEUE_NAME = 'queue-module-spec';

async function compileWithPrefix(prefix: string): Promise<TestingModule> {
  process.env.QUEUE_PREFIX = prefix;
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
      QueueModule,
      BullModule.registerQueue({ name: QUEUE_NAME }),
    ],
  }).compile();
}

describe('QueueModule (integration)', () => {
  const originalPrefix = process.env.QUEUE_PREFIX;
  const modules: TestingModule[] = [];

  async function queueFor(prefix: string): Promise<Queue> {
    const module = await compileWithPrefix(prefix);
    modules.push(module);
    return module.get<Queue>(getQueueToken(QUEUE_NAME));
  }

  afterAll(async () => {
    for (const module of modules) {
      await emptyQueue(module.get<Queue>(getQueueToken(QUEUE_NAME)));
      await module.close();
    }
    process.env.QUEUE_PREFIX = originalPrefix;
  });

  it('should store a job in Redis under the configured prefix', async () => {
    const queue = await queueFor('queue-spec-a');

    const job = await queue.add('ping', { value: 42 });

    const stored = await queue.getJob(job.id as string);
    expect(stored?.data).toEqual({ value: 42 });
    expect(queue.opts.prefix).toBe('queue-spec-a');
  });

  it('should not see jobs stored under another prefix', async () => {
    const queueA = await queueFor('queue-spec-a');
    const queueB = await queueFor('queue-spec-b');
    await emptyQueue(queueA);

    await queueA.add('ping', { value: 1 });

    expect(await queueA.getJobCounts('waiting')).toEqual({ waiting: 1 });
    expect(await queueB.getJobCounts('waiting')).toEqual({ waiting: 0 });
  });
});
