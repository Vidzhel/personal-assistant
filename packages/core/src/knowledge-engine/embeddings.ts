import { generateId, createLogger, type RavenEvent, type SimilarBubble } from '@raven/shared';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { Neo4jClient } from './neo4j-client.ts';
import type { KnowledgeStore } from './knowledge-store.ts';

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
  getEmbedding: (bubbleId: string) => Promise<Float32Array | undefined>;
  getAllEmbeddings: () => Promise<Array<{ bubbleId: string; embedding: Float32Array }>>;
  findSimilar: (
    targetEmbedding: Float32Array,
    options: { limit?: number; threshold?: number; excludeIds?: string[] },
  ) => Promise<SimilarBubble[]>;
  removeEmbedding: (bubbleId: string) => Promise<void>;
  start: () => void;
}

interface EmbeddingDeps {
  neo4j: Neo4jClient;
  eventBus: EventBus;
  knowledgeStore: KnowledgeStore;
}

const DEFAULT_SIMILAR_LIMIT = 10;
const DEFAULT_SIMILAR_THRESHOLD = 0.5;
const FLOAT32_BYTES = 4;

// eslint-disable-next-line max-lines-per-function -- factory function for embedding engine
export function createEmbeddingEngine(deps: EmbeddingDeps): EmbeddingEngine {
  const { neo4j, eventBus, knowledgeStore } = deps;

  async function generateEmbedding(text: string): Promise<Float32Array> {
    const pipe = await getPipeline();
    const output = await pipe(text, { pooling: 'mean', normalize: true });
    return new Float32Array(output.data);
  }

  async function generateAndStore(bubbleId: string, text: string): Promise<void> {
    const embedding = await generateEmbedding(text);
    const embeddingArray = Array.from(embedding);
    await neo4j.run(
      `MATCH (b:Bubble {id: $bubbleId})
       SET b.embedding = $embedding`,
      { bubbleId, embedding: embeddingArray },
    );
    log.info(`Embedding stored for bubble ${bubbleId}`);
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
    await neo4j.run(`MATCH (b:Bubble {id: $bubbleId}) REMOVE b.embedding`, { bubbleId });
  }

  // H1 FIX: Use knowledgeStore.getContentPreview() instead of filePath for embedding input
  async function handleBubbleEvent(event: RavenEvent): Promise<void> {
    if (event.type !== 'knowledge:bubble:created' && event.type !== 'knowledge:bubble:updated')
      return;
    const { bubbleId, title } = event.payload;
    try {
      const preview = await knowledgeStore.getContentPreview(bubbleId);
      const text = buildBubbleEmbeddingInput({ title, contentPreview: preview ?? '' });
      await generateAndStore(bubbleId, text);
      eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: 'embeddings',
        type: 'knowledge:embedding:generated',
        payload: { bubbleId },
      } as RavenEvent);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Failed to generate embedding for bubble ${bubbleId}: ${msg}`);
    }
  }

  function start(): void {
    eventBus.on('knowledge:bubble:created', (event: RavenEvent) => {
      handleBubbleEvent(event).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`Unhandled error in bubble:created handler: ${msg}`);
      });
    });
    eventBus.on('knowledge:bubble:updated', (event: RavenEvent) => {
      handleBubbleEvent(event).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`Unhandled error in bubble:updated handler: ${msg}`);
      });
    });
    log.info(
      'Embedding engine started — listening for knowledge:bubble:created/updated events (lazy model init)',
    );
  }

  return {
    generateEmbedding,
    generateAndStore,
    getEmbedding,
    getAllEmbeddings,
    findSimilar,
    removeEmbedding,
    start,
  };
}
