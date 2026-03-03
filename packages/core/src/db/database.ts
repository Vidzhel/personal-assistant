import Database from 'better-sqlite3';
import { createLogger } from '@raven/shared';
import type { DatabaseInterface } from '@raven/shared';

const log = createLogger('db');

let db: Database.Database;

export function initDatabase(dbPath: string): Database.Database {
  log.info(`Opening database at ${dbPath}`);
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
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

function runMigrations(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);

  const applied = new Set(
    (d.prepare('SELECT name FROM _migrations').all() as Array<{ name: string }>).map((r) => r.name),
  );

  for (const migration of migrations) {
    if (!applied.has(migration.name)) {
      log.info(`Running migration: ${migration.name}`);
      d.exec(migration.sql);
      d.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(
        migration.name,
        Date.now(),
      );
    }
  }
}

const migrations = [
  {
    name: '001-init',
    sql: `
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        skills TEXT NOT NULL DEFAULT '[]',
        system_prompt TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        sdk_session_id TEXT,
        project_id TEXT NOT NULL REFERENCES projects(id),
        status TEXT NOT NULL DEFAULT 'idle',
        created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,
        turn_count INTEGER NOT NULL DEFAULT 0,
        current_task_id TEXT
      );

      CREATE TABLE IF NOT EXISTS agent_tasks (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        project_id TEXT,
        skill_name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        priority TEXT NOT NULL DEFAULT 'normal',
        result TEXT,
        duration_ms INTEGER,
        errors TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        source TEXT NOT NULL,
        project_id TEXT,
        payload TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);

      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cron TEXT NOT NULL,
        timezone TEXT NOT NULL DEFAULT 'UTC',
        task_type TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS preferences (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
];
