import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { AgentTaskCompleteEvent, AgentTaskRequestEvent } from '@raven/shared';
import { createRaven, type RavenInstance } from '../raven.ts';
import type { BackendOptions } from '../agent-manager/agent-backend.ts';
import { buildTestConfig, createRavenTestFixture } from './fixtures/raven-fixture.ts';

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

async function useMemory(options: BackendOptions): Promise<string> {
  const server = (options.mcpServers.memory as McpSdkServerConfigWithInstance).instance;
  const client = new Client({ name: 'project-memory-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: options.prompt.includes('read shared note') ? 'memory_read' : 'memory_write',
      arguments: { path: 'research/shared.md', content: options.prompt },
    });
    expect(result.isError).not.toBe(true);
    return JSON.stringify(result);
  } finally {
    await client.close();
    await server.close();
  }
}

describe('e2e: project agent and memory ownership', () => {
  let root: string | undefined;
  let raven: RavenInstance | undefined;
  afterEach(async () => {
    await raven?.stop();
    raven = undefined;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('selects local namesakes, shares project notes, and preserves isolation after restart', async () => {
    root = mkdtempSync(join(tmpdir(), 'raven-project-agent-memory-'));
    const fixture = createRavenTestFixture(root);
    for (const [id, model, turns] of [
      ['alpha', 'haiku', 3],
      ['beta', 'sonnet', 7],
    ]) {
      const home = join(fixture.projectsDir, String(id));
      write(join(home, 'context.md'), `# ${id}\n`);
      write(join(home, 'memory/MEMORY.md'), `# ${id} private index\n`);
      write(
        join(home, 'agents/raven/agent.yaml'),
        `name: raven\ndisplayName: Raven\ndescription: Local\nisDefault: true\nskills: []\nmodel: ${model}\nmaxTurns: ${turns}\n`,
      );
    }
    const calls: BackendOptions[] = [];
    const memoryResults: string[] = [];
    const completions: AgentTaskCompleteEvent[] = [];
    const requests: AgentTaskRequestEvent[] = [];
    const boot = async () => {
      raven = await createRaven(buildTestConfig(), {
        ...fixture,
        skipSuites: true,
        agentBackend: async (options) => {
          calls.push(options);
          memoryResults.push(await useMemory(options));
          return { success: true, result: 'Saved', errors: [], estimatedCostUsd: 0 };
        },
      });
      raven.eventBus.on<AgentTaskCompleteEvent>('agent:task:complete', (event) => {
        completions.push(event);
      });
      raven.eventBus.on<AgentTaskRequestEvent>('agent:task:request', (event) => {
        requests.push(event);
      });
      await raven.start();
    };
    const request = async (path: string, body?: unknown) =>
      fetch(`http://localhost:${raven!.port}/api${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    await boot();
    for (const [index, id] of ['alpha', 'beta'].entries()) {
      expect((await request(`/projects/${id}/chat`, { message: `${id} work` })).status).toBe(200);
      await vi.waitFor(() => expect(completions).toHaveLength(index + 1));
    }
    await vi.waitFor(() => expect(completions).toHaveLength(2));
    expect(completions.every((event) => event.payload.success)).toBe(true);
    expect(requests.map((event) => event.payload.namedAgentId)).toEqual([
      'alpha::raven',
      'beta::raven',
    ]);
    expect(calls[0]).toMatchObject({ model: 'claude-haiku-4-5', maxTurns: 3 });
    expect(calls[1]).toMatchObject({ model: 'claude-sonnet-5', maxTurns: 7 });
    expect(calls[0].systemPrompt).toContain('alpha private index');
    expect(calls[0].systemPrompt).not.toContain('beta private index');
    expect(calls[1].systemPrompt).toContain('beta private index');
    expect(calls[1].systemPrompt).not.toContain('alpha private index');
    const notes = await (await request('/projects/alpha/memory')).json();
    expect(notes).toContainEqual({
      file: 'research/shared.md',
      content: expect.stringContaining('alpha work'),
    });
    expect(JSON.stringify(notes)).not.toContain('beta work');

    await raven!.stop();
    raven = undefined;
    await boot();
    expect(await (await request('/projects/alpha/memory')).json()).toEqual(notes);
    expect((await request('/projects/missing/memory')).status).toBe(404);
    expect((await request('/agents/raven/memory')).status).toBe(404);
    const agentResponse = await request('/agents', {
      name: 'scribe',
      skills: [],
      projectScope: 'alpha',
    });
    expect(agentResponse.status).toBe(201);
    const secondAgent = (await agentResponse.json()) as { id: string };
    expect(secondAgent.id).toBe('alpha::scribe');
    raven!.eventBus.emit({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      source: 'memory-test',
      type: 'agent:task:request',
      payload: {
        taskId: 'shared-project-memory',
        namedAgentId: secondAgent.id,
        projectId: 'alpha',
        skillName: 'orchestrator',
        prompt: 'read shared note',
        priority: 'normal',
        mcpServers: {},
      },
    } satisfies AgentTaskRequestEvent);
    await vi.waitFor(() => expect(completions).toHaveLength(3));
    expect(completions[2].payload.success).toBe(true);
    expect(memoryResults[2]).toContain('alpha work');
    expect(memoryResults[2]).not.toContain('beta work');
    expect(
      readFileSync(join(fixture.projectsDir, 'alpha/memory/research/shared.md'), 'utf8'),
    ).toContain('alpha work');
  }, 20000);
});
