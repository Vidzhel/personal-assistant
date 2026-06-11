import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseInterface } from '@raven/shared';

const MIGRATION_PATH = join(
  import.meta.dirname,
  '../../../../migrations/024-telegram-topics.sql',
);

// In-memory DatabaseInterface with the telegram_topics migration applied.
export function createTestDb(): DatabaseInterface {
  const raw = new Database(':memory:');
  raw.exec(readFileSync(MIGRATION_PATH, 'utf8'));
  return {
    run: (sql: string, ...params: unknown[]): void => {
      raw.prepare(sql).run(...params);
    },
    get: <T>(sql: string, ...params: unknown[]): T | undefined =>
      raw.prepare(sql).get(...params) as T | undefined,
    all: <T>(sql: string, ...params: unknown[]): T[] => raw.prepare(sql).all(...params) as T[],
  };
}
