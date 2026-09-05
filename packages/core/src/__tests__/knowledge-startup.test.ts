import { deferred } from './fixtures/knowledge-fixture.ts';
import type { ManagedTransaction } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../event-bus/event-bus.ts';
import { initializeKnowledge } from '../knowledge-engine/initialize-knowledge.ts';
import { createIngestionProcessor } from '../knowledge-engine/ingestion.ts';
import { createEmbeddingEngine } from '../knowledge-engine/embeddings.ts';
import { createClusteringEngine } from '../knowledge-engine/clustering.ts';
import { createChunkingEngine } from '../knowledge-engine/chunking.ts';
import { buildTestConfig } from './fixtures/raven-fixture.ts';
import { fakeGraph, fakeKnowledgeStore } from './fixtures/knowledge-fixture.ts';

describe('transactional knowledge startup', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'raven-graph-startup-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function fixture() {
    const eventBus = new EventBus();
    const client = fakeGraph();
    const store = fakeKnowledgeStore();
    return {
      client,
      store,
      eventBus,
      deps: {
        config: { ...buildTestConfig(), NEO4J_ENABLED: true },
        eventBus,
        knowledgeDir: root,
        mediaDir: root,
        configDir: root,
      },
      factories: {
        createNeo4jClient: vi.fn(() => client),
        createKnowledgeStore: () => store,
        syncProjectNodes: vi.fn(async () => {}),
        loadKnowledgeDomainConfig: () => [],
      },
    };
  }

  it('disabled mode does not construct a driver or processor', async () => {
    const f = fixture();
    f.deps.config.NEO4J_ENABLED = false;
    expect(await initializeKnowledge(f.deps, f.factories)).toBeUndefined();
    expect(f.factories.createNeo4jClient).not.toHaveBeenCalled();
    expect(f.eventBus.listenerCount()).toBe(0);
  });

  it.each([
    'schema',
    'project-sync',
    'reindex',
    'ingestion',
    'embedding',
    'clustering',
    'chunking',
    'retrieval',
    'lifecycle',
    'retrospective',
    'consolidation',
  ])('cleans all real processor listeners when %s fails', async (stage) => {
    const f = fixture();
    const fail = (): never => {
      throw new Error(`Injected ${stage} failure`);
    };
    const overrides: NonNullable<Parameters<typeof initializeKnowledge>[1]> = { ...f.factories };
    if (stage === 'schema') vi.mocked(f.client.ensureSchema).mockImplementation(fail);
    if (stage === 'project-sync') overrides.syncProjectNodes = fail;
    if (stage === 'reindex') vi.mocked(f.store.reindexAll).mockImplementation(fail);
    if (stage === 'ingestion')
      overrides.createIngestionProcessor = (deps) => {
        const processor = createIngestionProcessor(deps);
        return {
          ...processor,
          start: () => {
            processor.start();
            fail();
          },
        };
      };
    if (stage === 'embedding')
      overrides.createEmbeddingEngine = (deps) => {
        const processor = createEmbeddingEngine(deps);
        return {
          ...processor,
          start: () => {
            processor.start();
            fail();
          },
        };
      };
    if (stage === 'clustering')
      overrides.createClusteringEngine = (deps) => {
        // Failure during domain root setup occurs after both nested response subscriptions.
        vi.mocked(f.client.run).mockImplementation(fail);
        return createClusteringEngine({
          ...deps,
          domainConfig: [{ name: 'test', description: '', rules: { tags: [], keywords: [] } }],
        });
      };
    if (stage === 'chunking')
      overrides.createChunkingEngine = (deps) => {
        const processor = createChunkingEngine(deps);
        return {
          ...processor,
          start: () => {
            processor.start();
            fail();
          },
        };
      };
    if (stage === 'retrieval') overrides.createRetrievalEngine = fail;
    if (stage === 'lifecycle') overrides.createKnowledgeLifecycle = fail;
    if (stage === 'retrospective') overrides.createRetrospective = fail;
    if (stage === 'consolidation') overrides.createKnowledgeConsolidation = fail;
    expect(await initializeKnowledge(f.deps, overrides)).toBeUndefined();
    expect(f.eventBus.listenerCount()).toBe(0);
    expect(f.client.close).toHaveBeenCalledTimes(1);
  });

  it('keeps diagnostics available for invalid files and refreshes only after processors start', async () => {
    const f = fixture();
    vi.mocked(f.store.reindexAll).mockResolvedValue({
      indexed: 1,
      errors: ['duplicate file'],
      changedIds: ['valid'],
    });
    const order: string[] = [];
    const refreshBubble = vi.fn(async (): Promise<void> => {
      expect(order).toEqual(['embedding', 'chunking']);
      throw new Error('temporarily unavailable');
    });
    const indexBubble = vi.fn(async () => {});
    const runtime = await initializeKnowledge(f.deps, {
      ...f.factories,
      createEmbeddingEngine: (deps) => ({
        ...createEmbeddingEngine(deps),
        start: () => {
          order.push('embedding');
        },
        refreshBubble,
      }),
      createChunkingEngine: (deps) => ({
        ...createChunkingEngine(deps),
        start: () => {
          order.push('chunking');
        },
        indexBubble,
      }),
    });
    expect(runtime).toBeDefined();
    expect(f.client.close).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(indexBubble).toHaveBeenCalledWith('valid'));
    await runtime!.reindex();
    refreshBubble.mockResolvedValue(undefined);
    const repaired = await runtime!.reindex();
    expect(repaired.refreshedIds).toEqual(['valid']);
    await runtime!.stop();
  });

  it('shares an ongoing reindex between API and maintenance callers', async () => {
    const f = fixture();
    const runtime = await initializeKnowledge(f.deps, f.factories);
    await runtime!.reindex();
    vi.mocked(f.store.reindexAll).mockClear();
    const held = deferred<{ indexed: number; errors: string[]; changedIds: string[] }>();
    vi.mocked(f.store.reindexAll).mockReturnValueOnce(held.promise);
    const first = runtime!.reindex();
    const second = runtime!.reindex();
    expect(first).toBe(second);
    expect(f.store.reindexAll).toHaveBeenCalledTimes(1);
    held.resolve({ indexed: 0, errors: [], changedIds: [] });
    await first;
    await runtime!.reindex();
    expect(f.store.reindexAll).toHaveBeenCalledTimes(2);
    await runtime!.stop();
  });

  it('publishes diagnostics while startup embedding generation is still pending', async () => {
    const f = fixture();
    const held = deferred<undefined>();
    vi.mocked(f.store.reindexAll).mockResolvedValue({ indexed: 1, errors: [], changedIds: ['a'] });
    const refreshBubble = vi.fn(() => held.promise);
    const runtime = await initializeKnowledge(f.deps, {
      ...f.factories,
      createEmbeddingEngine: (deps) => ({ ...createEmbeddingEngine(deps), refreshBubble }),
      createChunkingEngine: (deps) => ({
        ...createChunkingEngine(deps),
        indexBubble: vi.fn(async () => {}),
      }),
    });
    expect(runtime).toBeDefined();
    expect(refreshBubble).toHaveBeenCalledWith('a');
    expect(f.client.close).not.toHaveBeenCalled();
    held.resolve(undefined);
    await runtime!.reindex();
    await runtime!.stop();
  });

  it('continues cleanup after a processor stop rejects', async () => {
    const f = fixture();
    const initialized = await initializeKnowledge(f.deps, {
      ...f.factories,
      createIngestionProcessor: (deps) => {
        const processor = createIngestionProcessor(deps);
        return {
          ...processor,
          stop: async () => {
            await processor.stop();
            throw new Error('stop failed');
          },
        };
      },
    });
    expect(initialized).toBeDefined();
    expect(f.eventBus.listenerCount()).toBe(6);
    await initialized?.stop();
    await initialized?.stop();
    expect(f.eventBus.listenerCount()).toBe(0);
    expect(f.client.close).toHaveBeenCalledTimes(1);
    expect(() => initialized?.neo4jClient.run('RETURN 1')).toThrow(/stopped/);
    expect(() =>
      initialized?.knowledgeStore.insert({ title: 'late', content: 'late', tags: [] }),
    ).toThrow(/stopped/);
  });
  it('blocks a store transaction continuation after graph disposal', async () => {
    const f = fixture();
    const held = deferred<undefined>();
    const tx = { run: vi.fn(async () => ({ records: [] })) } as unknown as ManagedTransaction;
    vi.mocked(f.client.withTransaction).mockImplementation(async (operation) => operation(tx));
    const initialized = await initializeKnowledge(f.deps, {
      ...f.factories,
      createKnowledgeStore: (deps) => ({
        ...f.store,
        insert: async (input) => {
          await deps.neo4j.withTransaction(async (transaction) => {
            await held.promise;
            await transaction.run('RETURN 1');
          });
          return f.store.insert(input);
        },
      }),
    });
    const pending = initialized!.knowledgeStore.insert({
      title: 'test',
      content: 'test',
      tags: [],
    });
    const rejection = expect(pending).rejects.toThrow('stopped');
    await initialized!.stop();
    held.resolve(undefined);
    await rejection;
    expect(tx.run).not.toHaveBeenCalled();
    expect(f.store.insert).not.toHaveBeenCalled();
  });
});
