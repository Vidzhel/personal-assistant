import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildWorkspaceContext } from '../project-manager/workspace-context.ts';
import type { ProjectWorkspace, ProjectWorkspaceSource } from '@raven/shared';

const roots: string[] = [];

function source(
  id: string,
  uri: string,
  extra: Partial<ProjectWorkspaceSource> = {},
): ProjectWorkspaceSource {
  const timestamp = new Date(0).toISOString();
  return {
    id,
    uri,
    label: id,
    sourceType: 'folder',
    createdAt: timestamp,
    updatedAt: timestamp,
    ...extra,
  };
}

function workspace(
  sources: ProjectWorkspaceSource[],
  mode: ProjectWorkspace['execution']['mode'] = 'default',
  sourceId?: string,
): ProjectWorkspace {
  return {
    version: 1,
    execution: { mode, ...(sourceId ? { sourceId } : {}) },
    sources,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('workspace context overview', () => {
  it('lists explicit context links, including missing files, without reading bodies', () => {
    const root = mkdtempSync(join(tmpdir(), 'raven-workspace-context-'));
    roots.push(root);
    const repo = join(root, 'repo');
    mkdirSync(repo);
    writeFileSync(join(repo, 'README.md'), 'PRIVATE_REPOSITORY_BODY');
    const output = buildWorkspaceContext({
      home: join(root, 'home'),
      cwd: repo,
      workspace: workspace(
        [
          source('repo', repo, { contextFiles: ['README.md', 'missing.md'] }),
          source('web', 'https://example.test/reference', { sourceType: 'url' }),
        ],
        'auto',
        'repo',
      ),
    });

    expect(output).toContain('README.md');
    expect(output).toContain('missing.md (unavailable)');
    expect(output).not.toContain('PRIVATE_REPOSITORY_BODY');
    expect(output).toContain('selected cwd');
    expect(output).toContain('project.yaml');
    expect(output).toContain('web');
    expect(output).toContain('https://example.test/reference');
  });

  it('detects only known files at a source root when links are not explicit', () => {
    const root = mkdtempSync(join(tmpdir(), 'raven-workspace-context-'));
    roots.push(root);
    const repo = join(root, 'repo');
    mkdirSync(join(repo, 'nested'), { recursive: true });
    writeFileSync(join(repo, 'AGENTS.md'), 'ROOT_BODY');
    writeFileSync(join(repo, 'nested', 'README.md'), 'NESTED_BODY');
    const output = buildWorkspaceContext({
      home: join(root, 'home'),
      cwd: repo,
      workspace: workspace([source('repo', repo)], 'default', 'repo'),
    });

    expect(output).toContain('AGENTS.md');
    expect(output).not.toContain('nested');
    expect(output).not.toContain('ROOT_BODY');
    expect(output).not.toContain('NESTED_BODY');
  });

  it('percent-encodes special path characters in local links', () => {
    const root = mkdtempSync(join(tmpdir(), 'raven-workspace-context-'));
    roots.push(root);
    const repo = join(root, 'repo # ü space');
    mkdirSync(repo);
    writeFileSync(join(repo, 'notes # ?.md'), 'body');
    const output = buildWorkspaceContext({
      home: join(root, 'home'),
      cwd: repo,
      workspace: workspace(
        [source('weird', repo, { contextFiles: ['notes # ?.md'] })],
        'full',
        'weird',
      ),
    });

    expect(output).toContain('repo%20%23%20%C3%BC%20space');
    expect(output).toContain('notes%20%23%20%3F.md');
    expect(output).toContain('Native execution mode: `full`');
  });

  it('bounds source descriptions and reports omitted sources', () => {
    const root = mkdtempSync(join(tmpdir(), 'raven-workspace-context-'));
    roots.push(root);
    const sources = Array.from({ length: 40 }, (_, index) => {
      const dir = join(root, `repo-${index}`);
      mkdirSync(dir);
      return source(`repo-${index}`, dir, { description: '😀'.repeat(10_000) });
    });
    const output = buildWorkspaceContext({
      home: join(root, 'home'),
      cwd: join(root, 'repo-0'),
      workspace: workspace(sources, 'auto', 'repo-0'),
    });

    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(24 * 1024);
    expect(output).toContain('Omitted');
    expect(output).not.toContain('😀'.repeat(1000));
  });

  it('keeps project sources isolated and defensively omits unsafe context paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'raven-workspace-context-'));
    roots.push(root);
    const repo = join(root, 'repo');
    const other = join(root, 'other');
    mkdirSync(repo);
    mkdirSync(other);
    writeFileSync(join(other, 'secret.md'), 'OTHER_PROJECT_SECRET');
    const output = buildWorkspaceContext({
      home: join(root, 'home'),
      cwd: repo,
      workspace: workspace([
        source('repo', repo, { contextFiles: ['../other/secret.md', 'valid.md'] }),
      ]),
    });

    expect(output).toContain('valid.md (unavailable)');
    expect(output).toContain('unsafe context file path');
    expect(output).not.toContain('OTHER_PROJECT_SECRET');
    expect(output).not.toContain('secret.md');
  });

  it('reports excess valid explicit links separately from unsafe paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'raven-workspace-context-'));
    roots.push(root);
    const repo = join(root, 'repo');
    mkdirSync(repo);
    const paths = Array.from({ length: 13 }, (_, index) => `context-${index}.md`);
    for (const path of paths) writeFileSync(join(repo, path), 'body');
    const output = buildWorkspaceContext({
      home: join(root, 'home'),
      cwd: repo,
      workspace: workspace([source('repo', repo, { contextFiles: paths })]),
    });

    expect(output).toContain('Omitted 1 excess context file link(s) by source limit');
    expect(output).not.toContain('unsafe context file path');
  });

  it('escapes Markdown labels and RFC3986 path characters', () => {
    const root = mkdtempSync(join(tmpdir(), 'raven-workspace-context-'));
    roots.push(root);
    const repo = join(root, 'repo');
    const file = "name ]( !'()*`.md";
    mkdirSync(repo);
    writeFileSync(join(repo, file), 'body');
    const output = buildWorkspaceContext({
      home: join(root, 'home'),
      cwd: repo,
      workspace: workspace([source('repo', repo, { contextFiles: [file] })]),
    });

    expect(output).toContain('%5D%28%20%21%27%28%29%2A%60.md');
    expect(output).toContain('name \\]( !');
  });

  it('does not advertise context files through a symlinked source subdirectory', () => {
    const root = mkdtempSync(join(tmpdir(), 'raven-workspace-context-'));
    roots.push(root);
    const repo = join(root, 'repo');
    const outside = join(root, 'outside');
    mkdirSync(repo);
    mkdirSync(outside);
    writeFileSync(join(outside, 'CLAUDE.md'), 'outside body');
    symlinkSync(outside, join(repo, '.claude'), 'dir');
    const output = buildWorkspaceContext({
      home: join(root, 'home'),
      cwd: repo,
      workspace: workspace([source('repo', repo)]),
    });

    expect(output).not.toContain('.claude/CLAUDE.md');
    expect(output).not.toContain('outside body');
  });

  it('keeps a selected source usable when explicit links are very long', () => {
    const root = mkdtempSync(join(tmpdir(), 'raven-workspace-context-'));
    roots.push(root);
    const repo = join(root, 'repo');
    mkdirSync(repo);
    const paths = Array.from({ length: 14 }, (_, index) =>
      index === 0 ? `${'😀'.repeat(10_000)}.md` : `context-${index}.md`,
    );
    const output = buildWorkspaceContext({
      home: join(root, 'home'),
      cwd: repo,
      workspace: workspace([source('repo', repo, { contextFiles: paths })], 'auto', 'repo'),
    });

    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(24 * 1024);
    expect(output).toContain('repo');
    expect(output).toContain('selected cwd');
    expect(output).toContain('Additional source details omitted');
  });
});
