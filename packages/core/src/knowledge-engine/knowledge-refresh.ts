import type { KnowledgeStore } from './knowledge-store.ts';
import type { EmbeddingEngine } from './embeddings.ts';
import type { ChunkingEngine } from './chunking.ts';

export interface KnowledgeRefreshReport {
  indexed: number;
  errors: string[];
  changedIds: string[];
  refreshedIds: string[];
  refreshErrors: Array<{ id: string; stage: 'embedding' | 'chunks'; error: string }>;
}

interface RefreshDeps {
  knowledgeStore: KnowledgeStore;
  embeddingEngine?: EmbeddingEngine;
  chunkingEngine?: ChunkingEngine;
  signal?: AbortSignal;
}

/** Retry only stale bubbles. Each processor commits its revision with its derived data. */
export async function refreshKnowledgeIndexes(
  deps: RefreshDeps,
  source: Awaited<ReturnType<KnowledgeStore['reindexAll']>>,
): Promise<KnowledgeRefreshReport> {
  const report: KnowledgeRefreshReport = { ...source, refreshedIds: [], refreshErrors: [] };
  for (const id of new Set(source.changedIds)) {
    deps.signal?.throwIfAborted();
    const errorsBefore = report.refreshErrors.length;
    for (const stage of ['embedding', 'chunks'] as const) {
      try {
        deps.signal?.throwIfAborted();
        await refreshComponent(deps, id, stage);
      } catch (error) {
        deps.signal?.throwIfAborted();
        report.refreshErrors.push({ id, stage, error: String(error) });
      }
    }
    if (report.refreshErrors.length === errorsBefore) report.refreshedIds.push(id);
  }
  return report;
}

export async function reindexKnowledge(deps: RefreshDeps): Promise<KnowledgeRefreshReport> {
  deps.signal?.throwIfAborted();
  const source = await deps.knowledgeStore.reindexAll();
  return refreshKnowledgeIndexes(deps, source);
}

async function refreshComponent(
  deps: RefreshDeps,
  id: string,
  stage: 'embedding' | 'chunks',
): Promise<void> {
  if (stage === 'embedding') {
    if (!deps.embeddingEngine) throw new Error('Embedding processor unavailable');
    await deps.embeddingEngine.refreshBubble(id);
  } else {
    if (!deps.chunkingEngine) throw new Error('Chunk processor unavailable');
    await deps.chunkingEngine.indexBubble(id);
  }
}
