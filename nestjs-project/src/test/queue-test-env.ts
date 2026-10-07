import type { Queue } from 'bullmq';

/**
 * The `video-worker` container consumes the queue under the default
 * QUEUE_PREFIX. Tests that assert on enqueued jobs give the current test
 * process its own prefix, so the running worker never takes their jobs.
 *
 * Call before the Nest module (or the config factory) is created.
 */
export function useIsolatedQueuePrefix(): string {
  const prefix = `test-${process.pid}`;
  process.env.QUEUE_PREFIX = prefix;
  return prefix;
}

/** Removes every job (and the queue's keys) so the next test starts empty. */
export async function emptyQueue(queue: Queue): Promise<void> {
  await queue.obliterate({ force: true });
}
