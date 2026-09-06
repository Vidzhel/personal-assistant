import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { initDatabase } from '../db/database.ts';
import { ProjectRegistry } from '../project-registry/project-registry.ts';
import { syncProjectCache } from '../project-manager/project-sync.ts';
import { isCurrentProject } from '../project-manager/project-active.ts';
import { writeProjectDefinition } from '../project-registry/project-definition.ts';

describe('definition diagnostics preserve inactive project cache evidence', () => {
  let root: string;
  let db: Database.Database;
  let registry: ProjectRegistry;
  let blocked: string[];

  function context(path: string): string {
    return join(root, path, 'context.md');
  }

  function define(path: string, id = path): void {
    mkdirSync(join(root, path), { recursive: true });
    writeFileSync(context(path), writeProjectDefinition(`# ${path}\n`, { version: 1, id }));
    writeFileSync(join(root, path, 'project.yaml'), 'version: 1\n');
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'raven-project-diagnostics-'));
    db = initDatabase(join(root, 'test.db'));
    blocked = [];
    registry = new ProjectRegistry({ getUnavailableProjectPaths: () => blocked });
    define('broken', 'parent-id');
    define('broken/child', 'child-id');
    define('healthy', 'healthy-id');
    await registry.load(root);
    syncProjectCache({ db, projectRegistry: registry });
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('preserves both referenced and unreferenced rows below a malformed definition', async () => {
    const before = db
      .prepare('SELECT * FROM projects WHERE id IN (?, ?) ORDER BY id')
      .all('parent-id', 'child-id');
    db.prepare(
      'INSERT INTO sessions (id, project_id, name, created_at, last_active_at) VALUES (?, ?, ?, ?, ?)',
    ).run('reference', 'child-id', 'Existing session', 1, 1);
    writeFileSync(
      context('broken'),
      '---\nravenProject: {version: 1, systemAccess: invalid}\n---\nKeep me\n',
    );
    await registry.load(root);
    const result = syncProjectCache({ db, projectRegistry: registry });
    expect(result.dropped).toBe(0);
    expect(
      db
        .prepare('SELECT * FROM projects WHERE id IN (?, ?) ORDER BY id')
        .all('parent-id', 'child-id'),
    ).toEqual(before);
    expect(isCurrentProject(db, 'parent-id', registry)).toBe(false);
    expect(isCurrentProject(db, 'child-id', registry)).toBe(false);
    expect(isCurrentProject(db, 'healthy-id', registry)).toBe(true);
    expect(readFileSync(context('broken'), 'utf8')).toContain('Keep me');
    expect(registry.getInvalidProjectPaths()).toContain('broken');
  });

  it('reactivates the same identities after repair without losing their paths', async () => {
    const original = readFileSync(context('broken'), 'utf8');
    writeFileSync(context('broken'), '---\nravenProject: [invalid]\n---\n');
    await registry.load(root);
    syncProjectCache({ db, projectRegistry: registry });
    writeFileSync(context('broken'), original);
    await registry.load(root);
    syncProjectCache({ db, projectRegistry: registry });
    expect(registry.getInvalidProjectPaths()).toEqual([]);
    expect(registry.getDefinitionDiagnostics()).toEqual([]);
    expect(isCurrentProject(db, 'parent-id', registry)).toBe(true);
    expect(isCurrentProject(db, 'child-id', registry)).toBe(true);
  });

  it('keeps unresolved mutation paths inactive without waiting for another scan', async () => {
    blocked = ['broken'];
    expect(registry.listProjects().map((project) => project.id)).toEqual(['healthy']);
    expect(registry.getProjectChildren('broken')).toEqual([]);
    syncProjectCache({ db, projectRegistry: registry });
    expect(isCurrentProject(db, 'parent-id', registry)).toBe(false);
    expect(isCurrentProject(db, 'child-id', registry)).toBe(false);
    expect(db.prepare('SELECT fs_path FROM projects WHERE id = ?').get('child-id')).toEqual({
      fs_path: 'broken/child',
    });
    expect(isCurrentProject(db, 'healthy-id', registry)).toBe(true);
    blocked = [];
    expect(isCurrentProject(db, 'child-id', registry)).toBe(true);
  });
});
