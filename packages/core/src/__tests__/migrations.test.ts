import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runFileMigrations } from '../db/migrations.ts';
import { initDatabase } from '../db/database.ts';

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

  it('creates all permission and pipeline tables with correct columns', () => {
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
        'pipeline_name',
      ]),
    );

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
        'pipeline_name',
      ]),
    );

    // pipeline_runs columns
    const pipelineCols = db.pragma('table_info(pipeline_runs)') as Array<{ name: string }>;
    const pipelineColNames = pipelineCols.map((c) => c.name);
    expect(pipelineColNames).toEqual(
      expect.arrayContaining([
        'id',
        'pipeline_name',
        'trigger_type',
        'status',
        'started_at',
        'completed_at',
        'node_results',
        'error',
      ]),
    );

    db.close();
  });

  it('handles backward compatibility with legacy 001-init migration', () => {
    const db = new Database(dbPath);

    // Simulate the old system: create _migrations and record 001-init
    db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      )
    `);
    db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(
      '001-init',
      Date.now(),
    );

    // Also create tables as old system would have
    db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL)');

    // Now run file-based migrations with 001-initial-schema + 002
    writeFileSync(
      join(migrationsDir, '001-initial-schema.sql'),
      'CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);',
    );
    writeFileSync(
      join(migrationsDir, '002-permission-tables.sql'),
      'CREATE TABLE IF NOT EXISTS audit_log (id TEXT PRIMARY KEY);',
    );

    runFileMigrations(db, migrationsDir);

    // 001-init should be renamed to 001-initial-schema
    const applied = db.prepare('SELECT name FROM _migrations ORDER BY id').all() as Array<{
      name: string;
    }>;
    const names = applied.map((r) => r.name);
    expect(names).toContain('001-initial-schema');
    expect(names).not.toContain('001-init');
    expect(names).toContain('002-permission-tables');

    db.close();
  });
});
