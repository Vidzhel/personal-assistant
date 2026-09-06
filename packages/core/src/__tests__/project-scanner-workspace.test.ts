import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dump as yamlDump } from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanProjects } from '../project-registry/project-scanner.ts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'raven-scanner-workspace-'));
  writeFileSync(join(tmpDir, 'context.md'), 'Global context');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function project(name: string): string {
  const path = join(tmpDir, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'context.md'), `${name} context`);
  return path;
}

function writeWorkspace(path: string, workspace: unknown): void {
  writeFileSync(join(path, 'project.yaml'), yamlDump(workspace));
}

function validWorkspace(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    execution: { mode: 'default' },
    sources: [],
    ...overrides,
  };
}

function folderSource(id: string): Record<string, unknown> {
  return {
    id,
    uri: `./${id}`,
    label: `${id} folder`,
    sourceType: 'folder',
    createdAt: '2026-09-06T00:00:00.000Z',
    updatedAt: '2026-09-06T00:00:00.000Z',
  };
}

describe('project workspace manifests', () => {
  it('marks only a malformed workspace subtree unavailable while a sibling remains loadable', async () => {
    const valid = project('valid');
    project('broken');
    writeWorkspace(valid, validWorkspace());
    writeFileSync(join(tmpDir, 'broken', 'project.yaml'), 'version: [');

    const index = await scanProjects(tmpDir);

    expect(index.projects.has('valid')).toBe(true);
    expect(index.projects.has('broken')).toBe(false);
    expect(index.invalidProjectPaths).toContain('broken');
    expect(index.diagnostics).toContainEqual(
      expect.objectContaining({
        path: 'broken/project.yaml',
        code: 'invalid-project-workspace',
        severity: 'error',
      }),
    );
  });

  it('clears the workspace diagnostic and reloads the repaired project', async () => {
    const path = project('repairable');
    writeFileSync(join(path, 'project.yaml'), 'execution: nope');
    const failed = await scanProjects(tmpDir);
    expect(failed.projects.has('repairable')).toBe(false);
    expect(failed.invalidProjectPaths).toContain('repairable');

    writeWorkspace(path, validWorkspace());
    const repaired = await scanProjects(tmpDir);

    expect(repaired.projects.has('repairable')).toBe(true);
    expect(repaired.invalidProjectPaths).not.toContain('repairable');
    expect(repaired.diagnostics).not.toContainEqual(
      expect.objectContaining({ path: 'repairable/project.yaml' }),
    );
  });

  it('accepts a current project without a workspace manifest', async () => {
    project('no-manifest');

    const index = await scanProjects(tmpDir);

    expect(index.projects.has('no-manifest')).toBe(true);
    expect(index.diagnostics).not.toContainEqual(
      expect.objectContaining({ path: 'no-manifest/project.yaml' }),
    );
  });

  it('rejects a symlink manifest without following it', async () => {
    const path = project('symlinked');
    const target = join(tmpDir, 'workspace-target.yaml');
    writeFileSync(target, yamlDump(validWorkspace()));
    symlinkSync(target, join(path, 'project.yaml'));

    const index = await scanProjects(tmpDir);

    expect(index.projects.has('symlinked')).toBe(false);
    expect(index.invalidProjectPaths).toContain('symlinked');
    expect(index.diagnostics).toContainEqual(
      expect.objectContaining({
        path: 'symlinked/project.yaml',
        code: 'invalid-project-workspace',
      }),
    );
    expect(lstatSync(join(path, 'project.yaml')).isSymbolicLink()).toBe(true);
  });

  it('reports a marked top-level project with a missing context anchor', async () => {
    const path = join(tmpDir, 'marked-without-context');
    mkdirSync(path, { recursive: true });
    writeWorkspace(path, validWorkspace());

    const index = await scanProjects(tmpDir);

    expect(index.projects.has('marked-without-context')).toBe(false);
    expect(index.invalidProjectPaths).toContain('marked-without-context');
    expect(index.diagnostics).toContainEqual(
      expect.objectContaining({
        path: 'marked-without-context/context.md',
        code: 'missing-project-context',
      }),
    );
  });

  it('reports unsafe and oversized marked context anchors without reading outside files', async () => {
    const owner = project('owner');
    const symlinked = join(owner, 'symlinked-context');
    mkdirSync(symlinked, { recursive: true });
    const outside = join(tmpDir, 'outside-context.md');
    writeFileSync(outside, 'outside content');
    symlinkSync(outside, join(symlinked, 'context.md'));
    writeWorkspace(symlinked, validWorkspace());

    const oversized = join(owner, 'oversized-context');
    mkdirSync(oversized, { recursive: true });
    writeFileSync(join(oversized, 'context.md'), 'x'.repeat(1_048_577));
    writeWorkspace(oversized, validWorkspace());

    const index = await scanProjects(tmpDir);

    expect(index.projects.has('owner/symlinked-context')).toBe(false);
    expect(index.projects.has('owner/oversized-context')).toBe(false);
    expect(index.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'owner/symlinked-context/context.md',
          code: 'project-context-unreadable',
        }),
        expect.objectContaining({
          path: 'owner/oversized-context/context.md',
          code: 'project-context-unreadable',
        }),
      ]),
    );
    expect(readFileSync(outside, 'utf8')).toBe('outside content');
  });

  it('rejects duplicate source IDs and a non-folder selected source', async () => {
    const path = project('invalid-sources');
    writeWorkspace(path, {
      ...validWorkspace(),
      execution: { mode: 'default', sourceId: 'repo' },
      sources: [
        folderSource('repo'),
        {
          id: 'repo',
          uri: 'https://example.test',
          label: 'duplicate URI',
          sourceType: 'url',
          createdAt: '2026-09-06T00:00:00.000Z',
          updatedAt: '2026-09-06T00:00:00.000Z',
        },
      ],
    });

    const index = await scanProjects(tmpDir);

    expect(index.projects.has('invalid-sources')).toBe(false);
    expect(index.diagnostics).toContainEqual(
      expect.objectContaining({
        path: 'invalid-sources/project.yaml',
        code: 'invalid-project-workspace',
      }),
    );
  });

  it('reserves managed memory and files directories from project discovery', async () => {
    const path = project('managed-roots');
    for (const name of ['memory', 'files']) {
      const nested = join(path, name, 'nested-project');
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, 'context.md'), 'managed content');
    }

    const index = await scanProjects(tmpDir);

    expect(index.projects.has('managed-roots')).toBe(true);
    expect(index.projects.has('managed-roots/memory/nested-project')).toBe(false);
    expect(index.projects.has('managed-roots/files/nested-project')).toBe(false);
  });

  it('requires an explicit manifest for nested projects and does not recurse working folders', async () => {
    const managed = project('managed');
    const book = join(managed, 'book');
    const docs = join(managed, 'docs');
    mkdirSync(book, { recursive: true });
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(book, 'context.md'), '---\nravenProject: [broken\n---\nBook notes');
    writeFileSync(join(docs, 'context.md'), '---\nravenProject: [broken\n---\nDocs notes');

    const deepMarked = join(docs, 'deep-project');
    mkdirSync(deepMarked, { recursive: true });
    writeFileSync(join(deepMarked, 'context.md'), 'Should not be discovered');
    writeWorkspace(deepMarked, validWorkspace());

    const explicit = join(managed, 'explicit');
    mkdirSync(explicit, { recursive: true });
    writeFileSync(join(explicit, 'context.md'), 'Explicit child');
    writeWorkspace(explicit, validWorkspace());

    const broken = join(managed, 'broken');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, 'context.md'), 'Broken child');
    writeFileSync(join(broken, 'project.yaml'), 'version: [');

    const missingContext = join(managed, 'missing-context');
    mkdirSync(missingContext, { recursive: true });
    writeWorkspace(missingContext, validWorkspace());

    const working = join(managed, 'working');
    const workingChild = join(working, 'nested-project');
    mkdirSync(workingChild, { recursive: true });
    writeFileSync(join(working, 'README.md'), 'ordinary working files');
    writeFileSync(join(workingChild, 'context.md'), 'Unmarked descendant');
    writeWorkspace(workingChild, validWorkspace());

    const index = await scanProjects(tmpDir);

    expect(index.projects.has('managed')).toBe(true);
    expect(index.projects.has('managed/explicit')).toBe(true);
    expect(index.projects.has('managed/book')).toBe(false);
    expect(index.projects.has('managed/docs')).toBe(false);
    expect(index.projects.has('managed/docs/deep-project')).toBe(false);
    expect(index.projects.has('managed/working/nested-project')).toBe(false);
    expect(index.invalidProjectPaths).toEqual(
      expect.arrayContaining(['managed/broken', 'managed/missing-context']),
    );
    expect(index.diagnostics).toContainEqual(
      expect.objectContaining({
        path: 'managed/broken/project.yaml',
        code: 'invalid-project-workspace',
      }),
    );
    expect(index.diagnostics).toContainEqual(
      expect.objectContaining({
        path: 'managed/missing-context/context.md',
        code: 'missing-project-context',
      }),
    );
  });
});
