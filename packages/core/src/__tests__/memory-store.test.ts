import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { listPendingCandidates } from '../agent-memory/memory-candidates.ts';
import { ProjectRegistry } from '../project-registry/project-registry.ts';
import { createProjectWorkspaceStore } from '../project-manager/project-workspace.ts';
import {
  createMemoryStore,
  formatMemoryBlock,
  resolveMemoryPath,
} from '../agent-memory/memory-store.ts';

interface Fixture {
  root: string;
  projectsDir: string;
  store: ReturnType<typeof createMemoryStore>;
}

const roots: string[] = [];

async function fixture(...ids: string[]): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'raven-memory-project-'));
  roots.push(root);
  const projectsDir = join(root, 'projects');
  mkdirSync(projectsDir, { recursive: true });
  writeFileSync(join(projectsDir, 'context.md'), '# Global\n');
  for (const id of ids) {
    mkdirSync(join(projectsDir, id), { recursive: true });
    writeFileSync(join(projectsDir, id, 'context.md'), '# ' + id + '\n');
  }
  const registry = new ProjectRegistry();
  await registry.load(projectsDir);
  const workspaceStore = createProjectWorkspaceStore({
    projectsDir,
    projectRegistry: registry,
    projectRoot: root,
  });
  return {
    root,
    projectsDir,
    store: createMemoryStore({ projectsDir, workspaceStore }),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('project-owned MemoryStore', () => {
  it('keeps project memory isolated and supports nested notes', async () => {
    const test = await fixture('alpha', 'beta');
    await test.store.write('alpha', 'facts/work.md', 'alpha note');
    expect(await test.store.read('alpha', 'facts/work.md')).toBe('alpha note');
    expect(await test.store.list('alpha')).toEqual(['facts/work.md']);
    expect(await test.store.list('beta')).toEqual([]);
    expect(test.store.getDirectory('alpha')).toContain('/alpha/memory');
  });

  it('does not create a memory directory while checking an unused project', async () => {
    const test = await fixture('alpha');
    expect(await test.store.list('alpha')).toEqual([]);
    expect(await test.store.readIndex('alpha')).toBeNull();
    expect(await listPendingCandidates(test.store, 'alpha')).toEqual([]);
    expect(existsSync(test.store.getDirectory('alpha'))).toBe(false);
  });

  it('reads an optional index and reports default budget', async () => {
    const test = await fixture('alpha');
    expect(await test.store.readIndex('alpha')).toBeNull();
    await test.store.write('alpha', 'MEMORY.md', '# Index\n');
    expect(await test.store.readIndex('alpha')).toBe('# Index\n');
    expect((await test.store.usage('alpha')).maxFiles).toBe(30);
    expect((await test.store.usage('alpha')).maxTotalBytes).toBe(64 * 1024);
  });

  it('updates and removes existing files while preserving missing-file semantics', async () => {
    const test = await fixture('alpha');
    expect((await test.store.update('alpha', 'missing.md', 'x')).ok).toBe(false);
    await test.store.write('alpha', 'note.md', 'one');
    expect((await test.store.update('alpha', 'note.md', 'two')).ok).toBe(true);
    expect(await test.store.read('alpha', 'note.md')).toBe('two');
    expect((await test.store.remove('alpha', 'note.md')).ok).toBe(true);
    expect((await test.store.remove('alpha', 'note.md')).ok).toBe(false);
  });

  it('rejects traversal, internal paths, non-Markdown files, and symlinks', async () => {
    const test = await fixture('alpha');
    for (const path of ['../escape.md', '/tmp/escape.md', 'candidates/x.md', '.tmp.md', 'x.txt']) {
      await expect(test.store.write('alpha', path, 'x')).rejects.toThrow(/memory|invalid/i);
    }
    const directory = test.store.getDirectory('alpha');
    mkdirSync(join(directory, 'nested'), { recursive: true });
    writeFileSync(join(directory, 'nested', 'real.md'), 'safe');
    symlinkSync(join(directory, 'nested', 'real.md'), join(directory, 'linked.md'));
    await expect(test.store.read('alpha', 'linked.md')).rejects.toThrow(/symlink|safely/i);
    await expect(test.store.list('alpha')).rejects.toThrow(/symlink|safely/i);
    expect(resolveMemoryPath(directory, 'candidates/internal.md', true)).toContain('candidates');
  });

  it('excludes candidates and dotfiles from ordinary listing and usage', async () => {
    const test = await fixture('alpha');
    const directory = test.store.getDirectory('alpha');
    mkdirSync(join(directory, 'candidates'), { recursive: true });
    mkdirSync(join(directory, '.tmp'), { recursive: true });
    writeFileSync(join(directory, 'candidates', 'candidate.md'), 'candidate');
    writeFileSync(join(directory, '.tmp', 'draft.md'), 'draft');
    await test.store.write('alpha', 'kept.md', 'kept');
    expect(await test.store.list('alpha')).toEqual(['kept.md']);
    expect((await test.store.usage('alpha')).files).toBe(1);
  });

  it('bounds all entries across recursive branches', async () => {
    const test = await fixture('alpha');
    const directory = test.store.getDirectory('alpha');
    for (const branch of ['left', 'right']) {
      for (let index = 0; index < 1_000; index += 1) {
        mkdirSync(join(directory, branch, String(index)), { recursive: true });
      }
    }
    await expect(test.store.list('alpha')).rejects.toThrow(/too many/i);
  });

  it('enforces workspace memory budget across concurrent writes', async () => {
    const test = await fixture('alpha');
    const registry = new ProjectRegistry();
    await registry.load(test.projectsDir);
    const configured = createProjectWorkspaceStore({
      projectsDir: test.projectsDir,
      projectRegistry: registry,
      projectRoot: test.root,
    });
    await configured.updateWorkspace('alpha', { memory: { maxFiles: 1, maxTotalKb: 1 } });
    const limited = createMemoryStore({
      projectsDir: test.projectsDir,
      workspaceStore: configured,
    });
    const results = await Promise.all([
      limited.write('alpha', 'one.md', 'one'),
      limited.write('alpha', 'two.md', 'two'),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect((await limited.usage('alpha')).files).toBe(1);
  });

  it('rejects inactive projects without creating directories', async () => {
    const test = await fixture('alpha');
    await expect(test.store.write('missing', 'note.md', 'x')).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(existsSync(join(test.projectsDir, 'missing'))).toBe(false);
  });

  it('rejects writes over directories and uses current external bytes as authority', async () => {
    const test = await fixture('alpha');
    const directory = test.store.getDirectory('alpha');
    mkdirSync(join(directory, 'folder.md'), { recursive: true });
    expect((await test.store.write('alpha', 'folder.md', 'x')).ok).toBe(false);
    await test.store.write('alpha', 'note.md', 'before');
    writeFileSync(join(directory, 'note.md'), 'external');
    expect((await test.store.update('alpha', 'note.md', 'after')).ok).toBe(true);
    expect(readFileSync(join(directory, 'note.md'), 'utf8')).toBe('after');
  });

  it('supports locked learning mutations with an explicit byte snapshot', async () => {
    const test = await fixture('alpha');
    expect(
      (
        await test.store.apply('alpha', {
          action: 'create',
          path: 'candidate.md',
          content: 'draft',
          expected: null,
        })
      ).ok,
    ).toBe(true);
    await expect(
      test.store.apply('alpha', {
        action: 'update',
        path: 'candidate.md',
        content: 'new',
        expected: 'wrong',
      }),
    ).rejects.toThrow(/changed/i);
    expect(
      (
        await test.store.apply('alpha', {
          action: 'update',
          path: 'candidate.md',
          content: 'new',
          expected: 'draft',
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await test.store.apply('alpha', {
          action: 'delete',
          path: 'candidate.md',
          expected: 'new',
        })
      ).ok,
    ).toBe(true);
  });

  it('formats an index for agent injection', () => {
    const block = formatMemoryBlock('# Index\n- fact\n');
    expect(block).toContain('## Your Memory');
    expect(block).toContain('memory_read');
    expect(block).toContain('# Index');
  });
});
