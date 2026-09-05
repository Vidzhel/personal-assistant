import { vi } from 'vitest';
import type { QueryResult } from 'neo4j-driver';
import type { Neo4jClient } from '../../knowledge-engine/neo4j-client.ts';
import type { KnowledgeStore } from '../../knowledge-engine/knowledge-store.ts';

export function fakeGraph(): Neo4jClient {
  return {
    run: vi.fn(async () => ({ records: [] }) as unknown as QueryResult),
    query: vi.fn(async () => []),
    queryOne: vi.fn(async () => undefined),
    withTransaction: vi.fn(async () => {
      throw new Error('Unexpected transaction in fake graph');
    }),
    ensureSchema: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

export function fakeKnowledgeStore(): KnowledgeStore {
  return {
    reindexAll: vi.fn(async () => ({ indexed: 0, errors: [], changedIds: [] })),
    getById: vi.fn(async (id: string) => ({
      id,
      title: id,
      content: 'Test body',
      tags: [],
      filePath: `${id}.md`,
      source: 'auto-retrospective:fixture',
    })),
    getContentPreview: vi.fn(async () => 'Test preview'),
    insert: vi.fn(async () => ({ id: 'saved', title: 'Saved', filePath: 'saved.md' })),
    update: vi.fn(async () => true),
    remove: vi.fn(async () => true),
    mergeOwned: vi.fn(async () => ({ id: 'saved', title: 'Saved', filePath: 'saved.md' })),
    recoverMerge: vi.fn(async (targetId: string) => ({ targetId, status: 'completed' })),
  } as unknown as KnowledgeStore;
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function fakeConsolidationStorage() {
  return {
    knowledgeStore: fakeKnowledgeStore(),
    embeddingEngine: { refreshBubble: vi.fn(async () => {}) },
    chunkingEngine: { indexBubble: vi.fn(async () => {}) },
  };
}
