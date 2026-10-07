import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { Channel } from '../../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../../src/common/filters/validation-exception.filter';
import { createUserWithChannel } from '../../src/test/video-factory';
import { User } from '../../src/users/entities/user.entity';

/** Boots the real AppModule with the same global pipes/filters as `main.ts`. */
export async function createE2eApp(): Promise<{
  app: INestApplication<App>;
  dataSource: DataSource;
}> {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
  await app.init();

  return { app, dataSource: moduleFixture.get(DataSource) };
}

export interface AuthenticatedUser {
  user: User;
  channel: Channel;
  /** `Authorization` header value signed by the application's own JwtService. */
  authorization: string;
}

/** A confirmed user with a channel and a valid access token. */
export async function createAuthenticatedUser(
  app: INestApplication<App>,
  dataSource: DataSource,
): Promise<AuthenticatedUser> {
  const { user, channel } = await createUserWithChannel(dataSource);
  const token = await app.get(JwtService).signAsync({
    sub: user.id,
    email: user.email,
    jti: randomUUID(),
  });
  return { user, channel, authorization: `Bearer ${token}` };
}
