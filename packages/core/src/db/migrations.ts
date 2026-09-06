import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { createLogger } from '@raven/shared';

const log = createLogger('migrations');
export const CURRENT_OPERATIONAL_SCHEMA_VERSION = 2;

function assertCurrentSchemaVersion(version: number): void {
  if (version === CURRENT_OPERATIONAL_SCHEMA_VERSION) return;
  throw new Error(
    `Unsupported operational database schema version ${String(version)}; expected ${String(CURRENT_OPERATIONAL_SCHEMA_VERSION)}. This build requires a fresh/current operational schema; initialize it explicitly. The runtime will not reset or partially upgrade this file.`,
  );
}

function assertInitialSchemaMarker(sql: string): void {
  const match = /PRAGMA\s+user_version\s*=\s*(\d+)\s*;/i.exec(sql);
  assertCurrentSchemaVersion(match ? Number(match[1]) : 0);
}

export function runFileMigrations(db: Database.Database, migrationsDir: string): void {
  if (!existsSync(migrationsDir)) {
    throw new Error(`Migrations directory not found: ${migrationsDir}`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL -- epoch ms for backward compat with legacy _migrations
    )
  `);

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const migrationNames = new Set(files.map((file) => file.replace(/\.sql$/, '')));
  const applied = new Set(
    (db.prepare('SELECT name FROM _migrations').all() as Array<{ name: string }>).map(
      (r) => r.name,
    ),
  );
  const unsupported = [...applied].filter((name) => !migrationNames.has(name));
  if (unsupported.length > 0) {
    throw new Error(`Unsupported database migration history: ${unsupported.sort().join(', ')}`);
  }

  for (const file of files) {
    const name = file.replace(/\.sql$/, '');

    if (applied.has(name)) {
      log.debug(`Skipping already-applied migration: ${name}`);
      continue;
    }

    const sql = readFileSync(join(migrationsDir, file), 'utf-8');
    if (name === '001-initial-schema') assertInitialSchemaMarker(sql);

    log.info(`Running migration: ${name}`);
    const migrate = db.transaction(() => {
      db.exec(sql);
      if (name === '001-initial-schema') {
        assertCurrentSchemaVersion(db.pragma('user_version', { simple: true }) as number);
      }
      db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(name, Date.now());
    });

    migrate();
  }

  if (migrationNames.has('001-initial-schema')) {
    const version = db.pragma('user_version', { simple: true }) as number;
    assertCurrentSchemaVersion(version);
  }
}
