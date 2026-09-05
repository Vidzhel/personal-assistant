import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createLogger } from '@raven/shared';
import type { DatabaseInterface } from '@raven/shared';
import { runFileMigrations } from './migrations.ts';

const log = createLogger('db');

let db: Database.Database | null = null;

const modulePath = fileURLToPath(import.meta.url);
// Source development uses canonical SQL; a compiled package carries its own
// copy. Never let a missing packaged migration directory silently use checkout SQL.
const defaultMigrationsDir = modulePath.endsWith('.ts')
  ? join(dirname(modulePath), '..', '..', '..', '..', 'migrations')
  : join(dirname(modulePath), '..', 'migrations');

export function initDatabase(dbPath: string, migrationsDir?: string): Database.Database {
  if (db) {
    log.warn('initDatabase called with an already-open handle — closing it first');
    closeDatabase();
  }
  log.info(`Opening database at ${dbPath}`);
  const candidate = new Database(dbPath);
  try {
    candidate.pragma('journal_mode = WAL');
    candidate.pragma('foreign_keys = ON');
    runFileMigrations(candidate, migrationsDir ?? defaultMigrationsDir);
  } catch (error) {
    candidate.close();
    throw error;
  }
  db = candidate;
  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
  return db;
}

/** Closes the open handle (if any) and nulls the singleton so a subsequent
 * initDatabase() starts clean. Idempotent — calling it with no open handle
 * is a no-op, not an error, so shutdown paths and test afterEach hooks can
 * call it unconditionally. */
export function closeDatabase(): void {
  if (!db) return;
  db.close();
  db = null;
  log.info('Database closed');
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
