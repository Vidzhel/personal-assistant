import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RetrievalResult, RavenEvent, McpServerConfig } from '@raven/shared';
import { createContextInjector } from '../knowledge-engine/context-injector.ts';
import type { RetrievalEngine } from '../knowledge-engine/retrieval.ts';
import type { MessageStore } from '../session-manager/message-store.ts';
import { createKnowledgeAgentDefinition } from '../knowledge-engine/knowledge-agent.ts';
import { Orchestrator } from '../orchestrator/orchestrator.ts';
import { EventBus } from '../event-bus/event-bus.ts';
import { SuiteRegistry } from '../suite-registry/suite-registry.ts';
import { SessionManager } from '../session-manager/session-manager.ts';
import { createMessageStore } from '../session-manager/message-store.ts';
import { initDatabase, getDb } from '../db/database.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function makeRetrievalResult(overrides: Partial<RetrievalResult> = {}): RetrievalResult {
  return {
    results: [],
    query: 'test query',
    queryType: 'generic',
    totalCandidates: 0,
    tokenBudgetUsed: 0,
    tokenBudgetTotal: 4000,
    ...overrides,
  };
}

function makeResultItem(overrides: any = {}) {
  return {
    bubbleId: 'bubble-1',
    title: 'Test Bubble',
    contentPreview: 'Preview text',
    score: 0.85,
    provenance: { tier: 1, tierName: 'chunk_vector', rawScore: 0.85, permanenceWeight: 1.0 },
    tags: ['tag1', 'tag2'],
    domains: ['general'],
    permanence: 'normal' as const,
    ...overrides,
  };
}

describe('createContextInjector', () => {
  let mockRetrievalEngine: RetrievalEngine;
  let searchMock: any;

  beforeEach(() => {
    searchMock = vi.fn();
    mockRetrievalEngine = {
      search: searchMock,
      retrieveTimeline: vi.fn() as any,
      getIndexStatus: vi.fn() as any,
      enrichWithSource: vi.fn() as any,
    };
  });

  describe('retrieveContext', () => {
    it('returns formatted context when results are found', async () => {
      const item = makeResultItem();
      searchMock.mockResolvedValue(
        makeRetrievalResult({
          results: [item],
          tokenBudgetUsed: 100,
        }),
      );

      const injector = createContextInjector({ retrievalEngine: mockRetrievalEngine });
      const ctx = await injector.retrieveContext('test query');

      expect(ctx).not.toBeNull();
      expect(ctx!.references).toHaveLength(1);
      expect(ctx!.references[0].bubbleId).toBe('bubble-1');
      expect(ctx!.references[0].title).toBe('Test Bubble');
      expect(ctx!.references[0].snippet).toBe('Preview text');
      expect(ctx!.references[0].score).toBe(0.85);
      expect(ctx!.references[0].tierName).toBe('chunk_vector');
      expect(ctx!.references[0].tags).toEqual(['tag1', 'tag2']);
      expect(ctx!.tokenBudgetUsed).toBe(100);
      expect(ctx!.query).toBe('test query');
    });

    it('returns null when retrieval returns zero results (AC #4)', async () => {
      searchMock.mockResolvedValue(makeRetrievalResult({ results: [] }));

      const injector = createContextInjector({ retrievalEngine: mockRetrievalEngine });
      const ctx = await injector.retrieveContext('unknown topic');

      expect(ctx).toBeNull();
    });

    it('returns null when all results are below minScore', async () => {
      searchMock.mockResolvedValue(
        makeRetrievalResult({
          results: [makeResultItem({ score: 0.1 }), makeResultItem({ bubbleId: 'b2', score: 0.2 })],
        }),
      );

      const injector = createContextInjector({ retrievalEngine: mockRetrievalEngine });
      const ctx = await injector.retrieveContext('low relevance');

      expect(ctx).toBeNull();
    });

    it('filters out results below minScore threshold', async () => {
      searchMock.mockResolvedValue(
        makeRetrievalResult({
          results: [
            makeResultItem({ bubbleId: 'high', score: 0.8 }),
            makeResultItem({ bubbleId: 'low', score: 0.2 }),
          ],
        }),
      );

      const injector = createContextInjector({ retrievalEngine: mockRetrievalEngine });
      const ctx = await injector.retrieveContext('partial match');

      expect(ctx).not.toBeNull();
      expect(ctx!.references).toHaveLength(1);
      expect(ctx!.references[0].bubbleId).toBe('high');
    });

    it('respects custom token budget option', async () => {
      searchMock.mockResolvedValue(makeRetrievalResult({ results: [] }));

      const injector = createContextInjector({ retrievalEngine: mockRetrievalEngine });
      await injector.retrieveContext('test', { tokenBudget: 1000 });

      expect(searchMock).toHaveBeenCalledWith('test', {
        tokenBudget: 1000,
        limit: 10,
      });
    });

    it('uses default 2000 token budget when no option provided', async () => {
      searchMock.mockResolvedValue(makeRetrievalResult({ results: [] }));

      const injector = createContextInjector({ retrievalEngine: mockRetrievalEngine });
      await injector.retrieveContext('test');

      expect(searchMock).toHaveBeenCalledWith('test', {
        tokenBudget: 2000,
        limit: 10,
      });
    });

    it('respects custom minScore option', async () => {
      searchMock.mockResolvedValue(
        makeRetrievalResult({
          results: [makeResultItem({ score: 0.5 })],
        }),
      );

      const injector = createContextInjector({ retrievalEngine: mockRetrievalEngine });

      // With high minScore, should filter out the result
      const ctx = await injector.retrieveContext('test', { minScore: 0.7 });
      expect(ctx).toBeNull();
    });

    it('uses chunkText as snippet when available', async () => {
      searchMock.mockResolvedValue(
        makeRetrievalResult({
          results: [makeResultItem({ chunkText: 'Chunk detail text' })],
        }),
      );

      const injector = createContextInjector({ retrievalEngine: mockRetrievalEngine });
      const ctx = await injector.retrieveContext('test');

      expect(ctx!.references[0].snippet).toBe('Chunk detail text');
    });
  });

  describe('formatContext', () => {
    it('formats references as markdown with title, tags, score, source, ref', () => {
      const injector = createContextInjector({ retrievalEngine: mockRetrievalEngine });
      const formatted = injector.formatContext({
        references: [
          {
            bubbleId: 'b1',
            title: 'My Knowledge',
            snippet: 'Some content here',
            score: 0.92,
            tierName: 'chunk_vector',
            tags: ['work', 'project'],
          },
        ],
        tokenBudgetUsed: 50,
        query: 'test',
      });

      expect(formatted).toContain('### My Knowledge');
      expect(formatted).toContain('Tags: work, project');
      expect(formatted).toContain('Score: 0.92');
      expect(formatted).toContain('Source: chunk_vector');
      expect(formatted).toContain('Some content here');
      expect(formatted).toContain('[ref: b1]');
    });

    it('shows "none" for empty tags', () => {
      const injector = createContextInjector({ retrievalEngine: mockRetrievalEngine });
      const formatted = injector.formatContext({
        references: [
          {
            bubbleId: 'b1',
            title: 'No Tags',
            snippet: 'content',
            score: 0.5,
            tierName: 'linked',
            tags: [],
          },
        ],
        tokenBudgetUsed: 10,
        query: 'test',
      });

      expect(formatted).toContain('Tags: none');
    });

    it('formats multiple references', () => {
      const injector = createContextInjector({ retrievalEngine: mockRetrievalEngine });
      const formatted = injector.formatContext({
        references: [
          {
            bubbleId: 'b1',
            title: 'First',
            snippet: 'first content',
            score: 0.9,
            tierName: 'chunk_vector',
            tags: ['a'],
          },
          {
            bubbleId: 'b2',
            title: 'Second',
            snippet: 'second content',
            score: 0.7,
            tierName: 'linked',
            tags: ['b'],
          },
        ],
        tokenBudgetUsed: 100,
        query: 'test',
      });

      expect(formatted).toContain('### First');
      expect(formatted).toContain('### Second');
      expect(formatted).toContain('[ref: b1]');
      expect(formatted).toContain('[ref: b2]');
    });
  });
});

function makeSuiteRegistry(
  suites: Array<{
    name: string;
    mcpServers?: Record<string, McpServerConfig>;
    agents?: Array<{ name: string; description: string; prompt: string; tools: string[] }>;
    schedules?: Array<{
      id: string;
      name: string;
      cron: string;
      taskType: string;
      enabled: boolean;
    }>;
  }> = [],
): SuiteRegistry {
  const registry = new SuiteRegistry();
  for (const suite of suites) {
    (registry as any).suites.set(suite.name, {
      manifest: {
        name: suite.name,
        displayName: suite.name,
        version: '1.0.0',
        description: `${suite.name} suite`,
        capabilities: [],
        requiresEnv: [],
        services: [],
      },
      agents: (suite.agents ?? []).map((a) => ({
        name: a.name,
        description: a.description,
        model: 'sonnet',
        tools: a.tools,
        maxTurns: 10,
        prompt: a.prompt,
      })),
      mcpServers: suite.mcpServers ?? {},
      actions: [],
      schedules: suite.schedules ?? [],
      vendorPlugins: [],
      suiteDir: '/tmp/test',
    });
  }
  return registry;
}

describe('Orchestrator context injection integration', () => {
  let tmpDir: string;
  let eventBus: EventBus;
  let searchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-ctx-'));
    initDatabase(join(tmpDir, 'test.db'));
    eventBus = new EventBus();
    searchMock = vi.fn();
  });

  afterEach(() => {
    eventBus.removeAllListeners();
    try {
      getDb().close();
    } catch {
      /* */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('user:chat:message does not include knowledgeContext (agents use MCP tools instead)', async () => {
    const db = getDb();
    const now = Date.now();
    db.prepare(
      'INSERT INTO projects (id, name, skills, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('proj-1', 'Test', '[]', now, now);

    const _orchestrator = new Orchestrator({
      eventBus,
      suiteRegistry: makeSuiteRegistry(),
      sessionManager: new SessionManager(),
      messageStore: createMessageStore({ basePath: join(tmpDir, 'sessions') }),
      port: 4000,
    });

    const taskRequestPromise = new Promise<RavenEvent>((resolve) => {
      eventBus.on('agent:task:request', (e) => resolve(e));
    });

    eventBus.emit({
      id: 'evt-1',
      timestamp: Date.now(),
      source: 'test',
      type: 'user:chat:message',
      payload: { projectId: 'proj-1', message: 'What do I know about TypeScript?' },
    } as RavenEvent);

    const event = await taskRequestPromise;
    const payload = (event as any).payload;
    // Knowledge context is no longer injected upfront — agents call search_knowledge via MCP
    expect(payload.knowledgeContext).toBeUndefined();
    expect(payload.prompt).toContain('What do I know about TypeScript?');
  });

  it('user:chat:message merges knowledge-agent into agentDefinitions', async () => {
    const db = getDb();
    const now = Date.now();
    db.prepare(
      'INSERT INTO projects (id, name, skills, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('proj-1', 'Test', '[]', now, now);

    const _orchestrator = new Orchestrator({
      eventBus,
      suiteRegistry: makeSuiteRegistry(),
      sessionManager: new SessionManager(),
      messageStore: createMessageStore({ basePath: join(tmpDir, 'sessions') }),
      port: 4000,
    });

    const taskRequestPromise = new Promise<RavenEvent>((resolve) => {
      eventBus.on('agent:task:request', (e) => resolve(e));
    });

    eventBus.emit({
      id: 'evt-3',
      timestamp: Date.now(),
      source: 'test',
      type: 'user:chat:message',
      payload: { projectId: 'proj-1', message: 'Search my knowledge' },
    } as RavenEvent);

    const event = await taskRequestPromise;
    const payload = (event as any).payload;
    expect(payload.agentDefinitions).toHaveProperty('knowledge-agent');
    expect(payload.agentDefinitions['knowledge-agent'].description).toContain(
      'Knowledge management',
    );
    expect(payload.agentDefinitions['knowledge-agent'].tools).toHaveLength(0);
    expect(payload.agentDefinitions['knowledge-agent'].prompt).toContain('search_knowledge');
  });

  it('email:new does not inject knowledgeContext (agents use MCP tools instead)', async () => {
    const suiteRegistry = makeSuiteRegistry([
      {
        name: 'email',
        mcpServers: { email_gmail: { command: 'node', args: ['gmail.js'] } },
      },
    ]);

    const _orchestrator = new Orchestrator({
      eventBus,
      suiteRegistry,
      sessionManager: new SessionManager(),
      messageStore: createMessageStore({ basePath: join(tmpDir, 'sessions') }),
      port: 4000,
    });

    const taskRequestPromise = new Promise<RavenEvent>((resolve) => {
      eventBus.on('agent:task:request', (e) => resolve(e));
    });

    eventBus.emit({
      id: 'evt-4',
      timestamp: Date.now(),
      source: 'gmail',
      type: 'email:new',
      payload: {
        from: 'boss@company.com',
        subject: 'Q1 Review',
        snippet: 'Quarterly performance',
        messageId: 'msg-1',
        receivedAt: Date.now(),
      },
    } as RavenEvent);

    const event = await taskRequestPromise;
    const payload = (event as any).payload;
    // Knowledge context no longer injected upfront
    expect(payload.knowledgeContext).toBeUndefined();
    // Search mock should NOT have been called — no upfront context injection
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('schedule:triggered does not inject knowledgeContext (agents use MCP tools instead)', async () => {
    const suiteRegistry = makeSuiteRegistry([
      {
        name: 'digest',
        schedules: [
          {
            id: 's1',
            name: 'Morning Digest',
            cron: '0 8 * * *',
            taskType: 'morning-digest',
            enabled: true,
          },
        ],
      },
    ]);

    const _orchestrator = new Orchestrator({
      eventBus,
      suiteRegistry,
      sessionManager: new SessionManager(),
      messageStore: createMessageStore({ basePath: join(tmpDir, 'sessions') }),
      port: 4000,
    });

    const taskRequestPromise = new Promise<RavenEvent>((resolve) => {
      eventBus.on('agent:task:request', (e) => resolve(e));
    });

    eventBus.emit({
      id: 'evt-5',
      timestamp: Date.now(),
      source: 'scheduler',
      type: 'schedule:triggered',
      payload: {
        scheduleId: 's1',
        scheduleName: 'Morning Digest',
        taskType: 'morning-digest',
      },
    } as RavenEvent);

    const event = await taskRequestPromise;
    const payload = (event as any).payload;
    // Knowledge context no longer injected upfront
    expect(payload.knowledgeContext).toBeUndefined();
    // Search mock should NOT have been called
    expect(searchMock).not.toHaveBeenCalled();
  });
});

describe('Knowledge agent definition', () => {
  it('creates agent definition with correct description and MCP-only tools', () => {
    const def = createKnowledgeAgentDefinition();

    expect(def.description).toContain('Knowledge management');
    expect(def.tools).toHaveLength(0);
    expect(def.prompt).toContain('search_knowledge');
    expect(def.prompt).toContain('save_knowledge');
    expect(def.prompt).toContain('get_knowledge_context');
  });

  it('instructs agent not to use WebFetch for localhost APIs', () => {
    const def = createKnowledgeAgentDefinition();

    expect(def.prompt).toContain('Do not use WebFetch');
  });
});

describe('Reference tracking', () => {
  it('stores role=context message in message store', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'raven-ref-'));
    const store = createMessageStore({ basePath: tmpDir });

    store.appendMessage('session-1', {
      role: 'context',
      content:
        '### My Bubble\nTags: test | Score: 0.90 | Source: chunk_vector\nSome content\n[ref: bubble-123]\n',
      taskId: 'task-1',
    });

    const messages = store.getMessages('session-1');
    const contextMsgs = messages.filter((m) => m.role === 'context');
    expect(contextMsgs).toHaveLength(1);
    expect(contextMsgs[0].content).toContain('[ref: bubble-123]');
    expect(contextMsgs[0].taskId).toBe('task-1');

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('context messages are excluded from conversation history filtering', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'raven-ref2-'));
    const store: MessageStore = createMessageStore({ basePath: tmpDir });

    store.appendMessage('session-1', { role: 'user', content: 'Hello' });
    store.appendMessage('session-1', {
      role: 'context',
      content: '[ref: b1]',
      taskId: 'task-1',
    });
    store.appendMessage('session-1', { role: 'assistant', content: 'Hi' });

    const messages = store.getMessages('session-1');
    expect(messages).toHaveLength(3);
    // The context message should be present in the raw messages
    expect(messages.some((m) => m.role === 'context')).toBe(true);

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
