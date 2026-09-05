import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runFileMigrations } from '../db/migrations.ts';
import { closeDatabase, getDb, initDatabase } from '../db/database.ts';

describe('migrations', () => {
  let tmpDir: string;
  let dbPath: string;
  let migrationsDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-mig-test-'));
    dbPath = join(tmpDir, 'test.db');
    migrationsDir = join(tmpDir, 'migrations');
    mkdirSync(migrationsDir);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs migrations in numeric order on fresh DB', () => {
    const db = new Database(dbPath);
    writeFileSync(join(migrationsDir, '001-first.sql'), 'CREATE TABLE t1 (id TEXT PRIMARY KEY);');
    writeFileSync(join(migrationsDir, '002-second.sql'), 'CREATE TABLE t2 (id TEXT PRIMARY KEY);');

    runFileMigrations(db, migrationsDir);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('t1');
    expect(names).toContain('t2');

    const applied = db.prepare('SELECT name FROM _migrations ORDER BY id').all() as Array<{
      name: string;
    }>;
    expect(applied.map((r) => r.name)).toEqual(['001-first', '002-second']);

    db.close();
  });

  it('skips already-applied migrations (idempotent)', () => {
    const db = new Database(dbPath);
    writeFileSync(join(migrationsDir, '001-first.sql'), 'CREATE TABLE t1 (id TEXT PRIMARY KEY);');

    runFileMigrations(db, migrationsDir);
    runFileMigrations(db, migrationsDir);

    const applied = db.prepare('SELECT COUNT(*) as c FROM _migrations').get() as { c: number };
    expect(applied.c).toBe(1);

    db.close();
  });

  it('rolls back transaction on bad SQL', () => {
    const db = new Database(dbPath);
    writeFileSync(join(migrationsDir, '001-good.sql'), 'CREATE TABLE t1 (id TEXT PRIMARY KEY);');
    writeFileSync(join(migrationsDir, '002-bad.sql'), 'INVALID SQL STATEMENT;');

    // First call applies 001 then throws on 002
    expect(() => runFileMigrations(db, migrationsDir)).toThrow();

    // 001 should have been applied, 002 rolled back
    const applied = db.prepare('SELECT name FROM _migrations').all() as Array<{ name: string }>;
    expect(applied.map((r) => r.name)).toEqual(['001-good']);

    // t1 exists (from 001), but nothing from 002
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
      name: string;
    }>;
    expect(tables.map((t) => t.name)).toContain('t1');

    db.close();
  });

  it('creates current permission tables without retired pipeline annotations', () => {
    const db = initDatabase(dbPath);

    // audit_log columns
    const auditCols = db.pragma('table_info(audit_log)') as Array<{ name: string }>;
    const auditColNames = auditCols.map((c) => c.name);
    expect(auditColNames).toEqual(
      expect.arrayContaining([
        'id',
        'timestamp',
        'skill_name',
        'action_name',
        'permission_tier',
        'outcome',
        'details',
        'session_id',
      ]),
    );
    expect(auditColNames).not.toContain('pipeline_name');

    // pending_approvals columns
    const approvalCols = db.pragma('table_info(pending_approvals)') as Array<{ name: string }>;
    const approvalColNames = approvalCols.map((c) => c.name);
    expect(approvalColNames).toEqual(
      expect.arrayContaining([
        'id',
        'action_name',
        'skill_name',
        'details',
        'requested_at',
        'resolved_at',
        'resolution',
        'session_id',
      ]),
    );
    expect(approvalColNames).not.toContain('pipeline_name');

    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pipeline_runs'")
        .get(),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='project_data_sources'").get(),
    ).toBeUndefined();

    db.close();
  });

  it('rejects an unsupported historical migration history without rewriting it', () => {
    const db = new Database(dbPath);

    // Simulate a database created by the removed historical migration chain.
    db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      )
    `);
    db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(
      '004-execution-logging',
      Date.now(),
    );
    writeFileSync(
      join(migrationsDir, '001-initial-schema.sql'),
      'CREATE TABLE projects (id TEXT PRIMARY KEY);',
    );
    expect(() => runFileMigrations(db, migrationsDir)).toThrow(
      'Unsupported database migration history: 004-execution-logging',
    );
    const applied = db.prepare('SELECT name FROM _migrations').all() as Array<{ name: string }>;
    expect(applied.map((row) => row.name)).toEqual(['004-execution-logging']);
    db.close();
  });

  it('does not mark a failed fresh schema as applied', () => {
    const db = new Database(dbPath);
    writeFileSync(
      join(migrationsDir, '001-initial-schema.sql'),
      'CREATE TABLE projects (id TEXT PRIMARY KEY); INVALID SQL;',
    );
    expect(() => runFileMigrations(db, migrationsDir)).toThrow();
    expect(db.prepare('SELECT name FROM _migrations').all()).toEqual([]);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'projects'").get(),
    ).toBeUndefined();

    db.close();
  });

  it('rolls back duplicate-column failures instead of accepting a partial script', () => {
    const db = new Database(dbPath);
    db.exec('CREATE TABLE existing (id TEXT PRIMARY KEY);');
    writeFileSync(
      join(migrationsDir, '001-initial-schema.sql'),
      'CREATE TABLE partial (id TEXT); ALTER TABLE existing ADD COLUMN id TEXT;',
    );

    expect(() => runFileMigrations(db, migrationsDir)).toThrow('duplicate column name');
    expect(db.prepare('SELECT name FROM _migrations').all()).toEqual([]);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'partial'").get(),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'existing'").get(),
    ).toBeDefined();
    db.close();
  });

  it('does not expose a database handle after initialization fails and can retry cleanly', () => {
    const schema = join(migrationsDir, '001-initial-schema.sql');
    writeFileSync(schema, 'CREATE TABLE partial (id TEXT); INVALID SQL;');
    expect(() => initDatabase(dbPath, migrationsDir)).toThrow();
    expect(() => getDb()).toThrow('Database not initialized');

    writeFileSync(schema, 'CREATE TABLE current (id TEXT PRIMARY KEY);');
    const db = initDatabase(dbPath, migrationsDir);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'partial'").get(),
    ).toBeUndefined();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'current'").get()).toBeDefined();
    expect(db.prepare('SELECT name FROM _migrations').all()).toEqual([
      { name: '001-initial-schema' },
    ]);
  });
});
