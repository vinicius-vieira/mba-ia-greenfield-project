import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  // Application context only: the worker consumes the queue and listens on no port.
  const app = await NestFactory.createApplicationContext(WorkerModule);
  // SIGTERM/SIGINT close the BullMQ worker so an in-flight job is not left stalled.
  app.enableShutdownHooks();
  Logger.log('Video worker started', 'Worker');
}
void bootstrap();
