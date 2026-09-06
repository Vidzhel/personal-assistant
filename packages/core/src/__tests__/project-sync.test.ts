import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { initDatabase, getDb } from '../db/database.ts';
import { ProjectRegistry } from '../project-registry/project-registry.ts';
import { createScaffoldingApi } from '../scaffolding/scaffolding-api.ts';
import { createAgentYamlStore } from '../project-registry/agent-yaml-store.ts';
import {
  kebabCase,
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

async function buildDeps(projectsDir: string): Promise<ProjectSyncDeps> {
  const projectRegistry = new ProjectRegistry();
  await projectRegistry.load(projectsDir);
  const scaffoldingApi = createScaffoldingApi({
    projectsDir,
    projectRegistry,
    agentYamlStore: createAgentYamlStore(),
  });
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
    expect(db.prepare('SELECT fs_path FROM projects WHERE id = ?').get('meta')).toMatchObject({
      fs_path: 'system',
    });
  });

  it('keeps built-in system identity and read-write access for plain context.md', async () => {
    mkdirSync(join(projectsDir, 'system'));
    writeFileSync(join(projectsDir, 'system', 'context.md'), '# System body\n');
    const deps = await buildDeps(projectsDir);

    await runProjectSync(deps);

    expect(db.prepare('SELECT * FROM projects WHERE id = ?').get('meta')).toMatchObject({
      name: 'Raven System',
      system_access: 'read-write',
      is_meta: 1,
      fs_path: 'system',
    });
  });

  it('keeps explicit system metadata authoritative over built-in defaults', async () => {
    mkdirSync(join(projectsDir, 'system'));
    writeFileSync(
      join(projectsDir, 'system', 'context.md'),
      '---\nravenProject:\n  version: 1\n  id: meta\n  displayName: Controlled System\n  skills: [system-skill]\n  systemPrompt: Explicit system prompt\n  systemAccess: none\n---\nSystem body\n',
    );
    const deps = await buildDeps(projectsDir);

    await runProjectSync(deps);

    expect(db.prepare('SELECT * FROM projects WHERE id = ?').get('meta')).toMatchObject({
      name: 'Controlled System',
      skills: '["system-skill"]',
      system_prompt: 'Explicit system prompt',
      system_access: 'none',
      fs_path: 'system',
    });
  });

  it('creates a cache row for a current directory with a path-derived ID', async () => {
    mkdirSync(join(projectsDir, 'design'));
    writeFileSync(join(projectsDir, 'design', 'context.md'), '# Design\n');

    const deps = await buildDeps(projectsDir);
    const result = await runProjectSync(deps);

    expect(result.created).toBeGreaterThanOrEqual(1);
    expect(
      db.prepare('SELECT id, name, fs_path FROM projects WHERE fs_path = ?').get('design'),
    ).toEqual({
      id: 'design',
      name: 'design',
      fs_path: 'design',
    });
  });

  it('uses a stable path ID for plain files and ignores SQL name matches/settings', async () => {
    mkdirSync(join(projectsDir, 'legacy-project'));
    const body = '# Legacy Project\n\nHuman-owned body.\n';
    writeFileSync(join(projectsDir, 'legacy-project', 'context.md'), body);
    const now = Date.now();
    db.prepare(
      "INSERT INTO projects (id, name, description, skills, system_access, created_at, updated_at) VALUES ('legacy-uuid', 'Legacy Project', 'stale', '[\"stale\"]', 'read', ?, ?)",
    ).run(now, now);

    const deps = await buildDeps(projectsDir);
    const result = await runProjectSync(deps);

    expect(result.created).toBeGreaterThanOrEqual(1);
    expect(result.dropped).toBeGreaterThanOrEqual(1);
    expect(db.prepare('SELECT 1 FROM projects WHERE id = ?').get('legacy-uuid')).toBeUndefined();
    expect(db.prepare('SELECT * FROM projects WHERE id = ?').get('legacy-project')).toMatchObject({
      name: 'legacy-project',
      description: null,
      skills: '[]',
      system_access: 'none',
      fs_path: 'legacy-project',
    });
    expect(readFileSync(join(projectsDir, 'legacy-project', 'context.md'), 'utf8')).toBe(body);
  });

  it('takes omitted metadata fields from file defaults instead of the cache', async () => {
    mkdirSync(join(projectsDir, 'current'));
    writeFileSync(
      join(projectsDir, 'current', 'context.md'),
      '---\nravenProject:\n  version: 1\n  id: current\n  displayName: Current\n---\nOwner body\n',
    );
    const now = Date.now();
    db.prepare(
      "INSERT INTO projects (id, name, description, skills, system_prompt, system_access, fs_path, created_at, updated_at) VALUES ('current', 'Old name', 'Old description', '[\"old\"]', 'Old prompt', 'read', 'current', ?, ?)",
    ).run(now, now);

    const deps = await buildDeps(projectsDir);
    const result = await runProjectSync(deps);

    expect(result.scaffolded).toBe(0);
    expect(db.prepare('SELECT * FROM projects WHERE id = ?').get('current')).toMatchObject({
      name: 'Current',
      description: null,
      skills: '[]',
      system_prompt: null,
      system_access: 'none',
      fs_path: 'current',
    });
  });

  it('rebuilds metadata and plain projects after cache loss', async () => {
    mkdirSync(join(projectsDir, 'plain'));
    writeFileSync(join(projectsDir, 'plain', 'context.md'), '# Plain\n');
    mkdirSync(join(projectsDir, 'managed'));
    writeFileSync(
      join(projectsDir, 'managed', 'context.md'),
      '---\nravenProject: {version: 1, id: stable-managed, displayName: Managed}\n---\nBody\n',
    );
    const deps = await buildDeps(projectsDir);
    await runProjectSync(deps);
    db.prepare('DELETE FROM projects WHERE is_meta = 0').run();

    const result = await runProjectSync(deps);

    expect(result.created).toBe(3);
    expect(db.prepare('SELECT fs_path FROM projects WHERE id = ?').get('plain')).toEqual({
      fs_path: 'plain',
    });
    expect(db.prepare('SELECT fs_path FROM projects WHERE id = ?').get('stable-managed')).toEqual({
      fs_path: 'managed',
    });
    expect(
      db.prepare('SELECT name, fs_path FROM projects WHERE id = ?').get('telegram-default'),
    ).toEqual({ name: 'Inbox / Today', fs_path: 'telegram-default' });
  });

  it('drops an unreferenced stale row without recreating its directory', async () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO projects (id, name, description, skills, created_at, updated_at) VALUES ('orphan-unreferenced', 'Orphan Unreferenced', NULL, '[]', ?, ?)",
    ).run(now, now);
    const deps = await buildDeps(projectsDir);

    const result = await runProjectSync(deps);

    expect(result.dropped).toBeGreaterThanOrEqual(1);
    expect(
      db.prepare('SELECT 1 FROM projects WHERE id = ?').get('orphan-unreferenced'),
    ).toBeUndefined();
    expect(existsSync(join(projectsDir, 'orphan-unreferenced'))).toBe(false);
  });

  it('retains referenced stale rows as tombstones without scaffolding', async () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO projects (id, name, description, skills, fs_path, created_at, updated_at) VALUES ('orphan-referenced', 'Orphan Referenced', NULL, '[]', 'old-path', ?, ?)",
    ).run(now, now);
    db.prepare(
      "INSERT INTO sessions (id, project_id, status, created_at, last_active_at, turn_count) VALUES ('sess-1', 'orphan-referenced', 'idle', ?, ?, 0)",
    ).run(now, now);
    const deps = await buildDeps(projectsDir);

    const result = await runProjectSync(deps);

    expect(result.scaffolded).toBe(0);
    expect(
      db.prepare('SELECT fs_path FROM projects WHERE id = ?').get('orphan-referenced'),
    ).toEqual({
      fs_path: null,
    });
    expect(existsSync(join(projectsDir, 'orphan-referenced'))).toBe(false);
  });

  it('does not automatically rebind a referenced stale ID', async () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO projects (id, name, description, skills, created_at, updated_at) VALUES ('rebind-me', 'Old project', 'Old data', '[]', ?, ?)",
    ).run(now, now);
    db.prepare(
      "INSERT INTO sessions (id, project_id, status, created_at, last_active_at, turn_count) VALUES ('sess-rebind', 'rebind-me', 'idle', ?, ?, 0)",
    ).run(now, now);
    mkdirSync(join(projectsDir, 'rebind-me'));
    writeFileSync(join(projectsDir, 'rebind-me', 'context.md'), '# Recreated\n');
    const deps = await buildDeps(projectsDir);

    await expect(runProjectSync(deps)).rejects.toThrow('cannot be rebound');
    expect(db.prepare('SELECT fs_path FROM projects WHERE id = ?').get('rebind-me')).toEqual({
      fs_path: null,
    });
    expect(readFileSync(join(projectsDir, 'rebind-me', 'context.md'), 'utf8')).toBe(
      '# Recreated\n',
    );
  });

  it('rejects a same-path metadata identity change', async () => {
    const now = Date.now();
    mkdirSync(join(projectsDir, 'identity'));
    writeFileSync(
      join(projectsDir, 'identity', 'context.md'),
      '---\nravenProject: {version: 1, id: current-id}\n---\nBody\n',
    );
    db.prepare(
      "INSERT INTO projects (id, name, description, skills, fs_path, created_at, updated_at) VALUES ('old-id', 'Old', NULL, '[]', 'identity', ?, ?)",
    ).run(now, now);
    const deps = await buildDeps(projectsDir);

    await expect(runProjectSync(deps)).rejects.toThrow('identity conflicts');
    expect(db.prepare('SELECT fs_path FROM projects WHERE id = ?').get('old-id')).toMatchObject({
      fs_path: 'identity',
    });
  });

  it('is idempotent — running twice does not duplicate or error', async () => {
    const deps = await buildDeps(projectsDir);
    await runProjectSync(deps);
    await deps.projectRegistry.load(projectsDir);
    await expect(runProjectSync(deps)).resolves.not.toThrow();

    expect(db.prepare('SELECT COUNT(*) AS c FROM projects').get()).toEqual({ c: 2 });
  });
});
