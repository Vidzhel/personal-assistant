import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse, stringify } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectWorkspaceSchema, type ProjectWorkspace } from '@raven/shared';
import { createRavenTestFixture } from './fixtures/raven-fixture.ts';
import { ProjectRegistry } from '../project-registry/project-registry.ts';
import { createProjectWorkspaceStore } from '../project-manager/project-workspace.ts';

interface Fixture {
  root: string;
  projectsDir: string;
  registry: ProjectRegistry;
}

const roots: string[] = [];
const MAX_MANIFEST_BYTES = 1_048_576;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixtureWithProjects(...ids: string[]): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'raven-project-workspace-'));
  roots.push(root);
  const { projectsDir } = createRavenTestFixture(root);
  for (const id of ids) {
    mkdirSync(join(projectsDir, id), { recursive: true });
    writeFileSync(join(projectsDir, id, 'context.md'), `# ${id}\n`);
  }
  const registry = new ProjectRegistry();
  await registry.load(projectsDir);
  return { root, projectsDir, registry };
}

function storeFor(fixture: Fixture) {
  return createProjectWorkspaceStore({
    projectsDir: fixture.projectsDir,
    projectRegistry: fixture.registry,
    projectRoot: fixture.root,
  });
}

describe('project workspace file store', () => {
  it('uses a default workspace for a missing manifest and sees writes after restart', async () => {
    const fixture = await fixtureWithProjects('alpha');
    const store = storeFor(fixture);
    expect(store.getWorkspace('alpha')).toEqual({
      version: 1,
      execution: { mode: 'default' },
      sources: [],
    });

    const updated = await store.updateWorkspace('alpha', { execution: { mode: 'full' } });
    expect(updated.execution.mode).toBe('full');
    const restarted = storeFor(fixture);
    expect(restarted.getWorkspace('alpha').execution.mode).toBe('full');
  });

  it('atomically persists and resets a project model configuration', async () => {
    const fixture = await fixtureWithProjects('alpha');
    const store = storeFor(fixture);
    const modelConfig = {
      model: 'claude-sonnet-4-6',
      effort: 'high' as const,
      thinking: 'adaptive' as const,
    };

    const updated = await store.updateWorkspace('alpha', { execution: { modelConfig } });
    expect(updated.execution.modelConfig).toEqual(modelConfig);
    expect(storeFor(fixture).getWorkspace('alpha').execution.modelConfig).toEqual(modelConfig);

    const beforeInvalid = readFileSync(join(fixture.projectsDir, 'alpha', 'project.yaml'), 'utf8');
    await expect(
      store.updateWorkspace('alpha', {
        execution: { modelConfig: { model: 'invalid model id' } },
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(readFileSync(join(fixture.projectsDir, 'alpha', 'project.yaml'), 'utf8')).toBe(
      beforeInvalid,
    );

    const reset = await store.updateWorkspace('alpha', { execution: { modelConfig: null } });
    expect(reset.execution.modelConfig).toBeUndefined();
    expect(storeFor(fixture).getWorkspace('alpha').execution.modelConfig).toBeUndefined();
  });

  it('creates folder sources with canonical URI and persists no projectId field', async () => {
    const fixture = await fixtureWithProjects('alpha');
    mkdirSync(join(fixture.root, 'attached'));
    const store = storeFor(fixture);
    const source = await store.createDataSource('alpha', {
      uri: 'attached',
      label: 'Repository',
      sourceType: 'folder',
      contextFiles: ['README.md', 'docs/guide.md'],
    });

    expect(source).toMatchObject({
      projectId: 'alpha',
      sourceType: 'folder',
      uri: join(fixture.root, 'attached'),
      contextFiles: ['README.md', 'docs/guide.md'],
    });
    const yaml = parse(
      readFileSync(join(fixture.projectsDir, 'alpha', 'project.yaml'), 'utf8'),
    ) as {
      sources: Array<Record<string, unknown>>;
    };
    expect(yaml.sources[0]).not.toHaveProperty('projectId');
    expect(store.getDataSource('alpha', source.id)).toEqual(source);
  });

  it('selects a folder source and clears the selection when it is deleted', async () => {
    const fixture = await fixtureWithProjects('alpha');
    mkdirSync(join(fixture.root, 'repo'));
    const store = storeFor(fixture);
    const source = await store.createDataSource('alpha', {
      uri: 'repo',
      label: 'Repo',
      sourceType: 'folder',
    });
    await store.updateWorkspace('alpha', { execution: { mode: 'auto', sourceId: source.id } });
    expect(store.getWorkspace('alpha').execution.sourceId).toBe(source.id);
    await store.deleteDataSource('alpha', source.id);
    expect(store.getWorkspace('alpha').execution).toEqual({ mode: 'auto' });
  });

  it('keeps sources isolated and rejects foreign or unknown source mutations', async () => {
    const fixture = await fixtureWithProjects('alpha', 'beta');
    const store = storeFor(fixture);
    const source = await store.createDataSource('alpha', {
      uri: 'https://example.test',
      label: 'Example',
      sourceType: 'url',
    });

    expect(store.getDataSources('beta')).toEqual([]);
    await expect(
      store.updateDataSource('beta', source.id, { label: 'Cross project' }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(store.deleteDataSource('beta', source.id)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(store.getDataSource('beta', source.id)).toBeUndefined();
  });

  it('rejects malformed manifests and invalid workspace references without rewriting them', async () => {
    const fixture = await fixtureWithProjects('alpha');
    const manifest = join(fixture.projectsDir, 'alpha', 'project.yaml');
    writeFileSync(manifest, 'version: 1\nexecution:\n  mode: default\nsources: []\nextra: true\n');
    const before = readFileSync(manifest, 'utf8');
    const store = storeFor(fixture);
    expect(() => store.getWorkspace('alpha')).toThrow(/Invalid project workspace manifest/);
    await expect(
      store.updateWorkspace('alpha', { execution: { sourceId: 'missing' } }),
    ).rejects.toThrow();
    expect(readFileSync(manifest, 'utf8')).toBe(before);
  });

  it('rejects missing folders and unsafe context links before creating a manifest', async () => {
    const fixture = await fixtureWithProjects('alpha');
    const store = storeFor(fixture);
    await expect(
      store.createDataSource('alpha', {
        uri: 'missing',
        label: 'Missing',
        sourceType: 'folder',
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/does not exist.*visible to Raven.*workspace/i),
    });
    await expect(
      store.createDataSource('alpha', {
        uri: 'https://example.test',
        label: 'Invalid context',
        sourceType: 'url',
        contextFiles: ['../secrets.txt'],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(() => readFileSync(join(fixture.projectsDir, 'alpha', 'project.yaml'))).toThrow();
  });

  it('distinguishes non-directories and rejects symlinked folder sources with guidance', async () => {
    const fixture = await fixtureWithProjects('alpha');
    const store = storeFor(fixture);
    writeFileSync(join(fixture.root, 'plain-file'), 'not a folder');
    await expect(
      store.createDataSource('alpha', {
        uri: 'plain-file',
        label: 'File',
        sourceType: 'folder',
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/not a directory.*visible to Raven/i),
    });
    await expect(
      store.createDataSource('alpha', {
        uri: 'plain-file/child',
        label: 'File parent',
        sourceType: 'folder',
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/not a directory.*visible to Raven/i),
    });

    mkdirSync(join(fixture.root, 'real-folder'));
    symlinkSync(join(fixture.root, 'real-folder'), join(fixture.root, 'linked-folder'));
    await expect(
      store.createDataSource('alpha', {
        uri: 'linked-folder',
        label: 'Linked',
        sourceType: 'folder',
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/symlink.*visible to Raven/i),
    });
  });

  it('returns detached values and preserves manual manifest edits on the next read', async () => {
    const fixture = await fixtureWithProjects('alpha');
    const store = storeFor(fixture);
    const first = store.getWorkspace('alpha');
    (first.sources as ProjectWorkspace['sources']).push({
      id: 'manual',
      uri: 'https://example.test',
      label: 'Manual',
      sourceType: 'url',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(store.getWorkspace('alpha').sources).toEqual([]);
    await store.createDataSource('alpha', {
      uri: 'https://example.test',
      label: 'Actual',
      sourceType: 'url',
    });
    const external = parse(
      readFileSync(join(fixture.projectsDir, 'alpha', 'project.yaml'), 'utf8'),
    ) as ProjectWorkspace;
    external.execution.mode = 'auto';
    writeFileSync(join(fixture.projectsDir, 'alpha', 'project.yaml'), stringify(external));
    expect(store.getWorkspace('alpha').execution.mode).toBe('auto');
  });

  it('accepts the minimal version anchor while applying execution and source defaults', () => {
    expect(ProjectWorkspaceSchema.parse({ version: 1 })).toEqual({
      version: 1,
      execution: { mode: 'default' },
      sources: [],
    });
  });

  it('serializes concurrent source creates and execution updates without dropping state', async () => {
    const fixture = await fixtureWithProjects('alpha');
    const store = storeFor(fixture);

    await Promise.all([
      store.createDataSource('alpha', {
        uri: 'https://one.example',
        label: 'One',
        sourceType: 'url',
      }),
      store.createDataSource('alpha', {
        uri: 'https://two.example',
        label: 'Two',
        sourceType: 'url',
      }),
      store.updateWorkspace('alpha', { execution: { mode: 'full' } }),
    ]);

    expect(store.getWorkspace('alpha')).toMatchObject({
      execution: { mode: 'full' },
      sources: expect.arrayContaining([
        expect.objectContaining({ label: 'One' }),
        expect.objectContaining({ label: 'Two' }),
      ]),
    });
    expect(store.getDataSources('alpha')).toHaveLength(2);
  });

  it('rejects changing a source to a missing folder while preserving manifest bytes', async () => {
    const fixture = await fixtureWithProjects('alpha');
    const store = storeFor(fixture);
    const source = await store.createDataSource('alpha', {
      uri: 'https://example.test',
      label: 'Example',
      sourceType: 'url',
    });
    const manifest = join(fixture.projectsDir, 'alpha', 'project.yaml');
    const before = readFileSync(manifest, 'utf8');

    await expect(
      store.updateDataSource('alpha', source.id, {
        sourceType: 'folder',
        uri: 'missing-folder',
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(readFileSync(manifest, 'utf8')).toBe(before);
  });

  it('treats a null workspace source selection as a reset to managed home', async () => {
    const fixture = await fixtureWithProjects('alpha');
    const store = storeFor(fixture);
    mkdirSync(join(fixture.root, 'repo'));
    const source = await store.createDataSource('alpha', {
      uri: 'repo',
      label: 'Repo',
      sourceType: 'folder',
    });
    await store.updateWorkspace('alpha', { execution: { sourceId: source.id } });
    await store.updateWorkspace('alpha', { execution: { mode: 'auto', sourceId: null } });
    expect(store.getWorkspace('alpha').execution).toEqual({ mode: 'auto' });
  });

  it('refuses to convert the selected working folder to a non-folder source', async () => {
    const fixture = await fixtureWithProjects('alpha');
    const store = storeFor(fixture);
    mkdirSync(join(fixture.root, 'repo'));
    const source = await store.createDataSource('alpha', {
      uri: 'repo',
      label: 'Repo',
      sourceType: 'folder',
    });
    await store.updateWorkspace('alpha', { execution: { sourceId: source.id } });
    const manifest = join(fixture.projectsDir, 'alpha', 'project.yaml');
    const before = readFileSync(manifest, 'utf8');
    await expect(
      store.updateDataSource('alpha', source.id, {
        sourceType: 'url',
        uri: 'https://example.invalid',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(readFileSync(manifest, 'utf8')).toBe(before);
  });

  it('blocks writes when the current context identity no longer matches the registry', async () => {
    const fixture = await fixtureWithProjects('alpha');
    const store = storeFor(fixture);
    await store.updateWorkspace('alpha', { execution: { mode: 'default' } });
    const manifest = join(fixture.projectsDir, 'alpha', 'project.yaml');
    const context = join(fixture.projectsDir, 'alpha', 'context.md');
    const before = readFileSync(manifest, 'utf8');
    writeFileSync(
      context,
      '---\nravenProject:\n  version: 1\n  id: another-project\n---\n# alpha\n',
    );

    await expect(store.updateWorkspace('alpha', { execution: { mode: 'full' } })).rejects.toThrow(
      /identity/,
    );
    expect(readFileSync(manifest, 'utf8')).toBe(before);
  });

  it('rejects writes after a failed registry reload instead of using its retained index', async () => {
    const fixture = await fixtureWithProjects('alpha');
    const store = storeFor(fixture);
    await store.updateWorkspace('alpha', { execution: { mode: 'default' } });
    const manifest = join(fixture.projectsDir, 'alpha', 'project.yaml');
    const before = readFileSync(manifest, 'utf8');
    await expect(fixture.registry.load(join(fixture.root, 'missing-projects'))).rejects.toThrow();

    await expect(store.updateWorkspace('alpha', { execution: { mode: 'full' } })).rejects.toThrow();
    expect(readFileSync(manifest, 'utf8')).toBe(before);
  });

  it('keeps a detached folder source readable and removable', async () => {
    const fixture = await fixtureWithProjects('alpha');
    const folder = join(fixture.root, 'detached');
    mkdirSync(folder);
    const store = storeFor(fixture);
    const source = await store.createDataSource('alpha', {
      uri: 'detached',
      label: 'Detached',
      sourceType: 'folder',
    });
    rmSync(folder, { recursive: true, force: true });

    expect(store.getDataSource('alpha', source.id)).toEqual(source);
    await store.deleteDataSource('alpha', source.id);
    expect(store.getDataSource('alpha', source.id)).toBeUndefined();
  });

  it('rejects context files on URL updates without rewriting the source', async () => {
    const fixture = await fixtureWithProjects('alpha');
    const store = storeFor(fixture);
    const source = await store.createDataSource('alpha', {
      uri: 'https://example.test',
      label: 'Example',
      sourceType: 'url',
    });
    const manifest = join(fixture.projectsDir, 'alpha', 'project.yaml');
    const before = readFileSync(manifest, 'utf8');

    await expect(
      store.updateDataSource('alpha', source.id, { contextFiles: ['README.md'] }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(readFileSync(manifest, 'utf8')).toBe(before);
  });

  it('rejects an oversized accumulated manifest before replacing a prior manifest', async () => {
    const fixture = await fixtureWithProjects('alpha');
    const store = storeFor(fixture);
    const manifest = join(fixture.projectsDir, 'alpha', 'project.yaml');
    await store.createDataSource('alpha', {
      uri: 'https://small.example',
      label: 'Small',
      sourceType: 'url',
    });
    const before = readFileSync(manifest, 'utf8');
    const description = 'x'.repeat(MAX_MANIFEST_BYTES);

    await expect(
      store.createDataSource('alpha', {
        uri: 'https://example.test',
        label: 'Large',
        description,
        sourceType: 'url',
      }),
    ).rejects.toThrow(/large|size|manifest/i);
    expect(readFileSync(manifest, 'utf8')).toBe(before);
  });
});
