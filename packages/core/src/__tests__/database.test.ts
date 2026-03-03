import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, getDb, createDbInterface } from '../db/database.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('database', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-test-'));
    dbPath = join(tmpDir, 'test.db');
  });

  afterEach(() => {
    try {
      const db = getDb();
      db.close();
    } catch {
      // db may not be initialized
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('initDatabase creates tables', () => {
    const db = initDatabase(dbPath);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('projects');
    expect(tableNames).toContain('sessions');
    expect(tableNames).toContain('agent_tasks');
    expect(tableNames).toContain('events');
    expect(tableNames).toContain('schedules');
    expect(tableNames).toContain('preferences');
    expect(tableNames).toContain('_migrations');
  });

  it('migrations run idempotently', () => {
    initDatabase(dbPath);
    const db1 = getDb();
    const count1 = (
      db1.prepare('SELECT COUNT(*) as c FROM _migrations').get() as { c: number }
    ).c;
    db1.close();

    // Re-initialize — migrations should not duplicate
    initDatabase(dbPath);
    const db2 = getDb();
    const count2 = (
      db2.prepare('SELECT COUNT(*) as c FROM _migrations').get() as { c: number }
    ).c;
    expect(count2).toBe(count1);
  });

  it('WAL mode is enabled', () => {
    const db = initDatabase(dbPath);
    const mode = db.pragma('journal_mode') as Array<{ journal_mode: string }>;
    expect(mode[0].journal_mode).toBe('wal');
  });

  it('CRUD on projects table', () => {
    initDatabase(dbPath);
    const dbi = createDbInterface();
    const now = Date.now();

    // Create
    dbi.run(
      'INSERT INTO projects (id, name, description, skills, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      'p1', 'Test Project', 'A test', '[]', now, now,
    );

    // Read
    const project = dbi.get<{ id: string; name: string }>(
      'SELECT * FROM projects WHERE id = ?',
      'p1',
    );
    expect(project).toBeDefined();
    expect(project!.name).toBe('Test Project');

    // Update
    dbi.run('UPDATE projects SET name = ? WHERE id = ?', 'Updated', 'p1');
    const updated = dbi.get<{ name: string }>('SELECT name FROM projects WHERE id = ?', 'p1');
    expect(updated!.name).toBe('Updated');

    // List
    dbi.run(
      'INSERT INTO projects (id, name, skills, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      'p2', 'Second', '[]', now, now,
    );
    const all = dbi.all<{ id: string }>('SELECT * FROM projects');
    expect(all).toHaveLength(2);

    // Delete
    dbi.run('DELETE FROM projects WHERE id = ?', 'p1');
    const deleted = dbi.get('SELECT * FROM projects WHERE id = ?', 'p1');
    expect(deleted).toBeUndefined();
  });

  it('CRUD on agent_tasks table', () => {
    initDatabase(dbPath);
    const dbi = createDbInterface();
    const now = Date.now();

    dbi.run(
      'INSERT INTO agent_tasks (id, skill_name, prompt, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      't1', 'orchestrator', 'hello', 'queued', 'normal', now,
    );

    const task = dbi.get<{ id: string; status: string }>(
      'SELECT * FROM agent_tasks WHERE id = ?',
      't1',
    );
    expect(task!.status).toBe('queued');
  });

  it('CRUD on sessions table', () => {
    initDatabase(dbPath);
    const dbi = createDbInterface();
    const now = Date.now();

    // Need a project for FK
    dbi.run(
      'INSERT INTO projects (id, name, skills, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      'p1', 'Test', '[]', now, now,
    );

    dbi.run(
      'INSERT INTO sessions (id, project_id, status, created_at, last_active_at, turn_count) VALUES (?, ?, ?, ?, ?, ?)',
      's1', 'p1', 'idle', now, now, 0,
    );

    const session = dbi.get<{ id: string; status: string }>(
      'SELECT * FROM sessions WHERE id = ?',
      's1',
    );
    expect(session!.status).toBe('idle');
  });
});
