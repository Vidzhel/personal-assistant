import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createLogger } from '@raven/shared';
import type { DatabaseInterface } from '@raven/shared';
import { runFileMigrations } from './migrations.ts';

const log = createLogger('db');

let db: Database.Database;

const defaultMigrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'migrations',
);

export function initDatabase(dbPath: string, migrationsDir?: string): Database.Database {
  log.info(`Opening database at ${dbPath}`);
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runFileMigrations(db, migrationsDir ?? defaultMigrationsDir);
  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
  return db;
}

export function createDbInterface(): DatabaseInterface {
  const d = getDb();
  return {
    run(sql: string, ...params: unknown[]) {
      d.prepare(sql).run(...params);
    },
    get<T>(sql: string, ...params: unknown[]): T | undefined {
      return d.prepare(sql).get(...params) as T | undefined;
    },
    all<T>(sql: string, ...params: unknown[]): T[] {
      return d.prepare(sql).all(...params) as T[];
    },
  };
}
