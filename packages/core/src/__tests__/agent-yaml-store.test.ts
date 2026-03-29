import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { load as yamlLoad } from 'js-yaml';

import { createAgentYamlStore } from '../project-registry/agent-yaml-store.ts';
import type { AgentYaml } from '@raven/shared';

function makeAgent(overrides: Partial<AgentYaml> = {}): AgentYaml {
  return {
    name: 'test-agent',
    displayName: 'Test Agent',
    description: 'A test agent',
    skills: [],
    isDefault: false,
    model: 'sonnet',
    maxTurns: 15,
    ...overrides,
  };
}

describe('AgentYamlStore', () => {
  let tmpDir: string;
  const store = createAgentYamlStore();

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agent-yaml-store-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates agent YAML file in correct location', async () => {
    const agent = makeAgent();
    await store.createAgent(tmpDir, agent);

    const filePath = join(tmpDir, 'agents', 'test-agent.yaml');
    const content = await readFile(filePath, 'utf-8');
    expect(content).toBeTruthy();
  });

  it('creates agents/ directory if it does not exist', async () => {
    const agent = makeAgent();
    await store.createAgent(tmpDir, agent);

    const content = await readFile(join(tmpDir, 'agents', 'test-agent.yaml'), 'utf-8');
    expect(content).toBeTruthy();
  });

  it('written YAML is valid and parseable', async () => {
    const agent = makeAgent({ name: 'my-agent', displayName: 'My Agent' });
    await store.createAgent(tmpDir, agent);

    const content = await readFile(join(tmpDir, 'agents', 'my-agent.yaml'), 'utf-8');
    const parsed = yamlLoad(content) as Record<string, unknown>;
    expect(parsed.name).toBe('my-agent');
    expect(parsed.displayName).toBe('My Agent');
    expect(parsed.description).toBe('A test agent');
  });

  it('updates merge correctly — original fields preserved, new fields added', async () => {
    const agent = makeAgent({ name: 'merge-test', instructions: 'original instructions' });
    await store.createAgent(tmpDir, agent);

    const result = await store.updateAgent(tmpDir, 'merge-test', {
      description: 'Updated description',
      model: 'opus',
    });

    expect(result.name).toBe('merge-test');
    expect(result.displayName).toBe('Test Agent');
    expect(result.instructions).toBe('original instructions');
    expect(result.description).toBe('Updated description');
    expect(result.model).toBe('opus');
  });

  it('update keeps name immutable even if updates includes a different name', async () => {
    const agent = makeAgent({ name: 'immutable-name' });
    await store.createAgent(tmpDir, agent);

    const result = await store.updateAgent(tmpDir, 'immutable-name', {
      name: 'changed-name' as any,
      description: 'New desc',
    });

    expect(result.name).toBe('immutable-name');
  });

  it('delete removes the file', async () => {
    const agent = makeAgent({ name: 'to-delete' });
    await store.createAgent(tmpDir, agent);

    await store.deleteAgent(tmpDir, 'to-delete');

    await expect(readFile(join(tmpDir, 'agents', 'to-delete.yaml'), 'utf-8')).rejects.toThrow();
  });

  it('create validates with schema — rejects invalid agent', async () => {
    const invalid = { name: 'INVALID NAME', displayName: '', description: '' } as any;
    await expect(store.createAgent(tmpDir, invalid)).rejects.toThrow();
  });

  it('update validates merged result', async () => {
    const agent = makeAgent({ name: 'validate-update' });
    await store.createAgent(tmpDir, agent);

    await expect(
      store.updateAgent(tmpDir, 'validate-update', { model: 'invalid-model' as any }),
    ).rejects.toThrow();
  });
});
