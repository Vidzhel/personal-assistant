import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type * as AgentSdk from '@anthropic-ai/claude-agent-sdk';
import { query, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { AgentTask, NamedAgent } from '@raven/shared';
import { runAgentTask, setActiveBackend } from '../agent-manager/agent-session.ts';
import { createSdkBackend } from '../agent-manager/sdk-backend.ts';
import { createAgentResolver } from '../agent-registry/agent-resolver.ts';
import { createMemoryStore } from '../agent-memory/memory-store.ts';
import { setConfig } from '../config.ts';
import { buildTestConfig } from './fixtures/raven-fixture.ts';
import { EventBus } from '../event-bus/event-bus.ts';
import type { RavenMcpDeps } from '../mcp-server/types.ts';
import type { KnowledgeStore } from '../knowledge-engine/knowledge-store.ts';
import type { RetrievalEngine } from '../knowledge-engine/retrieval.ts';

// Preserve the real SDK MCP implementation; only model execution is replaced.
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof AgentSdk>()),
  query: vi.fn(),
}));

const noSkillsAgent: NamedAgent = {
  id: 'raven',
  name: 'raven',
  description: null,
  instructions: null,
  skills: [],
  model: null,
  maxTurns: null,
  isDefault: true,
  createdAt: '',
  updatedAt: '',
};

describe('SDK knowledge availability and scope', () => {
  let root: string;
  let eventBus: EventBus;
  let finishQuery: () => void;
  let running: ReturnType<typeof runAgentTask> | undefined;
  const connections: Array<{ client: Client; server: McpSdkServerConfigWithInstance['instance'] }> =
    [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'raven-sdk-knowledge-'));
    eventBus = new EventBus();
    setConfig(buildTestConfig());
    vi.mocked(query).mockReset();
    running = undefined;
    const queryGate = new Promise<void>((resolve) => {
      finishQuery = resolve;
    });
    vi.mocked(query).mockImplementation(async function* () {
      await queryGate;
      yield { type: 'result', result: 'Fixture answer', subtype: 'success' };
    } as unknown as typeof query);
    setActiveBackend(createSdkBackend());
  });

  afterEach(async () => {
    finishQuery();
    if (running) {
      expect(await running).toMatchObject({ success: true, result: 'Fixture answer' });
    }
    for (const { client, server } of connections.splice(0)) {
      await client.close();
      await server.close();
    }
    eventBus.removeAllListeners();
    rmSync(root, { recursive: true, force: true });
  });

  async function connect(config: McpSdkServerConfigWithInstance) {
    const server = config.instance;
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    connections.push({ client, server });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
  }

  async function dispatch(deps?: RavenMcpDeps, overrides: Partial<AgentTask> = {}) {
    const capabilities = createAgentResolver({}).resolveAgentCapabilities(noSkillsAgent);
    const task: AgentTask = {
      id: 'fixture-task',
      skillName: 'orchestrator',
      projectId: 'fixture-project',
      namedAgentId: 'raven',
      prompt: 'Help with my notes',
      status: 'queued',
      priority: 'normal',
      createdAt: 0,
      ...capabilities,
      ...overrides,
    };
    running = runAgentTask({
      task,
      eventBus,
      ...capabilities,
      ravenMcpDeps: deps,
      memoryStore: createMemoryStore({ projectsDir: join(root, 'projects') }),
    });
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
    return vi.mocked(query).mock.calls[0][0].options!;
  }

  function graphDeps() {
    const search = vi.fn().mockResolvedValue({
      results: [
        {
          bubbleId: 'note-1',
          title: 'Fixture note',
          contentPreview: 'Useful saved context',
          tags: ['testing'],
          score: 0.9,
        },
      ],
    });
    const insert = vi.fn().mockResolvedValue({ id: 'new-note' });
    const deps: RavenMcpDeps = {
      eventBus,
      retrievalEngine: { search } as unknown as RetrievalEngine,
      knowledgeStore: { insert } as unknown as KnowledgeStore,
    };
    return { deps, search, insert };
  }

  it('omits graph tools and nonexistent specialists with empty skills while ordinary memory works', async () => {
    const options = await dispatch({ eventBus });
    expect(options.agents).toBeUndefined();
    expect(options.plugins).toBeUndefined();
    expect(options.allowedTools).not.toContain('Agent');
    expect(options.systemPrompt).not.toMatch(/knowledge|specialized sub-agents|## Delegation/i);
    expect(Object.keys(options.mcpServers!)).toEqual(['raven', 'memory']);
    const raven = await connect(options.mcpServers!.raven as McpSdkServerConfigWithInstance);
    expect((await raven.listTools()).tools.map((tool) => tool.name)).not.toContain(
      'search_knowledge',
    );
    for (const name of ['search_knowledge', 'save_knowledge', 'get_knowledge_context']) {
      expect(
        await raven.callTool({ name, arguments: { query: 'notes', content: 'not saved' } }),
      ).toMatchObject({ isError: true });
    }
    const memory = await connect(options.mcpServers!.memory as McpSdkServerConfigWithInstance);
    expect(
      (
        await memory.callTool({
          name: 'memory_write',
          arguments: { path: 'note.md', content: 'Remember this fixture' },
        })
      ).isError,
    ).not.toBe(true);
    expect(
      JSON.stringify(
        await memory.callTool({ name: 'memory_read', arguments: { path: 'note.md' } }),
      ),
    ).toContain('Remember this fixture');
  });

  it.each(['chat', 'task'])(
    'exposes callable retrieval but denies knowledge writes to %s',
    async (role) => {
      const { deps, search, insert } = graphDeps();
      const options = await dispatch(
        deps,
        role === 'task' ? { executionTaskId: 'execution-1' } : {},
      );
      expect(options.systemPrompt).toContain('search_knowledge');
      expect(options.systemPrompt).not.toMatch(
        /save_knowledge|get_knowledge_context|knowledge-agent/,
      );
      const client = await connect(options.mcpServers!.raven as McpSdkServerConfigWithInstance);
      const knowledge = (await client.listTools()).tools.filter((tool) =>
        tool.name.includes('knowledge'),
      );
      expect(knowledge.map((tool) => tool.name)).toEqual(['search_knowledge']);
      expect(Object.keys(knowledge[0].inputSchema.properties!)).toEqual(['query', 'limit']);
      const found = await client.callTool({
        name: 'search_knowledge',
        arguments: { query: 'fixture', limit: 3 },
      });
      expect(found.isError).not.toBe(true);
      expect(JSON.stringify(found)).toContain('Useful saved context');
      expect(search).toHaveBeenCalledWith('fixture', { limit: 3 });
      expect(
        await client.callTool({ name: 'save_knowledge', arguments: { content: 'must be denied' } }),
      ).toMatchObject({ isError: true });
      expect(insert).not.toHaveBeenCalled();
    },
  );

  it('keeps save tags and formatted context available to the authorized knowledge role', async () => {
    const { deps, insert, search } = graphDeps();
    const options = await dispatch(deps, { skillName: 'knowledge' });
    expect(options.systemPrompt).toContain('save_knowledge');
    expect(options.systemPrompt).toContain('get_knowledge_context');
    const client = await connect(options.mcpServers!.raven as McpSdkServerConfigWithInstance);
    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name)).toEqual([
      'search_knowledge',
      'save_knowledge',
      'get_knowledge_context',
    ]);
    expect(
      tools.find((tool) => tool.name === 'save_knowledge')!.inputSchema.properties,
    ).toHaveProperty('tags');
    expect(
      tools.find((tool) => tool.name === 'save_knowledge')!.inputSchema.properties,
    ).not.toHaveProperty('domain');
    expect(
      (
        await client.callTool({
          name: 'save_knowledge',
          arguments: { content: 'Saved fixture', tags: ['testing'] },
        })
      ).isError,
    ).not.toBe(true);
    expect(insert).toHaveBeenCalledWith({
      content: 'Saved fixture',
      title: 'Saved fixture',
      tags: ['testing'],
      permanence: undefined,
    });
    expect(
      JSON.stringify(
        await client.callTool({ name: 'get_knowledge_context', arguments: { query: 'fixture' } }),
      ),
    ).toContain('## Fixture note');
    expect(search).toHaveBeenCalledWith('fixture', { limit: 5 });
  });

  it('does not advertise Raven tools when no Raven MCP dependencies are provided', async () => {
    const options = await dispatch();
    expect(options.mcpServers).not.toHaveProperty('raven');
    expect(options.systemPrompt).not.toContain('Raven MCP tools');
    expect(options.systemPrompt).not.toContain('search_knowledge');
  });
});
