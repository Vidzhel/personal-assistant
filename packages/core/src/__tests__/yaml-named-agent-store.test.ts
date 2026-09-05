import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectRegistry } from '../project-registry/project-registry.ts';
import { createAgentYamlStore } from '../project-registry/agent-yaml-store.ts';
import {
  createYamlNamedAgentStore,
  type NamedAgentStore,
} from '../agent-registry/yaml-named-agent-store.ts';

const RAVEN_YAML = `name: raven
displayName: Raven
description: Default assistant
isDefault: true
skills: []
model: sonnet
maxTurns: 20
`;

function makeMockEventBus() {
  const events: Array<{ type: string; payload: any }> = [];
  return {
    emit: vi.fn((event: any) => events.push(event)),
    on: vi.fn(),
    off: vi.fn(),
    events,
  };
}

describe('YamlNamedAgentStore', () => {
  let projectsDir: string;
  let store: NamedAgentStore;
  let projectRegistry: ProjectRegistry;
  let eventBus: ReturnType<typeof makeMockEventBus>;

  beforeEach(async () => {
    projectsDir = mkdtempSync(join(tmpdir(), 'raven-yamlstore-'));
    writeFileSync(join(projectsDir, 'context.md'), '# Global\n');
    mkdirSync(join(projectsDir, 'agents', 'raven'), { recursive: true });
    writeFileSync(join(projectsDir, 'agents', 'raven', 'agent.yaml'), RAVEN_YAML);

    projectRegistry = new ProjectRegistry();
    await projectRegistry.load(projectsDir);
    eventBus = makeMockEventBus();
    store = createYamlNamedAgentStore({
      projectRegistry,
      agentYamlStore: createAgentYamlStore(),
      projectsDir,
      eventBus: eventBus as any,
    });
  });

  afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
  });

  it('lists agents from the filesystem with id === name', () => {
    const agents = store.listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe('raven');
    expect(agents[0].name).toBe('raven');
    expect(agents[0].isDefault).toBe(true);
  });

  it('returns the default agent', () => {
    expect(store.getDefaultAgent().name).toBe('raven');
  });

  it('creates an agent as <name>/agent.yaml and emits created event', async () => {
    const agent = await store.createAgent({
      name: 'researcher',
      description: 'Research things',
      skills: ['web-search'],
    });

    expect(agent.id).toBe('researcher');
    expect(agent.skills).toEqual(['web-search']);
    expect(existsSync(join(projectsDir, 'agents', 'researcher', 'agent.yaml'))).toBe(true);
    expect(store.getAgentByName('researcher')?.description).toBe('Research things');

    const created = eventBus.events.find((e) => e.type === 'agent:config:created');
    expect(created).toBeDefined();
    expect(created!.payload.name).toBe('researcher');
    expect(created!.payload.filePaths).toEqual([
      join(projectsDir, 'agents', 'researcher', 'agent.yaml'),
    ]);
  });

  it('rejects duplicate names', async () => {
    await expect(store.createAgent({ name: 'raven', skills: [] })).rejects.toThrow(
      /already exists/,
    );
  });

  it('updates fields and persists to YAML', async () => {
    await store.createAgent({ name: 'temp-agent', skills: [] });
    const updated = await store.updateAgent('temp-agent', {
      description: 'New desc',
      model: 'haiku',
      maxTurns: 5,
    });
    expect(updated.description).toBe('New desc');
    expect(updated.model).toBe('haiku');
    expect(updated.maxTurns).toBe(5);
    expect(store.getAgent('temp-agent')?.model).toBe('haiku');
  });

  it('clears nullable model and maxTurns overrides back to YAML defaults', async () => {
    await store.createAgent({ name: 'reset-agent', skills: [], model: 'opus', maxTurns: 9 });
    const updated = await store.updateAgent('reset-agent', { model: null, maxTurns: null });
    expect(updated.model).toBe('sonnet');
    expect(updated.maxTurns).toBe(15);
    expect(store.getAgent('reset-agent')).toMatchObject({ model: 'sonnet', maxTurns: 15 });
  });

  it('renames an agent (new file created, old removed, id follows name)', async () => {
    await store.createAgent({ name: 'old-name', skills: [] });
    const renamed = await store.updateAgent('old-name', { name: 'new-name' });
    expect(renamed.id).toBe('new-name');
    expect(store.getAgent('old-name')).toBeUndefined();
    expect(store.getAgent('new-name')).toBeDefined();
    expect(existsSync(join(projectsDir, 'agents', 'new-name', 'agent.yaml'))).toBe(true);
    expect(existsSync(join(projectsDir, 'agents', 'old-name'))).toBe(false);
    const updated = eventBus.events.find(
      (event) => event.type === 'agent:config:updated' && event.payload.name === 'new-name',
    );
    expect(updated?.payload.filePaths).toEqual([
      join(projectsDir, 'agents', 'old-name', 'agent.yaml'),
      join(projectsDir, 'agents', 'new-name', 'agent.yaml'),
    ]);
  });

  it('refuses to rename or delete the default agent', async () => {
    await expect(store.updateAgent('raven', { name: 'corvid' })).rejects.toThrow(/Cannot rename/);
    await expect(store.deleteAgent('raven')).rejects.toThrow(/Cannot delete/);
  });

  it('deletes a non-default agent and emits deleted event', async () => {
    await store.createAgent({ name: 'doomed', skills: [] });
    await store.deleteAgent('doomed');
    expect(store.getAgent('doomed')).toBeUndefined();
    expect(eventBus.events.some((e) => e.type === 'agent:config:deleted')).toBe(true);
  });

  it('throws on update/delete of unknown agent', async () => {
    await expect(store.updateAgent('ghost', { description: 'x' })).rejects.toThrow(/not found/);
    await expect(store.deleteAgent('ghost')).rejects.toThrow(/not found/);
  });

  it('sees agents from sub-projects (flat layout)', async () => {
    mkdirSync(join(projectsDir, 'proj-x', 'agents'), { recursive: true });
    writeFileSync(join(projectsDir, 'proj-x', 'context.md'), '# X\n');
    writeFileSync(
      join(projectsDir, 'proj-x', 'agents', 'sub-agent.yaml'),
      `name: sub-agent\ndisplayName: Sub\ndescription: In a project\nskills: []\nmodel: sonnet\nmaxTurns: 20\n`,
    );
    const reg = new ProjectRegistry();
    await reg.load(projectsDir);
    const s2 = createYamlNamedAgentStore({
      projectRegistry: reg,
      agentYamlStore: createAgentYamlStore(),
      projectsDir,
      eventBus: eventBus as any,
    });
    expect(s2.getAgentByName('sub-agent', 'proj-x')).toBeDefined();
  });

  it('keeps local namesakes qualified and resolves the nearest visible override', async () => {
    const localYaml = (name: string, isDefault = false) =>
      `name: ${name}\ndisplayName: ${name}\ndescription: Local\nisDefault: ${String(isDefault)}\nskills: []\n`;
    for (const [project, id] of [
      ['alpha', 'alpha-stable'],
      ['beta', 'beta-stable'],
    ]) {
      mkdirSync(join(projectsDir, project, 'agents', 'raven'), { recursive: true });
      writeFileSync(
        join(projectsDir, project, 'context.md'),
        `---\nravenProject:\n  version: 1\n  id: ${id}\n  displayName: ${project}\n---\n# ${project}\n`,
      );
      writeFileSync(
        join(projectsDir, project, 'agents', 'raven', 'agent.yaml'),
        localYaml('raven', project === 'alpha'),
      );
    }
    writeFileSync(join(projectsDir, 'alpha', 'agents', 'local-only.yaml'), localYaml('local-only'));
    await projectRegistryLoad();

    const agents = store.listAgents();
    expect(agents.map((agent) => agent.id).sort()).toEqual([
      'alpha-stable::local-only',
      'alpha-stable::raven',
      'beta-stable::raven',
      'raven',
    ]);
    expect(store.getAgentByName('raven')?.projectId).toBeUndefined();
    expect(store.getAgentByName('local-only')).toBeUndefined();
    expect(store.getAgentByName('raven', 'alpha-stable')?.id).toBe('alpha-stable::raven');
    expect(store.getDefaultAgent('alpha-stable').id).toBe('alpha-stable::raven');
    expect(() => store.getAgentByName('beta-stable::raven', 'alpha-stable')).toThrow(
      /unrelated project/,
    );
  });

  it('allows a local shadow and rereads current bytes for revision and mutations', async () => {
    mkdirSync(join(projectsDir, 'alpha', 'agents'), { recursive: true });
    writeFileSync(
      join(projectsDir, 'alpha', 'context.md'),
      '---\nravenProject:\n  version: 1\n  id: alpha-stable\n---\n# Alpha\n',
    );
    await projectRegistryLoad();
    const local = await store.createAgent(
      { name: 'raven', description: 'Local', skills: [] },
      { projectScope: 'alpha-stable' },
    );
    expect(local.id).toBe('alpha-stable::raven');
    expect(store.getDefaultAgent('alpha-stable').id).toBe('alpha-stable::raven');
    const globalBefore = store.getAgent('raven');
    const localPath = join(projectsDir, 'alpha', 'agents', 'raven', 'agent.yaml');
    const firstRevision = store.getAgent(local.id)?.definitionRevision;
    writeFileSync(localPath, `${readFileSync(localPath, 'utf8')}# edited\n`);
    expect(store.getAgent(local.id)?.definitionRevision).not.toBe(firstRevision);
    expect(store.getAgent('raven')?.description).toBe(globalBefore?.description);

    const renamedPath = join(projectsDir, 'alpha', 'agents', 'renamed');
    renameSync(join(projectsDir, 'alpha', 'agents', 'raven'), renamedPath);
    expect(() => store.getAgent(local.id)).toThrow(/unavailable/);
  });

  it('selects the nearest default name before resolving its local shadow', async () => {
    mkdirSync(join(projectsDir, 'alpha', 'agents', 'writer'), { recursive: true });
    writeFileSync(
      join(projectsDir, 'alpha', 'context.md'),
      '---\nravenProject:\n  version: 1\n  id: alpha-stable\n---\n# Alpha\n',
    );
    writeFileSync(
      join(projectsDir, 'alpha', 'agents', 'writer', 'agent.yaml'),
      'name: writer\ndisplayName: Writer\nisDefault: true\nskills: []\n',
    );
    mkdirSync(join(projectsDir, 'alpha', 'child', 'agents', 'writer'), { recursive: true });
    writeFileSync(
      join(projectsDir, 'alpha', 'child', 'context.md'),
      '---\nravenProject:\n  version: 1\n  id: child-stable\n---\n# Child\n',
    );
    writeFileSync(
      join(projectsDir, 'alpha', 'child', 'agents', 'writer', 'agent.yaml'),
      'name: writer\ndisplayName: Writer\nisDefault: false\nskills: []\n',
    );
    await projectRegistryLoad();

    expect(store.getDefaultAgent('alpha-stable').id).toBe('alpha-stable::writer');
    expect(store.getDefaultAgent('child-stable').id).toBe('child-stable::writer');
  });

  it('does not discover a newly appeared definition until registry reload', async () => {
    const filePath = join(projectsDir, 'agents', 'new-agent.yaml');
    writeFileSync(filePath, 'name: new-agent\ndisplayName: New\nskills: []\n');
    expect(store.getAgent('new-agent')).toBeUndefined();

    await projectRegistryLoad();
    expect(store.getAgent('new-agent')?.name).toBe('new-agent');
  });

  it('rejects scoped lookup when the owning project identity changed after reload', async () => {
    mkdirSync(join(projectsDir, 'alpha', 'agents'), { recursive: true });
    writeFileSync(
      join(projectsDir, 'alpha', 'context.md'),
      '---\nravenProject:\n  version: 1\n  id: alpha-stable\n---\n# Alpha\n',
    );
    writeFileSync(
      join(projectsDir, 'alpha', 'agents', 'local.yaml'),
      'name: local\ndisplayName: Local\nskills: []\n',
    );
    await projectRegistryLoad();
    writeFileSync(
      join(projectsDir, 'alpha', 'context.md'),
      '---\nravenProject:\n  version: 1\n  id: changed-stable\n---\n# Alpha\n',
    );

    expect(() => store.getAgentByName('local', 'alpha-stable')).toThrow(/identity changed/);
    expect(() => store.getDefaultAgent('alpha-stable')).toThrow(/identity changed/);
  });

  it('blocks global lookups after a failed root reload until a successful reload', async () => {
    const moved = `${projectsDir}-held`;
    renameSync(projectsDir, moved);
    try {
      await expect(projectRegistry.load(projectsDir)).rejects.toThrow();
    } finally {
      renameSync(moved, projectsDir);
    }
    expect(() => store.getDefaultAgent()).toThrow();
    expect(() => store.getAgentByName('raven')).toThrow();
    expect(() => store.listAgents()).toThrow();
    await projectRegistry.load(projectsDir);
    expect(store.getDefaultAgent().id).toBe('raven');
  });

  it('does not create an agent in a project whose metadata identity changed', async () => {
    mkdirSync(join(projectsDir, 'alpha'));
    writeFileSync(join(projectsDir, 'alpha/context.md'), '# Alpha\n');
    await projectRegistryLoad();
    writeFileSync(
      join(projectsDir, 'alpha/context.md'),
      '---\nravenProject:\n  version: 1\n  id: changed\n---\n# Alpha\n',
    );
    await expect(
      store.createAgent({ name: 'new', skills: [] }, { projectScope: 'alpha' }),
    ).rejects.toThrow(/identity changed/);
    expect(existsSync(join(projectsDir, 'alpha/agents/new'))).toBe(false);
  });

  async function projectRegistryLoad(): Promise<void> {
    const registry = new ProjectRegistry();
    await registry.load(projectsDir);
    projectRegistry = registry;
    store = createYamlNamedAgentStore({
      projectRegistry: registry,
      agentYamlStore: createAgentYamlStore(),
      projectsDir,
      eventBus: eventBus as any,
    });
  }
});
