import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { createLogger } from '@raven/shared';

const log = createLogger('migrations');

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

    log.info(`Running migration: ${name}`);
    const migrate = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(name, Date.now());
    });

    migrate();
  }
}
