import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDatabase, getDb, initDatabase } from '../db/database.ts';
import { isCurrentProject } from '../project-manager/project-active.ts';
import { ProjectRegistry } from '../project-registry/project-registry.ts';

describe('current project checks', () => {
  let root: string;
  let registry: ProjectRegistry;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'raven-project-active-'));
    initDatabase(join(root, 'test.db'));
    mkdirSync(join(root, 'alpha'), { recursive: true });
    writeFileSync(join(root, 'context.md'), 'Global context');
    writeFileSync(join(root, 'alpha', 'context.md'), 'Alpha context');
    registry = new ProjectRegistry();
    await registry.load(root);
    const now = Date.now();
    getDb()
      .prepare(
        'INSERT INTO projects (id, name, skills, fs_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('alpha', 'Alpha', '[]', 'alpha', now, now);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps a rejected project inactive until a valid definition reloads', async () => {
    expect(isCurrentProject(getDb(), 'alpha', registry)).toBe(true);

    writeFileSync(join(root, 'alpha', 'context.md'), '---\nravenProject: [\n---\n');
    await registry.load(root);
    expect(registry.getDefinitionDiagnostics()).toEqual([
      expect.objectContaining({ path: 'alpha/context.md', code: 'invalid-project-context' }),
    ]);
    expect(isCurrentProject(getDb(), 'alpha', registry)).toBe(false);

    writeFileSync(join(root, 'alpha', 'context.md'), 'Alpha context restored');
    await registry.load(root);
    expect(isCurrentProject(getDb(), 'alpha', registry)).toBe(true);
  });
});
