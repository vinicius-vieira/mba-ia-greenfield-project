import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  STORAGE_ACCESS_KEY: 'access',
  STORAGE_SECRET_KEY: 'secret',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage and queue', () => {
  it.each(['STORAGE_ACCESS_KEY', 'STORAGE_SECRET_KEY'])(
    'should reject a missing %s',
    (key) => {
      const env: Record<string, string> = { ...requiredEnv };
      delete env[key];

      const { error } = envValidationSchema.validate(env, {
        allowUnknown: true,
        abortEarly: false,
      });

      expect(error).toBeDefined();
      expect(error!.message).toContain(key);
    },
  );

  it('should apply Compose-compatible defaults', () => {
    const { value, error } = validate({});

    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      STORAGE_ENDPOINT: 'http://minio:9000',
      STORAGE_PUBLIC_ENDPOINT: 'http://localhost:9000',
      STORAGE_REGION: 'us-east-1',
      STORAGE_BUCKET: 'streamtube',
      REDIS_HOST: 'redis',
      REDIS_PORT: 6379,
      QUEUE_PREFIX: 'streamtube',
    });
  });

  it('should reject a storage endpoint that is not a URL', () => {
    const { error } = validate({ STORAGE_ENDPOINT: 'minio' });

    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_ENDPOINT');
  });
});
