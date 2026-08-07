import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { initDatabase, getDb } from '../db/database.ts';
import { ProjectRegistry } from '../project-registry/project-registry.ts';
import { createScaffoldingApi } from '../scaffolding/scaffolding-api.ts';
import { createAgentYamlStore } from '../project-registry/agent-yaml-store.ts';
import {
  kebabCase,
  uniqueFsPath,
  runProjectSync,
  type ProjectSyncDeps,
} from '../project-manager/project-sync.ts';

describe('kebabCase', () => {
  it('lowercases and hyphenates spaces', () => {
    expect(kebabCase('Marketing Team')).toBe('marketing-team');
  });

  it('strips punctuation and collapses separators', () => {
    expect(kebabCase("Bob's  Project!!")).toBe('bob-s-project');
  });

  it('falls back to "untitled" for inputs that reduce to nothing', () => {
    expect(kebabCase('!!! 🎉 !!!')).toBe('untitled');
  });
});

describe('uniqueFsPath', () => {
  it('returns the base path when there is no collision', async () => {
    const reg = new ProjectRegistry();
    const dir = mkdtempSync(join(tmpdir(), 'raven-unique-fs-'));
    await reg.load(dir);
    expect(uniqueFsPath(reg, 'inbox')).toBe('inbox');
    rmSync(dir, { recursive: true, force: true });
  });
});

async function buildDeps(projectsDir: string): Promise<ProjectSyncDeps> {
  const projectRegistry = new ProjectRegistry();
  await projectRegistry.load(projectsDir);
  const agentYamlStore = createAgentYamlStore();
  const scaffoldingApi = createScaffoldingApi({ projectsDir, projectRegistry, agentYamlStore });
  return { db: getDb(), projectRegistry, scaffoldingApi, projectsDir };
}

describe('runProjectSync', () => {
  let tmpDir: string;
  let projectsDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-project-sync-'));
    projectsDir = join(tmpDir, 'projects');
    mkdirSync(projectsDir, { recursive: true });
    db = initDatabase(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('scaffolds projects/system and links the seeded meta-project row', async () => {
    const deps = await buildDeps(projectsDir);
    await runProjectSync(deps);

    expect(existsSync(join(projectsDir, 'system', 'context.md'))).toBe(true);

    const row = db.prepare('SELECT fs_path FROM projects WHERE id = ?').get('meta') as {
      fs_path: string | null;
    };
    expect(row.fs_path).toBe('system');
  });

  it('creates a cache row for a directory that exists but has no DB row', async () => {
    mkdirSync(join(projectsDir, 'design'));
    writeFileSync(join(projectsDir, 'design', 'context.md'), '# Design\n');

    const deps = await buildDeps(projectsDir);
    const result = await runProjectSync(deps);

    expect(result.created).toBeGreaterThanOrEqual(1);
    const row = db
      .prepare('SELECT id, name, fs_path FROM projects WHERE fs_path = ?')
      .get('design') as { id: string; name: string; fs_path: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.id).toBe('design');
  });

  it('links a legacy row (fs_path NULL) to a registry node with a matching name', async () => {
    mkdirSync(join(projectsDir, 'legacy-project'));
    writeFileSync(join(projectsDir, 'legacy-project', 'context.md'), '# Legacy Project\n');

    const now = Date.now();
    db.prepare(
      "INSERT INTO projects (id, name, description, skills, created_at, updated_at) VALUES ('legacy-uuid', 'Legacy Project', NULL, '[]', ?, ?)",
    ).run(now, now);

    const deps = await buildDeps(projectsDir);
    const result = await runProjectSync(deps);

    expect(result.linked).toBeGreaterThanOrEqual(1);
    const row = db.prepare('SELECT fs_path FROM projects WHERE id = ?').get('legacy-uuid') as {
      fs_path: string | null;
    };
    expect(row.fs_path).toBe('legacy-project');
  });

  it('scaffolds a directory for an orphan row still referenced by a session', async () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO projects (id, name, description, skills, created_at, updated_at) VALUES ('orphan-referenced', 'Orphan Referenced', NULL, '[]', ?, ?)",
    ).run(now, now);
    db.prepare(
      "INSERT INTO sessions (id, project_id, status, created_at, last_active_at, turn_count) VALUES ('sess-1', 'orphan-referenced', 'idle', ?, ?, 0)",
    ).run(now, now);

    const deps = await buildDeps(projectsDir);
    const result = await runProjectSync(deps);

    expect(result.scaffolded).toBeGreaterThanOrEqual(1);
    const row = db
      .prepare('SELECT fs_path FROM projects WHERE id = ?')
      .get('orphan-referenced') as {
      fs_path: string | null;
    };
    expect(row.fs_path).toBe('orphan-referenced');
    expect(existsSync(join(projectsDir, 'orphan-referenced', 'context.md'))).toBe(true);
  });

  it('drops an orphan row with no registry node and no references', async () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO projects (id, name, description, skills, created_at, updated_at) VALUES ('orphan-unreferenced', 'Orphan Unreferenced', NULL, '[]', ?, ?)",
    ).run(now, now);

    const deps = await buildDeps(projectsDir);
    const result = await runProjectSync(deps);

    expect(result.dropped).toBeGreaterThanOrEqual(1);
    const row = db.prepare('SELECT 1 FROM projects WHERE id = ?').get('orphan-unreferenced');
    expect(row).toBeUndefined();
  });

  it('is idempotent — running twice does not duplicate or error', async () => {
    const deps = await buildDeps(projectsDir);
    await runProjectSync(deps);

    // Registry must be reloaded before the second pass to see anything
    // scaffolded by the first (mirrors boot behavior: the registry the
    // process holds is refreshed after every scaffold call).
    await deps.projectRegistry.load(projectsDir);
    await expect(runProjectSync(deps)).resolves.not.toThrow();

    const count = db.prepare('SELECT COUNT(*) as c FROM projects').get() as { c: number };
    expect(count.c).toBe(1); // just the meta-project row
  });
});
