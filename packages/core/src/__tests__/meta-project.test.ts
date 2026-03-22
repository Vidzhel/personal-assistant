import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase } from '../db/database.ts';
import { getMetaProject, isMetaProject, META_PROJECT_ID } from '../project-manager/meta-project.ts';
import type Database from 'better-sqlite3';

describe('meta-project migration (017)', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-meta-test-'));
    db = initDatabase(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('adds system_access and is_meta columns to projects table', () => {
    const cols = db.pragma('table_info(projects)') as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('system_access');
    expect(colNames).toContain('is_meta');
  });

  it('creates idx_projects_is_meta index', () => {
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='projects'")
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain('idx_projects_is_meta');
  });

  it('seeds the meta-project with correct values', () => {
    const meta = db.prepare('SELECT * FROM projects WHERE id = ?').get('meta') as Record<
      string,
      unknown
    >;
    expect(meta).toBeDefined();
    expect(meta.name).toBe('Raven System');
    expect(meta.description).toBe('System management and administration');
    expect(meta.system_access).toBe('read-write');
    expect(meta.is_meta).toBe(1);
  });

  it('defaults system_access to none for new projects', () => {
    // Insert a regular project (simulating pre-migration data would have default)
    db.prepare(
      "INSERT INTO projects (id, name, skills, created_at, updated_at) VALUES ('test', 'Test', '[]', ?, ?)",
    ).run(Date.now(), Date.now());

    const project = db
      .prepare('SELECT system_access, is_meta FROM projects WHERE id = ?')
      .get('test') as Record<string, unknown>;
    expect(project.system_access).toBe('none');
    expect(project.is_meta).toBe(0);
  });
});

describe('meta-project store', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-meta-store-'));
    db = initDatabase(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('getMetaProject() returns the meta-project with correct fields', () => {
    const meta = getMetaProject();
    expect(meta.id).toBe('meta');
    expect(meta.name).toBe('Raven System');
    expect(meta.systemAccess).toBe('read-write');
    expect(meta.isMeta).toBe(true);
  });

  it('getMetaProject() throws if meta-project is missing', () => {
    db.prepare('DELETE FROM projects WHERE is_meta = 1').run();
    expect(() => getMetaProject()).toThrow('Meta-project not found');
  });

  it('isMetaProject() returns true for meta ID', () => {
    expect(isMetaProject(META_PROJECT_ID)).toBe(true);
    expect(isMetaProject('meta')).toBe(true);
  });

  it('isMetaProject() returns false for other IDs', () => {
    expect(isMetaProject('some-other-project')).toBe(false);
  });

  it('META_PROJECT_ID is "meta"', () => {
    expect(META_PROJECT_ID).toBe('meta');
  });
});
