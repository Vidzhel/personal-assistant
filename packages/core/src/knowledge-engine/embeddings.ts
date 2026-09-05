import { createProcessorLifecycle } from './processor-lifecycle.ts';
import {
  generateId,
  createLogger,
  type KnowledgeBubble,
  type RavenEvent,
  type SimilarBubble,
} from '@raven/shared';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { Neo4jClient } from './neo4j-client.ts';
import type { KnowledgeStore } from './knowledge-store.ts';
import { knowledgeRevision } from './knowledge-revision.ts';

const log = createLogger('embeddings');

export const BGE_DOC_PREFIX = 'Represent this document for retrieval: ';
export const BGE_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

// Use a generic function type since the pipeline returns various output types
type PipelineFunction = (
  text: string,
  options?: Record<string, unknown>,
) => Promise<{ data: Float32Array }>;

let pipelineInstance: PipelineFunction | null = null;

export async function getPipeline(): Promise<PipelineFunction> {
  if (!pipelineInstance) {
    const { pipeline } = await import('@huggingface/transformers');
    const pipe = await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5', {
      dtype: 'fp32',
    });
    pipelineInstance = pipe as unknown as PipelineFunction;
  }
  return pipelineInstance;
}

export function resetPipeline(): void {
  pipelineInstance = null;
}

/** Serialize a Float32Array embedding to a Buffer for storage/transport (story 6.4 reuse). */
export function serializeEmbedding(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

/** Deserialize a Buffer back to a Float32Array embedding (story 6.4 reuse). */
export function deserializeEmbedding(blob: Buffer): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / FLOAT32_BYTES);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

export function buildBubbleEmbeddingInput(bubble: {
  title: string;
  contentPreview?: string;
  tags?: string[];
  domains?: string[];
}): string {
  const parts: string[] = [];
  if (bubble.tags && bubble.tags.length > 0) parts.push(`Tags: ${bubble.tags.join(', ')}.`);
  if (bubble.domains && bubble.domains.length > 0)
    parts.push(`Domains: ${bubble.domains.join(', ')}.`);
  parts.push(bubble.title);
  if (bubble.contentPreview) parts.push(bubble.contentPreview);
  return BGE_DOC_PREFIX + parts.join(' ');
}

export function buildQueryEmbeddingInput(query: string): string {
  return BGE_QUERY_PREFIX + query;
}

export interface EmbeddingEngine {
  generateEmbedding: (text: string) => Promise<Float32Array>;
  generateAndStore: (bubbleId: string, text: string) => Promise<void>;
  refreshBubble: (bubbleId: string) => Promise<void>;
  getEmbedding: (bubbleId: string) => Promise<Float32Array | undefined>;
  getAllEmbeddings: () => Promise<Array<{ bubbleId: string; embedding: Float32Array }>>;
  findSimilar: (
    targetEmbedding: Float32Array,
    options: { limit?: number; threshold?: number; excludeIds?: string[] },
  ) => Promise<SimilarBubble[]>;
  removeEmbedding: (bubbleId: string) => Promise<void>;
  start: () => void;
  stop: () => Promise<void>;
}

interface EmbeddingDeps {
  neo4j: Neo4jClient;
  eventBus: EventBus;
  knowledgeStore: KnowledgeStore;
}

const DEFAULT_SIMILAR_LIMIT = 10;
const DEFAULT_SIMILAR_THRESHOLD = 0.5;
const FLOAT32_BYTES = 4;
const PREVIEW_LENGTH = 200;

interface DerivedState {
  sourceRevision: string | null;
  embeddingRevision: string | null;
  hasEmbedding: boolean;
}

// eslint-disable-next-line max-lines-per-function -- factory function for embedding engine
export function createEmbeddingEngine(deps: EmbeddingDeps): EmbeddingEngine {
  const { eventBus } = deps;
  const lifetime = createProcessorLifecycle(eventBus, 'embeddings');
  const neo4j = lifetime.guard(deps.neo4j);
  const knowledgeStore = lifetime.guard(deps.knowledgeStore);
  let started = false;
  const refreshes = new Map<string, Promise<boolean>>();

  async function generateEmbedding(text: string): Promise<Float32Array> {
    lifetime.assertActive();
    const pipe = await getPipeline();
    lifetime.assertActive();
    const output = await pipe(text, { pooling: 'mean', normalize: true });
    return new Float32Array(output.data);
  }

  async function generateAndStore(bubbleId: string, text: string): Promise<void> {
    const embedding = await generateEmbedding(text);
    lifetime.assertActive();
    const embeddingArray = Array.from(embedding);
    await neo4j.run(
      `MATCH (b:Bubble {id: $bubbleId})
       SET b.embedding = $embedding
       REMOVE b.embeddingRevision`,
      { bubbleId, embedding: embeddingArray },
    );
    log.info(`Embedding stored for bubble ${bubbleId}`);
  }

  function revisionOf(bubble: Pick<KnowledgeBubble, 'title' | 'content' | 'tags'>): string {
    return knowledgeRevision({ title: bubble.title, content: bubble.content, tags: bubble.tags });
  }

  async function derivedState(bubbleId: string): Promise<DerivedState> {
    const row = await neo4j.queryOne<DerivedState>(
      `MATCH (b:Bubble {id: $bubbleId})
       RETURN b.sourceRevision AS sourceRevision,
              b.embeddingRevision AS embeddingRevision,
              b.embedding IS NOT NULL AND size(b.embedding) > 0 AS hasEmbedding`,
      { bubbleId },
    );
    if (!row) throw new Error(`Knowledge bubble ${bubbleId} not found`);
    return {
      sourceRevision: row.sourceRevision ?? null,
      embeddingRevision: row.embeddingRevision ?? null,
      hasEmbedding: row.hasEmbedding === true,
    };
  }

  async function replaceRevisionedEmbedding(bubbleId: string): Promise<boolean> {
    const snapshot = await knowledgeStore.getById(bubbleId, { trackAccess: false });
    if (!snapshot) throw new Error(`Knowledge bubble ${bubbleId} not found`);
    const revision = revisionOf(snapshot);
    const initialState = await derivedState(bubbleId);
    if (initialState.sourceRevision !== revision) {
      throw new Error(`Knowledge bubble ${bubbleId} source changed; reindex required`);
    }
    if (initialState.embeddingRevision === revision && initialState.hasEmbedding) return false;
    const input = buildBubbleEmbeddingInput({
      title: snapshot.title,
      contentPreview: snapshot.content.slice(0, PREVIEW_LENGTH),
      tags: snapshot.tags,
    });
    const embedding = await generateEmbedding(input);
    const current = await knowledgeStore.getById(bubbleId, { trackAccess: false });
    if (!current || revisionOf(current) !== revision) {
      throw new Error(`Knowledge bubble ${bubbleId} changed while embedding was generated`);
    }

    await neo4j.withTransaction(async (tx) => {
      await tx.run(
        `MATCH (b:Bubble {id: $bubbleId})
         SET b.__ravenDerivedLock = $lock
         REMOVE b.__ravenDerivedLock`,
        { bubbleId, lock: generateId() },
      );
      const result = await tx.run(
        `MATCH (b:Bubble {id: $bubbleId})
         WHERE b.sourceRevision = $sourceRevision
         SET b.embedding = $embedding, b.embeddingRevision = $sourceRevision
         RETURN b.id AS id`,
        {
          bubbleId,
          sourceRevision: revision,
          embedding: Array.from(embedding),
        },
      );
      if (result.records.length === 0) {
        throw new Error(`Knowledge bubble ${bubbleId} changed before embedding commit`);
      }
    });
    log.info(`Revisioned embedding stored for bubble ${bubbleId}`);
    return true;
  }

  async function refreshBubble(bubbleId: string): Promise<void> {
    const previous = refreshes.get(bubbleId) ?? Promise.resolve(false);
    const current = previous.catch(() => false).then(() => replaceRevisionedEmbedding(bubbleId));
    refreshes.set(bubbleId, current);
    try {
      const replaced = await current;
      lifetime.assertActive();
      if (replaced) {
        lifetime.emit({
          id: generateId(),
          timestamp: Date.now(),
          source: 'embeddings',
          type: 'knowledge:embedding:generated',
          payload: { bubbleId },
        } as RavenEvent);
      }
    } finally {
      if (refreshes.get(bubbleId) === current) refreshes.delete(bubbleId);
    }
  }

  async function getEmbedding(bubbleId: string): Promise<Float32Array | undefined> {
    const row = await neo4j.queryOne<{ embedding: number[] | null }>(
      'MATCH (b:Bubble {id: $bubbleId}) RETURN b.embedding AS embedding',
      { bubbleId },
    );
    if (!row?.embedding) return undefined;
    return new Float32Array(row.embedding);
  }

  async function getAllEmbeddings(): Promise<Array<{ bubbleId: string; embedding: Float32Array }>> {
    const rows = await neo4j.query<{ bubbleId: string; embedding: number[] }>(
      `MATCH (b:Bubble) WHERE b.embedding IS NOT NULL
       RETURN b.id AS bubbleId, b.embedding AS embedding`,
    );
    return rows.map((row) => ({
      bubbleId: row.bubbleId,
      embedding: new Float32Array(row.embedding),
    }));
  }

  async function findSimilar(
    targetEmbedding: Float32Array,
    options: { limit?: number; threshold?: number; excludeIds?: string[] } = {},
  ): Promise<SimilarBubble[]> {
    const limit = options.limit ?? DEFAULT_SIMILAR_LIMIT;
    const threshold = options.threshold ?? DEFAULT_SIMILAR_THRESHOLD;
    const excludeIds = options.excludeIds ?? [];
    const embeddingArray = Array.from(targetEmbedding);

    // Use Neo4j vector index for approximate nearest neighbor search.
    // Note: Neo4j vector indexes are eventually consistent — results may be stale
    // immediately after generateAndStore(). Acceptable at current scale.
    const rows = await neo4j.query<{ bubbleId: string; score: number }>(
      `CALL db.index.vector.queryNodes('bubble_embedding', $topK, $embedding)
       YIELD node, score
       WHERE score >= $threshold AND NOT node.id IN $excludeIds
       RETURN node.id AS bubbleId, score
       LIMIT toInteger($limit)`,
      {
        topK: Math.round(limit + excludeIds.length),
        embedding: embeddingArray,
        threshold,
        excludeIds,
        limit: limit,
      },
    );

    return rows.map((r) => ({ bubbleId: r.bubbleId, similarity: r.score }));
  }

  async function removeEmbedding(bubbleId: string): Promise<void> {
    await neo4j.run(
      `MATCH (b:Bubble {id: $bubbleId})
       REMOVE b.embedding, b.embeddingRevision`,
      { bubbleId },
    );
  }

  // H1 FIX: Use knowledgeStore.getContentPreview() instead of filePath for embedding input
  async function handleBubbleEvent(event: RavenEvent): Promise<void> {
    if (event.type !== 'knowledge:bubble:created' && event.type !== 'knowledge:bubble:updated')
      return;
    const { bubbleId } = event.payload;
    try {
      await refreshBubble(bubbleId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Failed to generate embedding for bubble ${bubbleId}: ${msg}`);
    }
  }

  function start(): void {
    lifetime.assertActive();
    if (started) return;
    started = true;
    lifetime.listen('knowledge:bubble:created', handleBubbleEvent);
    lifetime.listen('knowledge:bubble:updated', handleBubbleEvent);
  }

  return {
    generateEmbedding: (text) => lifetime.run(() => generateEmbedding(text)),
    generateAndStore: (id, text) => lifetime.run(() => generateAndStore(id, text)),
    refreshBubble: (id) => lifetime.run(() => refreshBubble(id)),
    getEmbedding,
    getAllEmbeddings,
    findSimilar,
    removeEmbedding,
    start,
    stop: lifetime.stop,
  };
}
