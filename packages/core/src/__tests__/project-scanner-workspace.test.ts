import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
});
