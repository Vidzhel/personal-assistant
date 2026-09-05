import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureProjectRoot } from '../project-manager/definition-root.ts';

const resources: Array<{ root: string; db: Database.Database }> = [];

afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.db.close();
    rmSync(resource.root, { recursive: true, force: true });
  }
});

function fixture(): { root: string; db: Database.Database } {
  const root = mkdtempSync(join(tmpdir(), 'raven-definition-root-'));
  const db = new Database(join(root, 'runtime.db'));
  db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, fs_path TEXT);');
  const result = { root, db };
  resources.push(result);
  return result;
}

describe('ensureProjectRoot', () => {
  it('creates a missing root for a fresh operational database', () => {
    const { root, db } = fixture();
    const projectsDir = join(root, 'projects');

    ensureProjectRoot(projectsDir, db);

    expect(existsSync(projectsDir)).toBe(true);
  });

  it('refuses to recreate a missing root while cache paths exist', () => {
    const { root, db } = fixture();
    const projectsDir = join(root, 'projects');
    db.prepare('INSERT INTO projects (id, fs_path) VALUES (?, ?)').run('project-id', 'project');

    expect(() => ensureProjectRoot(projectsDir, db)).toThrow('cache row project-id');
    expect(existsSync(projectsDir)).toBe(false);
    expect(db.prepare('SELECT * FROM projects').all()).toEqual([
      { id: 'project-id', fs_path: 'project' },
    ]);
  });
});
