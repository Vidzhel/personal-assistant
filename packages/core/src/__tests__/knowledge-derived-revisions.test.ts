import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryResult, ManagedTransaction } from 'neo4j-driver';
import type { KnowledgeBubble } from '@raven/shared';
import { EventBus } from '../event-bus/event-bus.ts';
import type { Neo4jClient } from '../knowledge-engine/neo4j-client.ts';
import { createEmbeddingEngine, resetPipeline } from '../knowledge-engine/embeddings.ts';
import { createChunkingEngine } from '../knowledge-engine/chunking.ts';
import { knowledgeRevision } from '../knowledge-engine/knowledge-revision.ts';
import type { KnowledgeStore } from '../knowledge-engine/knowledge-store.ts';

const embed = vi.hoisted(() =>
  vi.fn(async (text: string) => ({
    data: new Float32Array([text.length, 1]),
  })),
);

vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn(async () => embed),
}));

interface BubbleState {
  id: string;
  title: string;
  content: string;
  tags: string[];
  sourceRevision: string;
  embedding?: number[];
  embeddingRevision?: string;
  chunks: Array<{ id: string; text: string; embedding: number[] }>;
  chunkRevision?: string;
}

function result(records: unknown[] = []): QueryResult {
  return { records } as unknown as QueryResult;
}

class GraphFixture implements Neo4jClient {
  readonly states = new Map<string, BubbleState>();
  failOnChunkCreate = false;
  beforeCommit: (() => void) | undefined;

  async run(cypher: string, params: Record<string, unknown> = {}): Promise<QueryResult> {
    const state = this.states.get(String(params.bubbleId ?? ''));
    if (cypher.includes('DETACH DELETE')) {
      if (state) state.chunks = [];
      if (cypher.includes('REMOVE b.chunkRevision') && state) delete state.chunkRevision;
    }
    return result();
  }

  async query<T>(): Promise<T[]> {
    return [];
  }

  async queryOne<T>(cypher: string, params: Record<string, unknown> = {}): Promise<T | undefined> {
    const state = this.states.get(String(params.bubbleId ?? ''));
    if (!state) return undefined;
    if (cypher.includes('embeddingRevision')) {
      return {
        sourceRevision: state.sourceRevision,
        embeddingRevision: state.embeddingRevision ?? null,
        hasEmbedding: (state.embedding?.length ?? 0) > 0,
      } as T;
    }
    if (cypher.includes('chunkRevision')) {
      return {
        sourceRevision: state.sourceRevision,
        chunkRevision: state.chunkRevision ?? null,
        chunkCount: state.chunks.length,
      } as T;
    }
    return undefined;
  }

  async withTransaction<T>(operation: (tx: ManagedTransaction) => Promise<T>): Promise<T> {
    const before = structuredClone(this.states);
    const tx = {
      run: async (cypher: string, params: Record<string, unknown> = {}) => {
        const bubbleId = String(params.bubbleId ?? '');
        const state = this.states.get(bubbleId);
        if (cypher.includes('SET b.embedding =')) {
          if (!state) return result();
          const sourceRevision = String(params.sourceRevision ?? '');
          if (state.sourceRevision !== sourceRevision) {
            return result();
          }
          state.embedding = [...((params.embedding as number[]) ?? [])];
          state.embeddingRevision = sourceRevision;
          return result([{}]);
        }
        if (cypher.includes('__ravenDerivedLock')) {
          this.beforeCommit?.();
          this.beforeCommit = undefined;
          return result();
        }
        if (cypher.includes('RETURN b.id AS id')) {
          const sourceRevision = String(params.sourceRevision ?? '');
          return result(state && state.sourceRevision === sourceRevision ? [{}] : []);
        }
        if (cypher.includes('DETACH DELETE c')) {
          if (state) state.chunks = [];
          return result();
        }
        if (cypher.includes('REMOVE b.chunkRevision')) {
          if (state) delete state.chunkRevision;
          return result();
        }
        if (cypher.includes('CREATE (c:Chunk')) {
          if (this.failOnChunkCreate) throw new Error('chunk write failed');
          if (state) {
            state.chunks.push({
              id: String(params.id),
              text: String(params.text),
              embedding: [...((params.embedding as number[]) ?? [])],
            });
          }
          return result();
        }
        if (cypher.includes('SET b.chunkRevision =')) {
          if (state) state.chunkRevision = String(params.chunkRevision);
          return result();
        }
        return result();
      },
    } as unknown as ManagedTransaction;
    try {
      return await operation(tx);
    } catch (error) {
      this.states.clear();
      for (const [id, state] of before) this.states.set(id, state);
      throw error;
    }
  }

  async ensureSchema(): Promise<void> {}
  async close(): Promise<void> {}
}

class StoreFixture {
  readonly states = new Map<string, BubbleState>();
  readonly getById = vi.fn(async (id: string) => {
    const state = this.states.get(id);
    if (!state) return undefined;
    return {
      id: state.id,
      title: state.title,
      content: state.content,
      filePath: `${state.id}.md`,
      source: null,
      sourceFile: null,
      sourceUrl: null,
      tags: [...state.tags],
      domains: [],
      permanence: 'normal' as const,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastAccessedAt: null,
    } as KnowledgeBubble;
  });

  asStore(): KnowledgeStore {
    return { getById: this.getById } as unknown as KnowledgeStore;
  }

  add(id: string, title: string, content: string, tags: string[] = []): BubbleState {
    const state: BubbleState = {
      id,
      title,
      content,
      tags,
      sourceRevision: knowledgeRevision({ title, content, tags }),
      chunks: [{ id: `${id}-old`, text: 'old chunk', embedding: [0] }],
      embedding: [0],
      embeddingRevision: 'old-revision',
      chunkRevision: 'old-revision',
    };
    this.states.set(id, state);
    return state;
  }
}

function revision(state: BubbleState): string {
  return knowledgeRevision({ title: state.title, content: state.content, tags: state.tags });
}

function addBubble(
  graph: GraphFixture,
  store: StoreFixture,
  id: string,
  title: string,
  content: string,
  tags: string[] = [],
): BubbleState {
  const bubble = store.add(id, title, content, tags);
  graph.states.set(id, bubble);
  return bubble;
}

describe('knowledge derived revision processors', () => {
  beforeEach(() => {
    resetPipeline();
    embed.mockReset().mockImplementation(async (text: string) => ({
      data: new Float32Array([text.length, 1]),
    }));
  });

  it('refreshes an embedding from the current title, body, and tags', async () => {
    const graph = new GraphFixture();
    const store = new StoreFixture();
    const bubble = addBubble(graph, store, 'bubble-1', 'Original', 'Current body', ['one']);
    const engine = createEmbeddingEngine({
      neo4j: graph,
      eventBus: new EventBus(),
      knowledgeStore: store.asStore(),
    });

    await engine.refreshBubble(bubble.id);

    expect(graph.states.get(bubble.id)?.embeddingRevision).toBe(bubble.sourceRevision);
    expect(graph.states.get(bubble.id)?.embedding).toEqual([expect.any(Number), 1]);
    expect(embed.mock.calls[0]?.[0]).toContain('Tags: one.');

    bubble.title = 'Changed title';
    bubble.content = 'Changed body';
    bubble.tags = ['two', 'three'];
    bubble.sourceRevision = revision(bubble);
    await engine.refreshBubble(bubble.id);

    expect(graph.states.get(bubble.id)?.embeddingRevision).toBe(bubble.sourceRevision);
    expect(embed.mock.calls[1]?.[0]).toContain('Changed title');
    expect(embed.mock.calls[1]?.[0]).toContain('Changed body');
    expect(embed.mock.calls[1]?.[0]).toContain('Tags: two, three.');
  });

  it('regenerates missing derived data even when its revision marker matches', async () => {
    const graph = new GraphFixture();
    const store = new StoreFixture();
    const bubble = addBubble(graph, store, 'bubble-1', 'Title', 'Body', []);
    const currentRevision = bubble.sourceRevision;
    bubble.embedding = undefined;
    bubble.embeddingRevision = currentRevision;
    bubble.chunks = [];
    bubble.chunkRevision = currentRevision;

    const embeddings = createEmbeddingEngine({
      neo4j: graph,
      eventBus: new EventBus(),
      knowledgeStore: store.asStore(),
    });
    await embeddings.refreshBubble(bubble.id);
    expect(bubble.embedding).toEqual([expect.any(Number), 1]);

    const chunks = createChunkingEngine({
      neo4j: graph,
      eventBus: new EventBus(),
      knowledgeStore: store.asStore(),
      knowledgeDir: '/tmp/unused-knowledge-derived-revision-test',
    });
    await chunks.indexBubble(bubble.id);
    expect(bubble.chunks.length).toBeGreaterThan(0);
  });

  it('does not emit another generated event when the embedding is already fresh', async () => {
    const graph = new GraphFixture();
    const store = new StoreFixture();
    const bubble = addBubble(graph, store, 'bubble-1', 'Title', 'Body', []);
    const eventBus = new EventBus();
    const generated: string[] = [];
    eventBus.on('knowledge:embedding:generated', () => generated.push(bubble.id));
    const engine = createEmbeddingEngine({
      neo4j: graph,
      eventBus,
      knowledgeStore: store.asStore(),
    });

    await engine.refreshBubble(bubble.id);
    await engine.refreshBubble(bubble.id);

    expect(generated).toEqual([bubble.id]);
    expect(embed).toHaveBeenCalledOnce();
  });

  it('keeps old embedding and chunks when generation or replacement fails', async () => {
    const graph = new GraphFixture();
    const store = new StoreFixture();
    const bubble = addBubble(graph, store, 'bubble-1', 'Title', 'Body', []);
    const originalEmbedding = [...bubble.embedding!];
    embed.mockRejectedValueOnce(new Error('model failed'));
    const embeddings = createEmbeddingEngine({
      neo4j: graph,
      eventBus: new EventBus(),
      knowledgeStore: store.asStore(),
    });
    await expect(embeddings.refreshBubble(bubble.id)).rejects.toThrow('model failed');
    expect(graph.states.get(bubble.id)?.embedding).toEqual(originalEmbedding);

    const chunks = createChunkingEngine({
      neo4j: graph,
      eventBus: new EventBus(),
      knowledgeStore: store.asStore(),
      knowledgeDir: '/tmp/unused-knowledge-derived-revision-test',
    });
    graph.failOnChunkCreate = true;
    await expect(chunks.indexBubble(bubble.id)).rejects.toThrow('chunk write failed');
    expect(graph.states.get(bubble.id)?.chunks).toEqual([
      { id: 'bubble-1-old', text: 'old chunk', embedding: [0] },
    ]);
  });

  it('rejects a stale asynchronous result before graph mutation', async () => {
    const graph = new GraphFixture();
    const store = new StoreFixture();
    const bubble = addBubble(graph, store, 'bubble-1', 'Title', 'Before', []);
    const release = deferred<boolean>();
    embed.mockImplementationOnce(async () => {
      await release.promise;
      return { data: new Float32Array([9, 9]) };
    });
    const engine = createEmbeddingEngine({
      neo4j: graph,
      eventBus: new EventBus(),
      knowledgeStore: store.asStore(),
    });
    const refresh = engine.refreshBubble(bubble.id);
    await vi.waitFor(() => expect(embed).toHaveBeenCalledOnce());
    bubble.content = 'After';
    bubble.sourceRevision = revision(bubble);
    release.resolve(true);
    await expect(refresh).rejects.toThrow('changed while embedding was generated');
    expect(graph.states.get(bubble.id)?.embedding).toEqual([0]);
  });

  it('rejects a graph revision change after the transaction lock', async () => {
    const graph = new GraphFixture();
    const store = new StoreFixture();
    const bubble = addBubble(graph, store, 'bubble-1', 'Title', 'Body', []);
    const oldEmbedding = [...bubble.embedding!];
    const engine = createEmbeddingEngine({
      neo4j: graph,
      eventBus: new EventBus(),
      knowledgeStore: store.asStore(),
    });
    graph.beforeCommit = () => {
      graph.states.get(bubble.id)!.sourceRevision = 'newer-file-revision';
    };

    await expect(engine.refreshBubble(bubble.id)).rejects.toThrow(
      'changed before embedding commit',
    );
    expect(bubble.embedding).toEqual(oldEmbedding);
    expect(bubble.embeddingRevision).toBe('old-revision');
  });

  it('rejects chunk replacement if the graph revision changes under the lock', async () => {
    const graph = new GraphFixture();
    const store = new StoreFixture();
    const bubble = addBubble(graph, store, 'bubble-1', 'Title', 'Body', []);
    const oldChunks = structuredClone(bubble.chunks);
    const engine = createChunkingEngine({
      neo4j: graph,
      eventBus: new EventBus(),
      knowledgeStore: store.asStore(),
      knowledgeDir: '/tmp/unused-knowledge-derived-revision-test',
    });
    graph.beforeCommit = () => {
      graph.states.get(bubble.id)!.sourceRevision = 'newer-file-revision';
    };

    await expect(engine.indexBubble(bubble.id)).rejects.toThrow('changed before chunk commit');
    expect(bubble.chunks).toEqual(oldChunks);
    expect(bubble.chunkRevision).toBe('old-revision');
  });

  it('replaces empty content with zero chunks and stops accepting writes', async () => {
    const graph = new GraphFixture();
    const store = new StoreFixture();
    const bubble = addBubble(graph, store, 'empty', 'Empty', '   ', []);
    const engine = createChunkingEngine({
      neo4j: graph,
      eventBus: new EventBus(),
      knowledgeStore: store.asStore(),
      knowledgeDir: '/tmp/unused-knowledge-derived-revision-test',
    });

    await engine.indexBubble(bubble.id);
    expect(graph.states.get(bubble.id)?.chunks).toEqual([]);
    expect(graph.states.get(bubble.id)?.chunkRevision).toBe(bubble.sourceRevision);

    await engine.stop();
    await expect(engine.indexBubble(bubble.id)).rejects.toThrow('chunking is stopped');
  });

  it('removes chunks and clears the derived revision marker', async () => {
    const graph = new GraphFixture();
    const store = new StoreFixture();
    const bubble = addBubble(graph, store, 'bubble-1', 'Title', 'Body', []);
    const engine = createChunkingEngine({
      neo4j: graph,
      eventBus: new EventBus(),
      knowledgeStore: store.asStore(),
      knowledgeDir: '/tmp/unused-knowledge-derived-revision-test',
    });

    await engine.removeChunks(bubble.id);

    expect(bubble.chunks).toEqual([]);
    expect(bubble.chunkRevision).toBeUndefined();
  });

  it('shares concurrent indexing for one bubble while generation is pending', async () => {
    const graph = new GraphFixture();
    const store = new StoreFixture();
    const bubble = addBubble(graph, store, 'bubble-1', 'Title', 'Body', []);
    const release = deferred<boolean>();
    embed.mockImplementationOnce(async (text: string) => {
      await release.promise;
      return { data: new Float32Array([text.length, 1]) };
    });
    const engine = createChunkingEngine({
      neo4j: graph,
      eventBus: new EventBus(),
      knowledgeStore: store.asStore(),
      knowledgeDir: '/tmp/unused-knowledge-derived-revision-test',
    });

    const first = engine.indexBubble(bubble.id);
    await vi.waitFor(() => expect(embed).toHaveBeenCalledOnce());
    const second = engine.indexBubble(bubble.id);
    release.resolve(true);
    await Promise.all([first, second]);

    expect(embed).toHaveBeenCalledOnce();
    expect(bubble.chunks).toHaveLength(1);
  });
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
