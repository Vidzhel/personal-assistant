import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectRegistry } from '../project-registry/project-registry.ts';
import { createProjectWorkspaceStore } from '../project-manager/project-workspace.ts';
import { createWorkspaceExecutionResolver } from '../project-manager/workspace-execution.ts';
import type { NamedAgentStore } from '../agent-registry/yaml-named-agent-store.ts';

interface Fixture {
  root: string;
  projectsDir: string;
  registry: ProjectRegistry;
  workspaceStore: ReturnType<typeof createProjectWorkspaceStore>;
}

const roots: string[] = [];

async function makeFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'raven-workspace-execution-'));
  roots.push(root);
  const projectsDir = join(root, 'projects');
  mkdirSync(join(projectsDir, 'alpha'), { recursive: true });
  mkdirSync(join(projectsDir, 'system'), { recursive: true });
  writeFileSync(join(projectsDir, 'context.md'), '# Global context\n');
  writeFileSync(join(projectsDir, 'alpha', 'context.md'), '# Alpha context\n');
  writeFileSync(join(projectsDir, 'system', 'context.md'), '# Managed home\n');
  const registry = new ProjectRegistry();
  await registry.load(projectsDir);
  const workspaceStore = createProjectWorkspaceStore({
    projectsDir,
    projectRegistry: registry,
    projectRoot: root,
  });
  return { root, projectsDir, registry, workspaceStore };
}

function fakeAgents(): {
  agents: Map<string, { id: string; name: string; definitionRevision: string }>;
  store: NamedAgentStore;
} {
  const agents = new Map<string, { id: string; name: string; definitionRevision: string }>();
  const store = {
    getAgent: (id: string) => agents.get(id),
    getAgentByName: (name: string, projectId?: string) => {
      const id = projectId ? `${projectId}::${name}` : name;
      return agents.get(id);
    },
  } as unknown as NamedAgentStore;
  return { agents, store };
}

function resolver(
  fixture: Fixture,
  namedAgentStore: NamedAgentStore,
  runtimeRevision?: () => string,
) {
  return createWorkspaceExecutionResolver({
    workspaceStore: fixture.workspaceStore,
    projectRegistry: fixture.registry,
    namedAgentStore,
    ...(runtimeRevision ? { runtimeRevision } : {}),
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('workspace execution resolution', () => {
  it('uses managed home by default without granting project settings', async () => {
    const fixture = await makeFixture();
    const execution = resolver(fixture, fakeAgents().store).resolve({});

    expect(execution).toMatchObject({
      cwd: join(fixture.projectsDir, 'system'),
      additionalDirectories: [],
      mode: 'default',
      settingSources: [],
    });
    expect(execution.revision).toMatch(/^[a-f0-9]{64}$/);

    mkdirSync(join(fixture.projectsDir, 'system', '.claude'));
    writeFileSync(join(fixture.projectsDir, 'system', '.claude', 'settings.json'), '{}\n');
    expect(resolver(fixture, fakeAgents().store).resolve({}).revision).toBe(execution.revision);
  });

  it('selects a folder and grants every other folder plus managed home', async () => {
    const fixture = await makeFixture();
    const first = join(fixture.root, 'repo-one');
    const second = join(fixture.root, 'repo-two');
    mkdirSync(first);
    mkdirSync(second);
    const sourceOne = await fixture.workspaceStore.createDataSource('alpha', {
      uri: first,
      label: 'One',
      sourceType: 'folder',
    });
    await fixture.workspaceStore.createDataSource('alpha', {
      uri: second,
      label: 'Two',
      sourceType: 'folder',
    });
    await fixture.workspaceStore.updateWorkspace('alpha', {
      execution: { sourceId: sourceOne.id, mode: 'auto' },
    });

    const execution = resolver(fixture, fakeAgents().store).resolve({ projectId: 'alpha' });
    expect(execution.cwd).toBe(first);
    expect(execution.mode).toBe('auto');
    expect(execution.settingSources).toEqual(['project', 'local']);
    expect(execution.additionalDirectories).toEqual(
      [join(fixture.projectsDir, 'alpha'), second].sort(),
    );

    await fixture.workspaceStore.updateWorkspace('alpha', { execution: { mode: 'full' } });
    expect(resolver(fixture, fakeAgents().store).resolve({ projectId: 'alpha' }).mode).toBe('full');
    const beforeSettings = resolver(fixture, fakeAgents().store).resolve({ projectId: 'alpha' });
    mkdirSync(join(first, '.claude'));
    writeFileSync(join(first, '.claude', 'settings.json'), '{"hooks":{}}\n');
    const afterSettings = resolver(fixture, fakeAgents().store).resolve({ projectId: 'alpha' });
    expect(afterSettings.revision).not.toBe(beforeSettings.revision);
  });

  it('rejects a missing selected source before producing a fallback cwd', async () => {
    const fixture = await makeFixture();
    const manifest = join(fixture.projectsDir, 'alpha', 'project.yaml');
    writeFileSync(
      manifest,
      stringify({ version: 1, execution: { mode: 'default', sourceId: 'missing' }, sources: [] }),
    );

    expect(() => resolver(fixture, fakeAgents().store).resolve({ projectId: 'alpha' })).toThrow(
      /Invalid project workspace manifest|Execution source does not exist/,
    );
    expect(readFileSync(manifest, 'utf8')).toContain('sourceId: missing');
  });

  it('changes revision when an attached folder is replaced at the same path', async () => {
    const fixture = await makeFixture();
    const folder = join(fixture.root, 'repo');
    const moved = join(fixture.root, 'repo-old');
    mkdirSync(folder);
    await fixture.workspaceStore.createDataSource('alpha', {
      uri: folder,
      label: 'Repo',
      sourceType: 'folder',
    });
    const before = resolver(fixture, fakeAgents().store).resolve({ projectId: 'alpha' });
    renameSync(folder, moved);
    mkdirSync(folder);
    const after = resolver(fixture, fakeAgents().store).resolve({ projectId: 'alpha' });

    expect(after.cwd).toBe(join(fixture.projectsDir, 'alpha'));
    expect(after.revision).not.toBe(before.revision);
  });

  it('changes revision when the selected cwd is replaced at the same path', async () => {
    const fixture = await makeFixture();
    const folder = join(fixture.root, 'repo');
    const moved = join(fixture.root, 'repo-old');
    mkdirSync(folder);
    const source = await fixture.workspaceStore.createDataSource('alpha', {
      uri: folder,
      label: 'Repo',
      sourceType: 'folder',
    });
    await fixture.workspaceStore.updateWorkspace('alpha', { execution: { sourceId: source.id } });
    const before = resolver(fixture, fakeAgents().store).resolve({ projectId: 'alpha' });
    renameSync(folder, moved);
    mkdirSync(folder);
    const after = resolver(fixture, fakeAgents().store).resolve({ projectId: 'alpha' });

    expect(after.cwd).toBe(folder);
    expect(after.revision).not.toBe(before.revision);
  });

  it('hashes context and agent definition revisions but ignores ordinary files', async () => {
    const fixture = await makeFixture();
    const { agents, store } = fakeAgents();
    agents.set('worker-id', { id: 'worker-id', name: 'worker', definitionRevision: 'rev-1' });
    agents.set('alpha::worker', {
      id: 'worker-id',
      name: 'worker',
      definitionRevision: 'rev-1',
    });
    const make = (namedAgentRevision?: string) =>
      resolver(fixture, store).resolve({
        projectId: 'alpha',
        namedAgentId: 'worker-id',
        namedAgentRevision,
      });
    const before = make('rev-1');
    writeFileSync(join(fixture.root, 'ordinary.txt'), 'flexible content');
    const ordinary = make('rev-1');
    expect(ordinary.revision).toBe(before.revision);

    writeFileSync(join(fixture.projectsDir, 'alpha', 'context.md'), '# Changed context\n');
    const changedContext = make('rev-1');
    expect(changedContext.revision).not.toBe(before.revision);

    agents.set('worker-id', { id: 'worker-id', name: 'worker', definitionRevision: 'rev-2' });
    agents.set('alpha::worker', {
      id: 'worker-id',
      name: 'worker',
      definitionRevision: 'rev-2',
    });
    expect(() => make('rev-1')).toThrow(/Agent definition changed/);
    expect(make('rev-2').revision).not.toBe(changedContext.revision);
  });

  it('rejects a stale project identity retained by the registry', async () => {
    const fixture = await makeFixture();
    writeFileSync(
      join(fixture.projectsDir, 'alpha', 'context.md'),
      '---\nravenProject:\n  version: 1\n  id: another-project\n---\n# Alpha\n',
    );

    expect(() => resolver(fixture, fakeAgents().store).resolve({ projectId: 'alpha' })).toThrow(
      /identity|unavailable|Project context/,
    );
  });

  it('includes current runtime capability revisions without hashing work files', async () => {
    const fixture = await makeFixture();
    let runtime = 'library-1';
    const get = () => resolver(fixture, fakeAgents().store, () => runtime).resolve({});
    const before = get();
    runtime = 'library-2';
    expect(get().revision).not.toBe(before.revision);
  });

  it('does not grant a detached source whose current path is unavailable', async () => {
    const fixture = await makeFixture();
    const folder = join(fixture.root, 'repo');
    mkdirSync(folder);
    await fixture.workspaceStore.createDataSource('alpha', {
      uri: folder,
      label: 'Repo',
      sourceType: 'folder',
    });
    rmSync(folder, { recursive: true, force: true });

    expect(() => resolver(fixture, fakeAgents().store).resolve({ projectId: 'alpha' })).toThrow(
      /Workspace directory is unavailable|ENOENT|no such file/i,
    );
  });
  it('uses stable project IDs when another project path happens to match one', async () => {
    const fixture = await makeFixture();
    const definition = (id: string) =>
      `---\nravenProject:\n  version: 1\n  id: ${id}\n---\n# Project\n`;
    writeFileSync(join(fixture.projectsDir, 'alpha/context.md'), definition('beta'));
    mkdirSync(join(fixture.projectsDir, 'beta'));
    writeFileSync(join(fixture.projectsDir, 'beta/context.md'), definition('gamma'));
    await fixture.registry.load(fixture.projectsDir);
    const get = () => resolver(fixture, fakeAgents().store).resolve({ projectId: 'beta' });
    const before = get();
    expect(before.cwd).toBe(join(fixture.projectsDir, 'alpha'));
    writeFileSync(
      join(fixture.projectsDir, 'beta/context.md'),
      definition('gamma') + 'Unrelated edit',
    );
    expect(get().revision).toBe(before.revision);
    writeFileSync(join(fixture.projectsDir, 'alpha/context.md'), definition('beta') + 'Own edit');
    expect(get().revision).not.toBe(before.revision);
  });

  it('rejects removal of a managed ancestor identity before registry reload', async () => {
    const fixture = await makeFixture();
    writeFileSync(
      join(fixture.projectsDir, 'alpha/context.md'),
      '---\nravenProject:\n  version: 1\n  id: managed-parent\n---\n# Parent\n',
    );
    mkdirSync(join(fixture.projectsDir, 'alpha/child'));
    writeFileSync(join(fixture.projectsDir, 'alpha/child/context.md'), '# Child\n');
    await fixture.registry.load(fixture.projectsDir);
    const get = () => resolver(fixture, fakeAgents().store).resolve({ projectId: 'alpha/child' });
    expect(get().cwd).toBe(join(fixture.projectsDir, 'alpha/child'));
    writeFileSync(join(fixture.projectsDir, 'alpha/context.md'), '# Removed managed identity\n');
    expect(get).toThrow(/identity/);
  });
});
