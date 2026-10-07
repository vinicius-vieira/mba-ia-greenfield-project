import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Video } from '../videos/entities/video.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1791348097873 } from './migrations/1791348097873-CreateVideos';
import { createTestDataSource } from '../test/create-test-data-source';

const MANAGED_TABLES = [
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
  'videos',
];

// Enum types survive `DROP TABLE`; without dropping them the migrations fail
// with "type already exists" on a database that was migrated before.
const MANAGED_ENUM_TYPES = [
  'verification_tokens_type_enum',
  'videos_status_enum',
];

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
          CreateVideos1791348097873,
        ],
      },
    );

    await dataSource.initialize();

    // One statement, not concurrent DROPs: tables reference each other and
    // parallel `DROP ... CASCADE` calls deadlock on the shared FK locks.
    const tables = [...MANAGED_TABLES, 'migrations']
      .map((table) => `"${table}"`)
      .join(', ');
    await dataSource.query(`DROP TABLE IF EXISTS ${tables} CASCADE`);
    for (const type of MANAGED_ENUM_TYPES) {
      await dataSource.query(`DROP TYPE IF EXISTS "${type}"`);
    }
  });

  afterAll(async () => {
    // The second test undoes the last migration, leaving the videos table missing.
    // Re-apply so the shared DB is fully migrated when subsequent suites run.
    await dataSource.runMigrations();
    await dataSource.destroy();
  });

  it('should apply all migrations and create all five tables', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(3);

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    const tableNames = result.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
      'videos',
    ]);
  });

  it('should revert the last migration, removing videos and keeping the rest', async () => {
    await dataSource.undoLastMigration();

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    expect(result.map((r) => r.table_name)).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
    ]);

    const enumTypes = await dataSource.query<{ typname: string }[]>(
      `SELECT typname FROM pg_type WHERE typname = 'videos_status_enum'`,
    );
    expect(enumTypes).toHaveLength(0);
  });
});
