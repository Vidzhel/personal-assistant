import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createKnowledgeLifecycle } from '../knowledge-engine/knowledge-lifecycle.ts';
import { createRetrospective } from '../knowledge-engine/retrospective.ts';
import { EventBus } from '../event-bus/event-bus.ts';
import type { Neo4jClient } from '../knowledge-engine/neo4j-client.ts';
import type { KnowledgeStore } from '../knowledge-engine/knowledge-store.ts';
import type { EmbeddingEngine } from '../knowledge-engine/embeddings.ts';
import type { ChunkingEngine } from '../knowledge-engine/chunking.ts';
import type { KnowledgeBubble, RavenEvent } from '@raven/shared';

// --- Mock Helpers ---

function createMockNeo4j(): Neo4jClient {
  return {
    run: vi.fn().mockResolvedValue({ records: [{ get: () => 'ok' }] }),
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(undefined),
    withTransaction: vi.fn().mockImplementation(async (fn: any) => fn({ run: vi.fn() })),
    ensureSchema: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockKnowledgeStore(): KnowledgeStore {
  return {
    insert: vi.fn().mockImplementation(async (input: any) => ({
      id: 'merged-id',
      title: input.title,
      content: input.content,
      filePath: 'merged.md',
      source: null,
      sourceFile: null,
      sourceUrl: null,
      tags: input.tags ?? [],
      domains: [],
      permanence: input.permanence ?? 'normal',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
    update: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(true),
    getById: vi.fn().mockResolvedValue(undefined),
    getContentPreview: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    search: vi.fn().mockResolvedValue([]),
    getAllTags: vi.fn().mockResolvedValue([]),
    reindexAll: vi.fn().mockResolvedValue({ indexed: 0, errors: [] }),
  };
}

function createMockEmbeddingEngine(): EmbeddingEngine {
  return {
    generateEmbedding: vi.fn().mockResolvedValue(new Float32Array(384)),
    generateAndStore: vi.fn().mockResolvedValue(undefined),
    getEmbedding: vi.fn().mockResolvedValue(undefined),
    getAllEmbeddings: vi.fn().mockResolvedValue([]),
    findSimilar: vi.fn().mockResolvedValue([]),
    removeEmbedding: vi.fn().mockResolvedValue(undefined),
    start: vi.fn(),
  };
}

function createMockChunkingEngine(): ChunkingEngine {
  return {
    indexBubble: vi.fn().mockResolvedValue(undefined),
    removeChunks: vi.fn().mockResolvedValue(undefined),
    backfillChunks: vi.fn().mockResolvedValue({ indexed: 0, skipped: 0 }),
    reindexAllChunks: vi.fn().mockResolvedValue({ total: 0, indexed: 0, errors: [] }),
    start: vi.fn(),
  };
}

function makeBubble(overrides: Partial<KnowledgeBubble> = {}): KnowledgeBubble {
  return {
    id: 'bubble-1',
    title: 'Test Bubble',
    content: 'Test content',
    filePath: 'test-bubble.md',
    source: null,
    sourceFile: null,
    sourceUrl: null,
    tags: ['test'],
    domains: ['general'],
    permanence: 'normal',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// --- Tests ---

describe('Knowledge Lifecycle', () => {
  let neo4j: Neo4jClient;
  let knowledgeStore: KnowledgeStore;
  let eventBus: EventBus;
  let embeddingEngine: EmbeddingEngine;
  let chunkingEngine: ChunkingEngine;

  beforeEach(() => {
    neo4j = createMockNeo4j();
    knowledgeStore = createMockKnowledgeStore();
    eventBus = new EventBus();
    embeddingEngine = createMockEmbeddingEngine();
    chunkingEngine = createMockChunkingEngine();
  });

  function createLifecycle() {
    return createKnowledgeLifecycle({
      neo4j,
      knowledgeStore,
      eventBus,
      embeddingEngine,
      chunkingEngine,
      knowledgeDir: '/tmp/knowledge',
    });
  }

  describe('detectStaleBubbles', () => {
    it('returns stale normal bubbles (>30 days since access)', async () => {
      const oldDate = new Date(Date.now() - 35 * 86_400_000).toISOString();
      (neo4j.query as any).mockResolvedValue([
        {
          id: 'stale-1',
          title: 'Old Note',
          permanence: 'normal',
          lastAccessedAt: oldDate,
          tags: ['old'],
          domains: ['general'],
        },
      ]);

      const lifecycle = createLifecycle();
      const stale = await lifecycle.detectStaleBubbles();

      expect(stale).toHaveLength(1);
      expect(stale[0].id).toBe('stale-1');
      expect(stale[0].reason).toBe('normal-stale');
      expect(stale[0].daysSinceAccess).toBeGreaterThanOrEqual(35);
    });

    it('returns stale temporary bubbles (>7 days since access)', async () => {
      const oldDate = new Date(Date.now() - 10 * 86_400_000).toISOString();
      (neo4j.query as any).mockResolvedValue([
        {
          id: 'temp-1',
          title: 'Temp Note',
          permanence: 'temporary',
          lastAccessedAt: oldDate,
          tags: [],
          domains: [],
        },
      ]);

      const lifecycle = createLifecycle();
      const stale = await lifecycle.detectStaleBubbles();

      expect(stale).toHaveLength(1);
      expect(stale[0].reason).toBe('temporary-expired');
    });

    it('never includes robust bubbles', async () => {
      // The query itself excludes robust — verify the cypher contains the filter
      (neo4j.query as any).mockResolvedValue([]);

      const lifecycle = createLifecycle();
      await lifecycle.detectStaleBubbles();

      const cypher = (neo4j.query as any).mock.calls[0][0] as string;
      expect(cypher).toContain("b.permanence <> 'robust'");
    });

    it('excludes snoozed bubbles from stale detection', async () => {
      (neo4j.query as any).mockResolvedValue([]);

      const lifecycle = createLifecycle();
      await lifecycle.detectStaleBubbles();

      const cypher = (neo4j.query as any).mock.calls[0][0] as string;
      expect(cypher).toContain('snoozedUntil');
    });

    it('supports override days parameter', async () => {
      (neo4j.query as any).mockResolvedValue([]);

      const lifecycle = createLifecycle();
      await lifecycle.detectStaleBubbles(5);

      // The query params should use the override for both thresholds
      expect(neo4j.query).toHaveBeenCalledTimes(1);
    });
  });

  describe('snoozeBubble', () => {
    it('sets snoozedUntil on the bubble node', async () => {
      const lifecycle = createLifecycle();
      const result = await lifecycle.snoozeBubble('bubble-1', 14);

      expect(result).toBe(true);
      expect(neo4j.run).toHaveBeenCalledWith(
        expect.stringContaining('snoozedUntil'),
        expect.objectContaining({ id: 'bubble-1' }),
      );
    });

    it('returns false when bubble not found', async () => {
      (neo4j.run as any).mockResolvedValue({ records: [] });

      const lifecycle = createLifecycle();
      const result = await lifecycle.snoozeBubble('nonexistent', 7);

      expect(result).toBe(false);
    });
  });

  describe('removeBubbleWithMedia', () => {
    it('removes bubble and cleans up media file', async () => {
      const bubble = makeBubble({ sourceFile: 'photo.jpg' });
      (knowledgeStore.getById as any).mockResolvedValue(bubble);

      const lifecycle = createLifecycle();
      const result = await lifecycle.removeBubbleWithMedia('bubble-1');

      expect(result).toBe(true);
      expect(knowledgeStore.remove).toHaveBeenCalledWith('bubble-1');
    });

    it('returns false when bubble not found', async () => {
      (knowledgeStore.getById as any).mockResolvedValue(undefined);

      const lifecycle = createLifecycle();
      const result = await lifecycle.removeBubbleWithMedia('nonexistent');

      expect(result).toBe(false);
      expect(knowledgeStore.remove).not.toHaveBeenCalled();
    });

    it('removes bubble without media when sourceFile is null', async () => {
      const bubble = makeBubble({ sourceFile: null });
      (knowledgeStore.getById as any).mockResolvedValue(bubble);

      const lifecycle = createLifecycle();
      const result = await lifecycle.removeBubbleWithMedia('bubble-1');

      expect(result).toBe(true);
      expect(knowledgeStore.remove).toHaveBeenCalledWith('bubble-1');
    });
  });

  describe('mergeBubbles', () => {
    // Auto-respond to agent:task:request events to simulate LLM synthesis
    function mockAgentSynthesis(): void {
      eventBus.on('agent:task:request' as any, (event: any) => {
        const taskId = event.payload?.taskId;
        if (taskId) {
          setTimeout(() => {
            eventBus.emit({
              id: 'synth-response',
              timestamp: Date.now(),
              source: 'test',
              type: 'agent:task:complete',
              payload: {
                taskId,
                result: 'Synthesized summary of merged content.',
                durationMs: 100,
                success: true,
              },
            } as any);
          }, 10);
        }
      });
    }

    it('creates merged bubble from multiple sources', async () => {
      const bubble1 = makeBubble({ id: 'b1', title: 'Note A', content: 'Content A' });
      const bubble2 = makeBubble({ id: 'b2', title: 'Note B', content: 'Content B' });
      (knowledgeStore.getById as any).mockResolvedValueOnce(bubble1).mockResolvedValueOnce(bubble2);
      mockAgentSynthesis();

      const lifecycle = createLifecycle();
      const mergedId = await lifecycle.mergeBubbles(['b1', 'b2']);

      expect(mergedId).toBe('merged-id');
      expect(knowledgeStore.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining('Note A'),
        }),
      );
      // Should re-point both incoming and outgoing links (2 neo4j.run calls for links)
      const runCalls = (neo4j.run as any).mock.calls.map((c: any) => c[0] as string);
      const repointCalls = runCalls.filter((c: string) => c.includes('repointed'));
      expect(repointCalls).toHaveLength(2);
      // Should remove old bubbles
      expect(knowledgeStore.remove).toHaveBeenCalledWith('b1');
      expect(knowledgeStore.remove).toHaveBeenCalledWith('b2');
    });

    it('uses LLM-synthesized content when agent responds', async () => {
      const bubble1 = makeBubble({ id: 'b1', title: 'Note A', content: 'Content A' });
      const bubble2 = makeBubble({ id: 'b2', title: 'Note B', content: 'Content B' });
      (knowledgeStore.getById as any).mockResolvedValueOnce(bubble1).mockResolvedValueOnce(bubble2);
      mockAgentSynthesis();

      const lifecycle = createLifecycle();
      await lifecycle.mergeBubbles(['b1', 'b2']);

      // The insert should receive the synthesized content from the mock agent
      expect(knowledgeStore.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'Synthesized summary of merged content.',
        }),
      );
    });

    it('returns undefined when less than 2 valid bubbles', async () => {
      (knowledgeStore.getById as any).mockResolvedValue(undefined);

      const lifecycle = createLifecycle();
      const result = await lifecycle.mergeBubbles(['b1', 'b2']);

      expect(result).toBeUndefined();
    });

    it('generates embedding and chunks for merged bubble', async () => {
      const bubble1 = makeBubble({ id: 'b1' });
      const bubble2 = makeBubble({ id: 'b2' });
      (knowledgeStore.getById as any).mockResolvedValueOnce(bubble1).mockResolvedValueOnce(bubble2);
      mockAgentSynthesis();

      const lifecycle = createLifecycle();
      await lifecycle.mergeBubbles(['b1', 'b2']);

      expect(embeddingEngine.generateAndStore).toHaveBeenCalledWith(
        'merged-id',
        expect.any(String),
      );
      expect(chunkingEngine.indexBubble).toHaveBeenCalledWith('merged-id');
    });
  });

  describe('upgradePermanence', () => {
    it('updates permanence on the bubble node', async () => {
      const lifecycle = createLifecycle();
      const result = await lifecycle.upgradePermanence('bubble-1', 'robust');

      expect(result).toBe(true);
      expect(neo4j.run).toHaveBeenCalledWith(
        expect.stringContaining('permanence'),
        expect.objectContaining({ id: 'bubble-1', permanence: 'robust' }),
      );
    });
  });
});

describe('Retrospective', () => {
  let neo4j: Neo4jClient;
  let eventBus: EventBus;
  let emittedEvents: RavenEvent[];

  beforeEach(() => {
    neo4j = createMockNeo4j();
    eventBus = new EventBus();
    emittedEvents = [];
    eventBus.on('*', (event: RavenEvent) => {
      emittedEvents.push(event);
    });
  });

  function createMockLifecycle() {
    return createKnowledgeLifecycle({
      neo4j: createMockNeo4j(),
      knowledgeStore: createMockKnowledgeStore(),
      eventBus,
      embeddingEngine: createMockEmbeddingEngine(),
      chunkingEngine: createMockChunkingEngine(),
      knowledgeDir: '/tmp/knowledge',
    });
  }

  describe('generateSummary', () => {
    it('queries Neo4j for bubbles created/updated since date', async () => {
      (neo4j.query as any)
        .mockResolvedValueOnce([{ id: 'b1', title: 'New Note' }]) // created
        .mockResolvedValueOnce([]); // updated
      (neo4j.queryOne as any)
        .mockResolvedValueOnce({ count: 5 }) // links
        .mockResolvedValueOnce({ count: 3 }) // domains
        .mockResolvedValueOnce({ count: 10 }); // tags

      const lifecycle = createMockLifecycle();
      const retro = createRetrospective({ neo4j, eventBus, lifecycle });
      const summary = await retro.generateSummary();

      expect(summary.bubblesCreated.count).toBe(1);
      expect(summary.bubblesCreated.titles).toContain('New Note');
      expect(summary.linksCreated).toBe(5);
      expect(summary.domainsChanged).toBe(3);
      expect(summary.tagsReorganized).toBe(10);
    });

    it('accepts custom since date', async () => {
      (neo4j.query as any).mockResolvedValue([]);
      (neo4j.queryOne as any).mockResolvedValue({ count: 0 });

      const lifecycle = createMockLifecycle();
      const retro = createRetrospective({ neo4j, eventBus, lifecycle });
      const since = '2026-03-01T00:00:00.000Z';
      const summary = await retro.generateSummary(since);

      expect(summary.period.since).toBe(since);
    });
  });

  describe('formatSummaryMarkdown', () => {
    it('generates readable markdown with activity and stale sections', () => {
      const lifecycle = createMockLifecycle();
      const retro = createRetrospective({ neo4j, eventBus, lifecycle });

      const summary = {
        period: { since: '2026-03-10T00:00:00.000Z', until: '2026-03-17T00:00:00.000Z' },
        bubblesCreated: { count: 3, titles: ['Note A', 'Note B', 'Note C'] },
        bubblesUpdated: { count: 1, titles: ['Updated Note'] },
        linksCreated: 5,
        domainsChanged: 2,
        tagsReorganized: 8,
        staleBubbles: [
          {
            id: 's1',
            title: 'Stale Note',
            permanence: 'normal' as const,
            lastAccessedAt: '2026-01-01T00:00:00.000Z',
            daysSinceAccess: 75,
            reason: 'normal-stale' as const,
            tags: ['old'],
            domains: [],
          },
        ],
        temporaryBubbles: [],
      };

      const md = retro.formatSummaryMarkdown(summary);

      expect(md).toContain('Knowledge Retrospective');
      expect(md).toContain('**3** new bubbles added');
      expect(md).toContain('Note A');
      expect(md).toContain('Stale Note');
      expect(md).toContain('75 days since last access');
    });

    it('shows health message when no stale bubbles', () => {
      const lifecycle = createMockLifecycle();
      const retro = createRetrospective({ neo4j, eventBus, lifecycle });

      const summary = {
        period: { since: '2026-03-10T00:00:00.000Z', until: '2026-03-17T00:00:00.000Z' },
        bubblesCreated: { count: 0, titles: [] },
        bubblesUpdated: { count: 0, titles: [] },
        linksCreated: 0,
        domainsChanged: 0,
        tagsReorganized: 0,
        staleBubbles: [],
        temporaryBubbles: [],
      };

      const md = retro.formatSummaryMarkdown(summary);
      expect(md).toContain('fresh and actively used');
    });
  });

  describe('runFullRetrospective', () => {
    it('emits notification and retrospective:complete events', async () => {
      (neo4j.query as any).mockResolvedValue([]);
      (neo4j.queryOne as any).mockResolvedValue({ count: 0 });

      const lifecycle = createMockLifecycle();
      const retro = createRetrospective({ neo4j, eventBus, lifecycle });
      await retro.runFullRetrospective();

      const notificationEvent = emittedEvents.find((e) => e.type === 'notification');
      expect(notificationEvent).toBeDefined();
      expect((notificationEvent as any).payload.title).toContain('Retrospective');
      expect((notificationEvent as any).payload.channel).toBe('all');

      const completeEvent = emittedEvents.find(
        (e) => e.type === 'knowledge:retrospective:complete',
      );
      expect(completeEvent).toBeDefined();
    });

    it('emits stale:detected event when stale bubbles found', async () => {
      const oldDate = new Date(Date.now() - 35 * 86_400_000).toISOString();
      // First mock for retro's own queries, then the lifecycle's detect call will use its own neo4j mock
      (neo4j.query as any).mockResolvedValue([]);
      (neo4j.queryOne as any).mockResolvedValue({ count: 0 });

      // Create lifecycle with its own neo4j that returns stale bubbles
      const lifecycleNeo4j = createMockNeo4j();
      (lifecycleNeo4j.query as any).mockResolvedValue([
        {
          id: 'stale-1',
          title: 'Old',
          permanence: 'normal',
          lastAccessedAt: oldDate,
          tags: [],
          domains: [],
        },
      ]);
      const lifecycle = createKnowledgeLifecycle({
        neo4j: lifecycleNeo4j,
        knowledgeStore: createMockKnowledgeStore(),
        eventBus,
        embeddingEngine: createMockEmbeddingEngine(),
        chunkingEngine: createMockChunkingEngine(),
        knowledgeDir: '/tmp/knowledge',
      });

      const retro = createRetrospective({ neo4j, eventBus, lifecycle });
      await retro.runFullRetrospective();

      const staleEvent = emittedEvents.find((e) => e.type === 'knowledge:stale:detected');
      expect(staleEvent).toBeDefined();
      expect((staleEvent as any).payload.count).toBe(1);
      expect((staleEvent as any).payload.staleBubbleIds).toContain('stale-1');
    });
  });
});

describe('Scheduled retrospective trigger', () => {
  it('orchestrator handles knowledge:retrospective task type inline', async () => {
    // Import the Orchestrator to test the schedule handler
    const { Orchestrator } = await import('../orchestrator/orchestrator.ts');
    const { SessionManager } = await import('../session-manager/session-manager.ts');
    const { SuiteRegistry } = await import('../suite-registry/suite-registry.ts');
    const { initDatabase } = await import('../db/database.ts');
    const { createMessageStore } = await import('../session-manager/message-store.ts');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const tmpDir = mkdtempSync(join(tmpdir(), 'retro-test-'));
    try {
      initDatabase(join(tmpDir, 'test.db'));

      const eventBus = new EventBus();
      const suiteRegistry = new SuiteRegistry();
      const sessionManager = new SessionManager();
      const messageStore = createMessageStore({ basePath: tmpDir });
      const runSpy = vi.fn().mockResolvedValue({
        period: { since: '', until: '' },
        bubblesCreated: { count: 0, titles: [] },
        bubblesUpdated: { count: 0, titles: [] },
        linksCreated: 0,
        domainsChanged: 0,
        tagsReorganized: 0,
        staleBubbles: [],
        temporaryBubbles: [],
      });

      const mockRetrospective = {
        generateSummary: vi.fn(),
        formatSummaryMarkdown: vi.fn(),
        runFullRetrospective: runSpy,
      };

      new Orchestrator({
        eventBus,
        suiteRegistry,
        sessionManager,
        messageStore,
        retrospective: mockRetrospective,
        port: 4999,
      });

      // Emit schedule event for knowledge:retrospective
      eventBus.emit({
        id: 'test-evt',
        timestamp: Date.now(),
        source: 'scheduler',
        type: 'schedule:triggered',
        payload: {
          scheduleId: 'knowledge-retrospective',
          scheduleName: 'Weekly Knowledge Retrospective',
          taskType: 'knowledge:retrospective',
        },
      } as any);

      // Wait for async handler
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(runSpy).toHaveBeenCalledOnce();
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });
});

describe('API endpoint schemas', () => {
  it('SnoozeSchema validates days', async () => {
    const { SnoozeSchema } = await import('@raven/shared');
    expect(SnoozeSchema.safeParse({ days: 14 }).success).toBe(true);
    expect(SnoozeSchema.safeParse({ days: 0 }).success).toBe(false);
    expect(SnoozeSchema.safeParse({ days: 366 }).success).toBe(false);
    expect(SnoozeSchema.safeParse({ days: 'abc' }).success).toBe(false);
  });

  it('MergeBubblesSchema validates bubble IDs', async () => {
    const { MergeBubblesSchema } = await import('@raven/shared');
    const uuid1 = '550e8400-e29b-41d4-a716-446655440000';
    const uuid2 = '550e8400-e29b-41d4-a716-446655440001';
    expect(MergeBubblesSchema.safeParse({ bubbleIds: [uuid1, uuid2] }).success).toBe(true);
    expect(MergeBubblesSchema.safeParse({ bubbleIds: [uuid1] }).success).toBe(false); // min 2
    expect(MergeBubblesSchema.safeParse({ bubbleIds: [] }).success).toBe(false);
  });
});
