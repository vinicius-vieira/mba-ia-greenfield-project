import { QueryFailedError } from 'typeorm';

const PG_UNIQUE_VIOLATION = '23505';

interface PgDriverError {
  code?: string;
  detail?: string;
}

/** True when `err` is a PostgreSQL unique violation involving `column`. */
export function isUniqueViolationOn(err: unknown, column: string): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const e = err as QueryFailedError & PgDriverError;
  return (
    e.code === PG_UNIQUE_VIOLATION &&
    typeof e.detail === 'string' &&
    e.detail.includes(column)
  );
}
