import { describe, expect, it, vi } from 'vitest';
import type { QueryResult } from 'neo4j-driver';
import type { KnowledgeStore } from '../knowledge-engine/knowledge-store.ts';
import type { Neo4jClient } from '../knowledge-engine/neo4j-client.ts';
import type { LinkEngine } from '../knowledge-engine/link-ops.ts';
import type { EmbeddingEngine } from '../knowledge-engine/embeddings.ts';
import { EventBus } from '../event-bus/event-bus.ts';
import { createHubEngine } from '../knowledge-engine/hub-ops.ts';
import { createClusteringOps } from '../knowledge-engine/clustering-ops.ts';
import type { AgentTaskRequestEvent, RavenEvent } from '@raven/shared';

const emptyResult = (): QueryResult => ({ records: [] }) as unknown as QueryResult;

function bubble(id: string) {
  return {
    id,
    title: `Title ${id}`,
    content: `Canonical content ${id}`,
    filePath: `${id}.md`,
    source: null,
    sourceFile: null,
    sourceUrl: null,
    tags: ['tag'],
    domains: [],
    permanence: 'normal' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastAccessedAt: null,
  };
}

function fixture() {
  const eventBus = new EventBus();
  const tx = { run: vi.fn(async () => emptyResult()) };
  const neo4j = {
    run: vi.fn(async () => emptyResult()),
    query: vi.fn(async () => []),
    queryOne: vi.fn(async () => undefined),
    withTransaction: vi.fn(async (operation: (value: typeof tx) => Promise<unknown>) =>
      operation(tx),
    ),
    ensureSchema: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  } as unknown as Neo4jClient;
  const knowledgeStore = {
    getById: vi.fn(async (id: string) => bubble(id)),
    insert: vi.fn(async (input: { title: string; content: string; tags: string[] }) => ({
      ...bubble('synthesis'),
      id: 'synthesis',
      title: input.title,
      content: input.content,
      tags: input.tags,
    })),
    remove: vi.fn(async () => true),
  } as unknown as KnowledgeStore;
  const embeddingEngine = {
    getEmbedding: vi.fn(async () => new Float32Array([1, 0])),
    getAllEmbeddings: vi.fn(async () =>
      ['one', 'two', 'three'].map((bubbleId) => ({
        bubbleId,
        embedding: new Float32Array([1, 0]),
      })),
    ),
  } as unknown as EmbeddingEngine;
  const linkEngine = {
    getLinksForBubble: vi.fn(async () =>
      Array.from({ length: 10 }, (_, index) => ({
        id: `link-${index}`,
        sourceBubbleId: 'hub',
        targetBubbleId: `member-${index}`,
        relationshipType: 'related',
        confidence: 1,
        autoSuggested: false,
        status: 'accepted',
        createdAt: '2026-01-01T00:00:00.000Z',
      })),
    ),
  } as unknown as LinkEngine;
  return { eventBus, neo4j, tx, knowledgeStore, embeddingEngine, linkEngine };
}

function respondWith(eventBus: EventBus, response: string, success = true): void {
  eventBus.on('agent:task:request', (event: RavenEvent) => {
    const taskId = (event as AgentTaskRequestEvent).payload.taskId;
    eventBus.emit({
      id: 'complete',
      timestamp: Date.now(),
      source: 'test',
      type: 'agent:task:complete',
      payload: {
        taskId,
        result: response,
        success,
        durationMs: 1,
        ...(success ? {} : { errors: ['model failed'] }),
      },
    } as RavenEvent);
  });
}

function makeWideHub(f: ReturnType<typeof fixture>): void {
  vi.mocked(f.linkEngine.getLinksForBubble).mockResolvedValue(
    Array.from({ length: 12 }, (_, index) => ({
      id: `link-${index}`,
      sourceBubbleId: 'hub',
      targetBubbleId: `member-${index}`,
      relationshipType: 'related',
      confidence: 1,
      autoSuggested: false,
      status: 'accepted' as const,
      createdAt: '2026-01-01T00:00:00.000Z',
    })),
  );
  vi.mocked(f.embeddingEngine.getEmbedding).mockImplementation(async (id: string) => {
    const index = Number(id.replace('member-', ''));
    return new Float32Array(index < 6 ? [1, 0] : [-1, 0]);
  });
}

describe('knowledge structural operations', () => {
  it('returns a no-op without dispatching or mutating a small hub', async () => {
    const f = fixture();
    vi.mocked(f.linkEngine.getLinksForBubble).mockResolvedValueOnce([]);
    const request = vi.fn();
    f.eventBus.on('agent:task:request', request);
    const hub = createHubEngine({ ...f });

    await expect(hub.splitHub('hub')).resolves.toEqual({
      hubBubbleId: 'hub',
      createdIds: [],
      status: 'noop',
    });
    expect(request).not.toHaveBeenCalled();
    expect(f.knowledgeStore.insert).not.toHaveBeenCalled();
  });

  it('validates every hub synthesis before inserting and uses canonical content', async () => {
    const f = fixture();
    const emit = vi.spyOn(f.eventBus, 'emit');
    respondWith(f.eventBus, '{"title":"Merged","summary":"Combined"}');
    const hub = createHubEngine({ ...f });

    const result = await hub.splitHub('hub');
    expect(result).toMatchObject({ hubBubbleId: 'hub', status: 'completed' });
    expect(result.createdIds).toEqual(['synthesis']);
    const request = emit.mock.calls.find(([event]) => event.type === 'agent:task:request');
    expect(request?.[0]).toMatchObject({
      payload: { prompt: expect.stringContaining('Canonical content member-0') },
    });
    expect(f.knowledgeStore.insert).toHaveBeenCalledOnce();
    expect(f.tx.run).toHaveBeenCalled();
    const rewires = (f.tx.run.mock.calls as unknown[][]).map((call) => String(call[0]));
    expect(
      rewires.filter((query) => query.includes('SET replacement = properties(old)')),
    ).toHaveLength(2);
    expect(rewires.some((query) => query.includes("status: 'dismissed'"))).toBe(false);
  });

  it('does not write a hub when model synthesis fails or is malformed', async () => {
    const failed = fixture();
    respondWith(failed.eventBus, '', false);
    const failedHub = createHubEngine({ ...failed });
    await expect(failedHub.splitHub('hub')).rejects.toThrow('model failed');
    expect(failed.knowledgeStore.insert).not.toHaveBeenCalled();

    const malformed = fixture();
    respondWith(malformed.eventBus, '{"title":"missing summary"}');
    const malformedHub = createHubEngine({ ...malformed });
    await expect(malformedHub.splitHub('hub')).rejects.toThrow('Invalid synthesis response');
    expect(malformed.knowledgeStore.insert).not.toHaveBeenCalled();
  });

  it('retains a created bubble when a rewire transaction fails', async () => {
    const f = fixture();
    respondWith(f.eventBus, '{"title":"Merged","summary":"Combined"}');
    vi.mocked(f.neo4j.withTransaction).mockRejectedValueOnce(new Error('transaction failed'));
    const hub = createHubEngine({ ...f });

    await expect(hub.splitHub('hub')).rejects.toThrow(/synthesis bubble synthesis.*Reconcile/);
    expect(f.neo4j.run).not.toHaveBeenCalled();
    expect(f.knowledgeStore.remove).not.toHaveBeenCalled();
  });

  it('validates every hub model result before any synthesis bubble is inserted', async () => {
    const f = fixture();
    makeWideHub(f);
    let calls = 0;
    f.eventBus.on('agent:task:request', (event: RavenEvent) => {
      calls += 1;
      const taskId = (event as AgentTaskRequestEvent).payload.taskId;
      f.eventBus.emit({
        id: `complete-${calls}`,
        timestamp: Date.now(),
        source: 'test',
        type: 'agent:task:complete',
        payload: {
          taskId,
          result: calls === 1 ? '{"title":"ok","summary":"ok"}' : '',
          success: calls === 1,
          durationMs: 1,
          ...(calls === 1 ? {} : { errors: ['second model failed'] }),
        },
      } as RavenEvent);
    });
    const hub = createHubEngine({ ...f });

    await expect(hub.splitHub('hub')).rejects.toThrow('second model failed');
    expect(calls).toBe(2);
    expect(f.knowledgeStore.insert).not.toHaveBeenCalled();
    expect(f.neo4j.withTransaction).not.toHaveBeenCalled();
  });

  it('rejects a source edit made while hub synthesis is awaited', async () => {
    const f = fixture();
    const changed = { value: false };
    vi.mocked(f.knowledgeStore.getById).mockImplementation(async (id: string) => ({
      ...bubble(id),
      content: id === 'member-0' && changed.value ? 'Edited externally' : bubble(id).content,
    }));
    f.eventBus.on('agent:task:request', (event: RavenEvent) => {
      changed.value = true;
      const taskId = (event as AgentTaskRequestEvent).payload.taskId;
      f.eventBus.emit({
        id: 'changed-complete',
        timestamp: Date.now(),
        source: 'test',
        type: 'agent:task:complete',
        payload: { taskId, result: '{"title":"ok","summary":"ok"}', success: true, durationMs: 1 },
      } as RavenEvent);
    });
    const hub = createHubEngine({ ...f });

    await expect(hub.splitHub('hub')).rejects.toThrow('sources changed');
    expect(f.knowledgeStore.insert).not.toHaveBeenCalled();
  });

  it('does not write after stop interrupts an awaited hub model', async () => {
    const f = fixture();
    let requested!: () => void;
    const requestSeen = new Promise<void>((resolve) => {
      requested = resolve;
    });
    f.eventBus.on('agent:task:request', () => requested());
    const hub = createHubEngine({ ...f });
    const split = hub.splitHub('hub');
    await requestSeen;
    await hub.stop();

    await expect(split).rejects.toThrow('stopped');
    expect(f.knowledgeStore.insert).not.toHaveBeenCalled();
  });

  it('stops a held rewire transaction before its callback can continue', async () => {
    const f = fixture();
    respondWith(f.eventBus, '{"title":"Merged","summary":"Combined"}');
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(f.tx.run).mockImplementationOnce(async () => {
      await held;
      return emptyResult();
    });
    const hub = createHubEngine({ ...f });
    const split = hub.splitHub('hub');
    await vi.waitFor(() => expect(f.tx.run).toHaveBeenCalled());
    const stopping = hub.stop();
    release();
    await stopping;

    await expect(split).rejects.toThrow('stopped');
    expect(f.tx.run).toHaveBeenCalledTimes(1);
  });

  it('replaces clusters only after every awaited label is valid', async () => {
    const f = fixture();
    respondWith(f.eventBus, '{"label":"Topics","description":"Related topics"}');
    const clustering = createClusteringOps({ ...f });

    await expect(clustering.runClustering()).resolves.toEqual({
      clusterCount: 1,
      clusteredBubbles: 3,
    });
    expect(f.tx.run).toHaveBeenCalled();
    expect(f.knowledgeStore.getById).toHaveBeenCalledWith('one', { trackAccess: false });
  });

  it('does not replace existing clusters when a label fails', async () => {
    const f = fixture();
    respondWith(f.eventBus, '{"label":"bad"}', false);
    const clustering = createClusteringOps({ ...f });

    await expect(clustering.runClustering()).rejects.toThrow('model failed');
    expect(f.neo4j.withTransaction).not.toHaveBeenCalled();
  });

  it('rejects a clustering source edit before replacing existing clusters', async () => {
    const f = fixture();
    let changed = false;
    vi.mocked(f.knowledgeStore.getById).mockImplementation(async (id: string) => ({
      ...bubble(id),
      content: id === 'one' && changed ? 'Edited externally' : bubble(id).content,
    }));
    f.eventBus.on('agent:task:request', (event: RavenEvent) => {
      changed = true;
      const taskId = (event as AgentTaskRequestEvent).payload.taskId;
      f.eventBus.emit({
        id: 'cluster-changed-complete',
        timestamp: Date.now(),
        source: 'test',
        type: 'agent:task:complete',
        payload: {
          taskId,
          result: '{"label":"Topics","description":"Related topics"}',
          success: true,
          durationMs: 1,
        },
      } as RavenEvent);
    });
    const clustering = createClusteringOps({ ...f });

    await expect(clustering.runClustering()).rejects.toThrow('sources changed');
    expect(f.neo4j.withTransaction).not.toHaveBeenCalled();
  });

  it('clears old clusters during an empty rebuild', async () => {
    const f = fixture();
    vi.mocked(f.embeddingEngine.getAllEmbeddings).mockResolvedValue([]);
    const clustering = createClusteringOps({ ...f });

    await expect(clustering.runClustering()).resolves.toEqual({
      clusterCount: 0,
      clusteredBubbles: 0,
    });
    expect(f.neo4j.withTransaction).toHaveBeenCalledOnce();
    expect(f.tx.run).toHaveBeenCalledWith('MATCH (c:Cluster) DETACH DELETE c');
  });

  it('rolls back an empty cluster replacement when a member disappears in its transaction', async () => {
    const f = fixture();
    const missing = { get: vi.fn(() => ['missing']) };
    vi.mocked(f.tx.run).mockResolvedValueOnce({ records: [missing] } as unknown as QueryResult);
    respondWith(f.eventBus, '{"label":"Topics","description":"Related topics"}');
    const clustering = createClusteringOps({ ...f });

    await expect(clustering.runClustering()).rejects.toThrow('Cluster source disappeared');
    expect(f.tx.run).toHaveBeenCalledTimes(1);
  });
});
