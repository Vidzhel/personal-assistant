import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../event-bus/event-bus.ts';
import { registerKnowledgeRoutes } from '../api/routes/knowledge.ts';
import { reindexKnowledge } from '../knowledge-engine/knowledge-refresh.ts';
import type { EmbeddingEngine } from '../knowledge-engine/embeddings.ts';
import type { ChunkingEngine } from '../knowledge-engine/chunking.ts';
import type { IngestionProcessor } from '../knowledge-engine/ingestion.ts';
import { deferred, fakeExecutionLogger, fakeKnowledgeStore } from './fixtures/knowledge-fixture.ts';

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function fixture() {
  const knowledgeStore = fakeKnowledgeStore();
  vi.mocked(knowledgeStore.reindexAll).mockResolvedValue({
    indexed: 2,
    errors: [],
    changedIds: ['a', 'b'],
  });
  const refreshBubble = vi.fn(async (_id: string) => {});
  const indexBubble = vi.fn(async (_id: string) => {});
  const deps = {
    knowledgeStore,
    embeddingEngine: { refreshBubble } as unknown as EmbeddingEngine,
    chunkingEngine: { indexBubble } as unknown as ChunkingEngine,
  };
  return { ...deps, deps, refreshBubble, indexBubble };
}

describe('knowledge refresh and maintenance API', () => {
  it('reports component failures, retains retry candidates and refreshes other bubbles', async () => {
    const f = fixture();
    f.refreshBubble.mockRejectedValueOnce(new Error('embedding unavailable'));
    const result = await reindexKnowledge(f.deps);
    expect(result.refreshedIds).toEqual(['b']);
    expect(result.refreshErrors).toEqual([
      { id: 'a', stage: 'embedding', error: 'Error: embedding unavailable' },
    ]);
    expect(f.indexBubble.mock.calls).toEqual([['a'], ['b']]);
    expect((await reindexKnowledge(f.deps)).refreshedIds).toEqual(['a', 'b']);
  });

  it('stops before the next component after cancellation while embedding settles', async () => {
    const f = fixture();
    const hold = deferred<undefined>();
    const controller = new AbortController();
    f.refreshBubble.mockImplementationOnce(() => hold.promise);
    const pending = reindexKnowledge({ ...f.deps, signal: controller.signal });
    await vi.waitFor(() => expect(f.refreshBubble).toHaveBeenCalledOnce());
    controller.abort(new Error('stopped'));
    hold.resolve(undefined);
    await expect(pending).rejects.toThrow('stopped');
    expect(f.indexBubble).not.toHaveBeenCalled();
  });

  it('reports without mutation and awaits repair instead of returning a nonexistent task', async () => {
    const f = fixture();
    const report = {
      knowledgeDir: '/fixture',
      filesScanned: 1,
      graphNodesScanned: 0,
      issues: [
        { code: 'file-only' as const, message: 'File needs indexing', repair: 'Run reindex' },
      ],
    };
    f.knowledgeStore.reconcile = vi.fn(async () => report);
    const hold = deferred<undefined>();
    f.refreshBubble.mockImplementationOnce(() => hold.promise);
    const app = Fastify();
    apps.push(app);
    registerKnowledgeRoutes(app, {
      ...f.deps,
      eventBus: new EventBus(),
      ingestionProcessor: {} as IngestionProcessor,
      executionLogger: fakeExecutionLogger(),
    });
    const reconciliation = await app.inject({
      method: 'GET',
      url: '/api/knowledge/reconciliation',
    });
    expect(reconciliation.statusCode).toBe(200);
    expect(reconciliation.json()).toEqual(report);
    expect(f.knowledgeStore.reindexAll).not.toHaveBeenCalled();
    let settled = false;
    const pending = app
      .inject({ method: 'POST', url: '/api/knowledge/reindex-embeddings' })
      .then((response) => {
        settled = true;
        return response;
      });
    await vi.waitFor(() => expect(f.refreshBubble).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    hold.resolve(undefined);
    const repaired = await pending;
    expect(repaired.statusCode).toBe(200);
    expect(repaired.json()).toMatchObject({ refreshedIds: ['a', 'b'], refreshErrors: [] });
    expect(repaired.json()).not.toHaveProperty('taskId');
  });
});
