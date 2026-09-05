import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseInterface } from '@raven/shared';

const SCHEMA_PATH = join(
  import.meta.dirname,
  '../../../../../../../migrations/001-initial-schema.sql',
);

// Isolated in-memory DatabaseInterface using the current operational schema.
export function createTestDb(): DatabaseInterface {
  const raw = new Database(':memory:');
  raw.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  return {
    run: (sql: string, ...params: unknown[]): void => {
      raw.prepare(sql).run(...params);
    },
    get: <T>(sql: string, ...params: unknown[]): T | undefined =>
      raw.prepare(sql).get(...params) as T | undefined,
    all: <T>(sql: string, ...params: unknown[]): T[] => raw.prepare(sql).all(...params) as T[],
  };
}
