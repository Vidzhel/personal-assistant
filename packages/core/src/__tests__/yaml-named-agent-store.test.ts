import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
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
  let eventBus: ReturnType<typeof makeMockEventBus>;

  beforeEach(async () => {
    projectsDir = mkdtempSync(join(tmpdir(), 'raven-yamlstore-'));
    writeFileSync(join(projectsDir, 'context.md'), '# Global\n');
    mkdirSync(join(projectsDir, 'agents', 'raven'), { recursive: true });
    writeFileSync(join(projectsDir, 'agents', 'raven', 'agent.yaml'), RAVEN_YAML);

    const projectRegistry = new ProjectRegistry();
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
    expect(agents[0].suiteIds).toEqual([]);
  });

  it('returns the default agent', () => {
    expect(store.getDefaultAgent().name).toBe('raven');
  });

  it('creates an agent as <name>/agent.yaml and emits created event', async () => {
    const agent = await store.createAgent({
      name: 'researcher',
      description: 'Research things',
      suiteIds: [],
      skills: ['web-search'],
    });

    expect(agent.id).toBe('researcher');
    expect(agent.skills).toEqual(['web-search']);
    expect(existsSync(join(projectsDir, 'agents', 'researcher', 'agent.yaml'))).toBe(true);
    expect(store.getAgentByName('researcher')?.description).toBe('Research things');

    const created = eventBus.events.find((e) => e.type === 'agent:config:created');
    expect(created).toBeDefined();
    expect(created!.payload.name).toBe('researcher');
    expect(created!.payload.filePath).toContain('researcher');
  });

  it('rejects duplicate names', async () => {
    await expect(
      store.createAgent({ name: 'raven', suiteIds: [], skills: [] }),
    ).rejects.toThrow(/already exists/);
  });

  it('updates fields and persists to YAML', async () => {
    await store.createAgent({ name: 'temp-agent', suiteIds: [], skills: [] });
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

  it('renames an agent (new file created, old removed, id follows name)', async () => {
    await store.createAgent({ name: 'old-name', suiteIds: [], skills: [] });
    const renamed = await store.updateAgent('old-name', { name: 'new-name' });
    expect(renamed.id).toBe('new-name');
    expect(store.getAgent('old-name')).toBeUndefined();
    expect(store.getAgent('new-name')).toBeDefined();
    expect(existsSync(join(projectsDir, 'agents', 'new-name', 'agent.yaml'))).toBe(true);
    expect(existsSync(join(projectsDir, 'agents', 'old-name'))).toBe(false);
  });

  it('refuses to rename or delete the default agent', async () => {
    await expect(store.updateAgent('raven', { name: 'corvid' })).rejects.toThrow(/Cannot rename/);
    await expect(store.deleteAgent('raven')).rejects.toThrow(/Cannot delete/);
  });

  it('deletes a non-default agent and emits deleted event', async () => {
    await store.createAgent({ name: 'doomed', suiteIds: [], skills: [] });
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
    expect(s2.getAgentByName('sub-agent')).toBeDefined();
  });
});
