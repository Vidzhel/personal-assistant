import { createHubEngine } from '../knowledge-engine/hub-ops.ts';
import type { LinkEngine } from '../knowledge-engine/link-ops.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../event-bus/event-bus.ts';
import { createIngestionProcessor } from '../knowledge-engine/ingestion.ts';
import { createEmbeddingEngine, resetPipeline } from '../knowledge-engine/embeddings.ts';
import { createChunkingEngine } from '../knowledge-engine/chunking.ts';
import { createClusteringEngine } from '../knowledge-engine/clustering.ts';
import { createKnowledgeLifecycle } from '../knowledge-engine/knowledge-lifecycle.ts';
import {
  deferred,
  fakeGraph,
  fakeKnowledgeStore,
  fakeExecutionLogger,
} from './fixtures/knowledge-fixture.ts';
import type { RavenEvent, AgentTaskRequestEvent } from '@raven/shared';

const model = vi.hoisted(() => {
  const embed = vi.fn(async () => ({ data: new Float32Array([1, 0]) }));
  return { embed, load: vi.fn(async () => embed) };
});
vi.mock('@huggingface/transformers', () => ({ pipeline: () => model.load() }));

function event(type: RavenEvent['type'], payload: unknown): RavenEvent {
  return { id: 'event', timestamp: 1, source: 'test', type, payload } as RavenEvent;
}

function fixture() {
  const eventBus = new EventBus();
  const neo4j = fakeGraph();
  const knowledgeStore = fakeKnowledgeStore();
  const embeddingEngine = createEmbeddingEngine({ eventBus, neo4j, knowledgeStore });
  const chunkingEngine = createChunkingEngine({
    eventBus,
    neo4j,
    knowledgeStore,
    knowledgeDir: '/tmp/unused-knowledge-fixture',
  });
  const ingestion = createIngestionProcessor({
    eventBus,
    knowledgeStore,
    mediaDir: '/tmp/unused-knowledge-fixture',
    executionLogger: fakeExecutionLogger(),
  });
  const lifecycle = createKnowledgeLifecycle({
    eventBus,
    neo4j,
    knowledgeStore,
    embeddingEngine,
    chunkingEngine,
    knowledgeDir: '/tmp/unused-knowledge-fixture',
  });
  return { eventBus, neo4j, knowledgeStore, embeddingEngine, chunkingEngine, ingestion, lifecycle };
}

describe('knowledge processor disposal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetPipeline();
    model.load.mockReset().mockResolvedValue(model.embed);
    model.embed.mockReset().mockResolvedValue({ data: new Float32Array([1, 0]) });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('ingestion observes synchronous completion and removes its completion timer', async () => {
    const f = fixture();
    f.ingestion.start();
    f.ingestion.start();
    f.eventBus.on<AgentTaskRequestEvent>('agent:task:request', (request) => {
      f.eventBus.emit(
        event('agent:task:complete', {
          taskId: request.payload.taskId,
          success: true,
          result: '{"title":"Synchronous","tags":[]}',
        }),
      );
    });
    await f.ingestion.ingest({ type: 'text', content: 'Test' });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.knowledgeStore.insert).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await f.ingestion.stop();
    await f.ingestion.stop();
    expect(f.eventBus.listenerCount()).toBe(1); // The test-owned backend only.
  });

  it.each(['stop', 'timeout', 'dispatch-error'])(
    'cleans ingestion waits on %s without a late save',
    async (reason) => {
      const f = fixture();
      const requests: AgentTaskRequestEvent[] = [];
      f.eventBus.on<AgentTaskRequestEvent>('agent:task:request', (request) => {
        requests.push(request);
        if (reason === 'dispatch-error') throw new Error('dispatch refused');
      });
      f.ingestion.start();
      await f.ingestion.ingest({ type: 'text', content: 'Test' });
      if (reason === 'timeout') await vi.advanceTimersByTimeAsync(120_000);
      await f.ingestion.stop();
      expect(vi.getTimerCount()).toBe(0);
      expect(f.eventBus.listenerCount()).toBe(1);
      f.eventBus.emit(
        event('agent:task:complete', {
          taskId: requests[0].payload.taskId,
          success: true,
          result: '{"title":"Late","tags":[]}',
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(f.knowledgeStore.insert).not.toHaveBeenCalled();
      await expect(f.ingestion.ingest({ type: 'text', content: 'late' })).rejects.toThrow(
        'stopped',
      );
    },
  );

  it('aborts an in-progress URL extraction and clears its timer on stop', async () => {
    const f = fixture();
    let fetchSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            fetchSignal = init.signal as AbortSignal;
            fetchSignal.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          }),
      ),
    );
    const request = f.ingestion.ingest({ type: 'url', url: 'https://fake.invalid/input' });
    const rejection = expect(request).rejects.toThrow('stopped');
    await f.ingestion.stop();
    await rejection;
    expect(fetchSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.knowledgeStore.insert).not.toHaveBeenCalled();
  });

  it('cancels merge synthesis locally without using the content fallback to mutate', async () => {
    const f = fixture();
    const requests: AgentTaskRequestEvent[] = [];
    f.eventBus.on<AgentTaskRequestEvent>('agent:task:request', (request) => {
      requests.push(request);
    });
    const merge = f.lifecycle.mergeBubbles(['one', 'two']);
    const rejection = expect(merge).rejects.toThrow('stopped');
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
    await f.lifecycle.stop();
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
    expect(f.eventBus.listenerCount()).toBe(1);
    expect(f.knowledgeStore.insert).not.toHaveBeenCalled();
    expect(f.neo4j.run).not.toHaveBeenCalled();
  });

  it('successful merge synthesis clears its timeout immediately', async () => {
    const f = fixture();
    vi.spyOn(f.embeddingEngine, 'generateAndStore').mockResolvedValue();
    vi.spyOn(f.chunkingEngine, 'indexBubble').mockResolvedValue();
    f.eventBus.on<AgentTaskRequestEvent>('agent:task:request', (request) => {
      f.eventBus.emit(
        event('agent:task:complete', {
          taskId: request.payload.taskId,
          success: true,
          result: 'Merged result',
        }),
      );
    });
    await f.lifecycle.mergeBubbles(['one', 'two']);
    expect(f.knowledgeStore.insert).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Merged result' }),
    );
    expect(vi.getTimerCount()).toBe(0);
    await f.lifecycle.stop();
  });

  it.each(['embedding', 'chunking'])(
    'stops %s with a held model call and ignores its late output',
    async (kind) => {
      const f = fixture();
      const held = deferred<{ data: Float32Array<ArrayBuffer> }>();
      model.embed.mockReturnValueOnce(held.promise);
      const processor = kind === 'embedding' ? f.embeddingEngine : f.chunkingEngine;
      processor.start();
      const events: RavenEvent[] = [];
      f.eventBus.on('*', (emitted) => {
        events.push(emitted);
      });
      f.eventBus.emit(
        kind === 'embedding'
          ? event('knowledge:bubble:created', { bubbleId: 'one', title: 'One' })
          : event('knowledge:embedding:generated', { bubbleId: 'one' }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(model.embed).toHaveBeenCalledTimes(1);
      const stopping = processor.stop();
      await vi.advanceTimersByTimeAsync(1_000);
      await stopping;
      const calls = vi.mocked(f.neo4j.run).mock.calls.length;
      const emitted = events.length;
      held.resolve({ data: new Float32Array([1, 0]) });
      await vi.advanceTimersByTimeAsync(0);
      expect(f.neo4j.run).toHaveBeenCalledTimes(calls);
      expect(events).toHaveLength(emitted);
      expect(f.eventBus.listenerCount()).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('removes both nested clustering completion handlers and ignores retained callbacks', async () => {
    const f = fixture();
    const on = vi.spyOn(f.eventBus, 'on');
    const clustering = createClusteringEngine({ ...f, domainConfig: [] });
    await clustering.start();
    await clustering.start();
    expect(f.eventBus.listenerCount()).toBe(3);
    const callbacks = on.mock.calls.map((call) => call[1]);
    await clustering.stop();
    await clustering.stop();
    expect(f.eventBus.listenerCount()).toBe(0);
    for (const callback of callbacks)
      callback(event('agent:task:complete', { taskId: 'late', success: true, result: '{}' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.neo4j.run).not.toHaveBeenCalled();
    expect(f.knowledgeStore.update).not.toHaveBeenCalled();
  });
  it('refuses cluster writes after a held embedding lookup settles past disposal', async () => {
    const f = fixture();
    const held = deferred<Array<{ bubbleId: string; embedding: Float32Array }>>();
    vi.spyOn(f.embeddingEngine, 'getAllEmbeddings').mockReturnValueOnce(held.promise);
    const clustering = createClusteringEngine({ ...f, domainConfig: [] });
    await clustering.start();
    const pending = clustering.runClustering();
    const rejection = expect(pending).rejects.toThrow('stopped');
    const stopping = clustering.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    await stopping;
    held.resolve(
      ['one', 'two'].map((bubbleId) => ({ bubbleId, embedding: new Float32Array([1, 0]) })),
    );
    await rejection;
    expect(f.neo4j.run).not.toHaveBeenCalled();
    expect(f.eventBus.listenerCount()).toBe(0);
  });

  it('discards a real pending cluster label when stopped', async () => {
    const f = fixture();
    vi.spyOn(f.embeddingEngine, 'getAllEmbeddings').mockResolvedValue(
      ['one', 'two'].map((bubbleId) => ({ bubbleId, embedding: new Float32Array([1, 0]) })),
    );
    const clustering = createClusteringEngine({ ...f, domainConfig: [] });
    const requests: AgentTaskRequestEvent[] = [];
    f.eventBus.on<AgentTaskRequestEvent>('agent:task:request', (request) => {
      requests.push(request);
    });
    await clustering.start();
    await clustering.runClustering();
    expect(requests).toHaveLength(1);
    await clustering.stop();
    const calls = vi.mocked(f.neo4j.run).mock.calls.length;
    f.eventBus.emit(
      event('agent:task:complete', {
        taskId: requests[0].payload.taskId,
        success: true,
        result: '{"label":"Late label"}',
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(f.neo4j.run).toHaveBeenCalledTimes(calls);
  });

  it.each(['placeholder', 'link'])(
    'prevents hub continuation after a held %s write',
    async (stage) => {
      const f = fixture();
      const links = Array.from({ length: 10 }, (_, i) => ({
        id: `link-${i}`,
        sourceBubbleId: 'hub',
        targetBubbleId: `member-${i}`,
        relationshipType: 'related',
        confidence: 1,
        autoSuggested: false,
        status: 'accepted',
        createdAt: '2026-01-01',
      }));
      const linkEngine = {
        getLinksForBubble: vi.fn(async () => links),
        createLinkInternal: vi.fn(async () => links[0]),
      } as unknown as LinkEngine;
      vi.spyOn(f.embeddingEngine, 'getEmbedding').mockResolvedValue(new Float32Array([1, 0]));
      const saved = await f.knowledgeStore.insert({ title: 'test', content: 'test', tags: [] });
      const heldInsert = deferred<typeof saved>();
      const heldLink = deferred<Awaited<ReturnType<LinkEngine['createLinkInternal']>>>();
      if (stage === 'placeholder')
        vi.mocked(f.knowledgeStore.insert).mockReturnValueOnce(heldInsert.promise);
      else vi.mocked(linkEngine.createLinkInternal).mockReturnValueOnce(heldLink.promise);
      const hub = createHubEngine({ ...f, linkEngine });
      hub.start();
      const emitted: RavenEvent[] = [];
      f.eventBus.on('*', (output) => {
        emitted.push(output);
      });
      const pending = hub.splitHub('hub');
      const rejection = expect(pending).rejects.toThrow('stopped');
      await vi.advanceTimersByTimeAsync(0);
      const stopping = hub.stop();
      await vi.advanceTimersByTimeAsync(1_000);
      await stopping;
      const calls = vi.mocked(linkEngine.createLinkInternal).mock.calls.length;
      const events = emitted.length;
      if (stage === 'placeholder') heldInsert.resolve(saved);
      else heldLink.resolve(links[0]);
      await rejection;
      expect(linkEngine.createLinkInternal).toHaveBeenCalledTimes(calls);
      expect(emitted).toHaveLength(events);
      expect(f.neo4j.run).not.toHaveBeenCalled();
    },
  );
  it('suppresses the nested merge notification after a held final write settles', async () => {
    const f = fixture();
    const clustering = createClusteringEngine({ ...f, domainConfig: [] });
    await clustering.start();
    vi.mocked(f.neo4j.query).mockResolvedValueOnce([{ bubbleId: 'one' }]);
    vi.spyOn(f.embeddingEngine, 'getEmbedding').mockResolvedValue(new Float32Array([1, 0]));
    vi.spyOn(f.embeddingEngine, 'findSimilar').mockResolvedValue([
      { bubbleId: 'two', similarity: 0.95 },
    ]);
    const held = deferred<Awaited<ReturnType<typeof f.neo4j.run>>>();
    const result = await f.neo4j.run('fixture result');
    vi.mocked(f.neo4j.run).mockReturnValueOnce(held.promise);
    const emitted: RavenEvent[] = [];
    f.eventBus.on('*', (output) => {
      emitted.push(output);
    });
    const pending = clustering.detectMerges();
    const rejection = expect(pending).rejects.toThrow('stopped');
    await vi.advanceTimersByTimeAsync(0);
    const stopping = clustering.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    await stopping;
    held.resolve(result);
    await rejection;
    expect(emitted).toHaveLength(0);
  });
  it.each(['embedding', 'chunking'])(
    'does not start %s inference after deferred model initialization',
    async (kind) => {
      const f = fixture();
      const held = deferred<typeof model.embed>();
      model.load.mockReturnValueOnce(held.promise);
      const processor = kind === 'embedding' ? f.embeddingEngine : f.chunkingEngine;
      processor.start();
      f.eventBus.emit(
        kind === 'embedding'
          ? event('knowledge:bubble:created', { bubbleId: 'one', title: 'One' })
          : event('knowledge:embedding:generated', { bubbleId: 'one' }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(model.load).toHaveBeenCalledTimes(1);
      const stopping = processor.stop();
      await vi.advanceTimersByTimeAsync(1_000);
      await stopping;
      const calls = vi.mocked(f.neo4j.run).mock.calls.length;
      held.resolve(model.embed);
      await vi.advanceTimersByTimeAsync(0);
      expect(model.embed).not.toHaveBeenCalled();
      expect(f.neo4j.run).toHaveBeenCalledTimes(calls);
    },
  );
});
