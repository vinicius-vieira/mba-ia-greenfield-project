import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ChannelsModule } from './channels/channels.module';
import { configModuleOptions } from './config/config-module.options';
import { DatabaseModule } from './database/database.module';
import { UsersModule } from './users/users.module';
import { VideoProcessingModule } from './videos/processing/video-processing.module';

/**
 * Root module of the video worker process: no controllers, no HTTP modules.
 * `UsersModule` and `ChannelsModule` are here only to register the entities
 * `Video` relates to (`Video → Channel → User`).
 */
@Module({
  imports: [
    ConfigModule.forRoot(configModuleOptions),
    DatabaseModule,
    UsersModule,
    ChannelsModule,
    VideoProcessingModule,
  ],
})
export class WorkerModule {}
