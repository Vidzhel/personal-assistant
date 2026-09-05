import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase, getDb, closeDatabase } from '../db/database.ts';
import { registerTemplateRoutes } from '../api/routes/templates.ts';
import { TemplateRegistry } from '../template-engine/template-registry.ts';
import type { TemplateScheduler } from '../template-engine/template-scheduler.ts';

describe('template API canonical project identity', () => {
  let root: string;
  let app: ReturnType<typeof Fastify>;
  let parentId: string;
  let childId: string;

  function project(path: string | null): string {
    const id = randomUUID();
    getDb()
      .prepare(
        'INSERT INTO projects (id, name, skills, fs_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, path ?? 'Unlinked', '[]', path, 1, 1);
    if (path) {
      mkdirSync(join(root, 'projects', path), { recursive: true });
      writeFileSync(join(root, 'projects', path, 'context.md'), '# Fixture project');
    }
    return id;
  }

  function template(path: string, name: string, displayName: string): void {
    const dir = join(root, 'projects', path, 'templates');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${name}.yaml`),
      JSON.stringify({
        name,
        displayName,
        description: 'Fixture template',
        plan: { approval: 'auto', parallel: false },
        tasks: [
          {
            id: 'notify',
            type: 'notify',
            title: 'Notify',
            channel: 'telegram',
            message: 'Fixture only',
          },
        ],
      }),
    );
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'raven-template-scope-'));
    initDatabase(join(root, 'test.db'));
    parentId = project('research');
    childId = project('research/chapter');
    project('unrelated');
    template('', 'shared', 'Global');
    template('research', 'shared', 'Parent override');
    template('research', 'parent-only', 'Parent only');
    template('research/chapter', 'shared', 'Child override');
    template('research/chapter', 'child-only', 'Child only');
    template('unrelated', 'unrelated-only', 'Unrelated');
    const registry = new TemplateRegistry();
    await registry.load(join(root, 'projects'));
    app = Fastify();
    registerTemplateRoutes(app, {
      templateRegistry: registry,
      templateScheduler: {} as TemplateScheduler,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    closeDatabase();
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves parent and child UUIDs to their inherited template scopes', async () => {
    const parent = await app.inject(`/api/templates?projectId=${parentId}`);
    expect(parent.statusCode).toBe(200);
    expect(
      parent
        .json()
        .map((t: { displayName: string }) => t.displayName)
        .sort(),
    ).toEqual(['Parent only', 'Parent override']);
    const child = await app.inject(`/api/templates?projectId=${childId}`);
    expect(child.statusCode).toBe(200);
    expect(
      child
        .json()
        .map((t: { displayName: string }) => t.displayName)
        .sort(),
    ).toEqual(['Child only', 'Child override', 'Parent only']);
  });

  it('rejects unknown or path-shaped IDs and gives an unlinked project no unrelated templates', async () => {
    expect((await app.inject(`/api/templates?projectId=${randomUUID()}`)).statusCode).toBe(404);
    expect((await app.inject('/api/templates?projectId=research')).statusCode).toBe(404);
    const unlinked = await app.inject(`/api/templates?projectId=${project(null)}`);
    expect(unlinked.statusCode).toBe(200);
    expect(unlinked.json()).toEqual([]);
  });
});
