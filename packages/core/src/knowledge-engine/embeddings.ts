import {
  generateId,
  createLogger,
  type DatabaseInterface,
  type RavenEvent,
  type SimilarBubble,
} from '@raven/shared';
import type { EventBus } from '../event-bus/event-bus.ts';

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

export function serializeEmbedding(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

const FLOAT32_BYTES = 4;

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
  getEmbedding: (bubbleId: string) => Float32Array | undefined;
  getAllEmbeddings: () => Array<{ bubbleId: string; embedding: Float32Array }>;
  findSimilar: (
    targetEmbedding: Float32Array,
    options: { limit?: number; threshold?: number; excludeIds?: string[] },
  ) => SimilarBubble[];
  removeEmbedding: (bubbleId: string) => void;
  start: () => void;
}

interface EmbeddingRow {
  bubble_id: string;
  embedding: Buffer;
}

interface EmbeddingDeps {
  db: DatabaseInterface;
  eventBus: EventBus;
}

const DEFAULT_SIMILAR_LIMIT = 10;
const DEFAULT_SIMILAR_THRESHOLD = 0.5;

// eslint-disable-next-line max-lines-per-function -- factory function for embedding engine
export function createEmbeddingEngine(deps: EmbeddingDeps): EmbeddingEngine {
  const { db, eventBus } = deps;

  async function generateEmbedding(text: string): Promise<Float32Array> {
    const pipe = await getPipeline();
    const output = await pipe(text, { pooling: 'mean', normalize: true });
    return new Float32Array(output.data);
  }

  async function generateAndStore(bubbleId: string, text: string): Promise<void> {
    const embedding = await generateEmbedding(text);
    const blob = serializeEmbedding(embedding);
    db.run(
      `INSERT OR REPLACE INTO knowledge_embeddings (bubble_id, embedding, model, created_at) VALUES (?, ?, ?, datetime('now'))`,
      bubbleId,
      blob,
      'bge-small-en-v1.5',
    );
    log.info(`Embedding stored for bubble ${bubbleId}`);
  }

  function getEmbedding(bubbleId: string): Float32Array | undefined {
    const row = db.get<EmbeddingRow>(
      'SELECT embedding FROM knowledge_embeddings WHERE bubble_id = ?',
      bubbleId,
    );
    if (!row) return undefined;
    return deserializeEmbedding(row.embedding);
  }

  function getAllEmbeddings(): Array<{ bubbleId: string; embedding: Float32Array }> {
    const rows = db.all<EmbeddingRow>('SELECT bubble_id, embedding FROM knowledge_embeddings');
    return rows.map((row) => ({
      bubbleId: row.bubble_id,
      embedding: deserializeEmbedding(row.embedding),
    }));
  }

  function findSimilar(
    targetEmbedding: Float32Array,
    options: { limit?: number; threshold?: number; excludeIds?: string[] } = {},
  ): SimilarBubble[] {
    const limit = options.limit ?? DEFAULT_SIMILAR_LIMIT;
    const threshold = options.threshold ?? DEFAULT_SIMILAR_THRESHOLD;
    const excludeSet = new Set(options.excludeIds ?? []);

    const all = getAllEmbeddings();
    const results: SimilarBubble[] = [];

    for (const entry of all) {
      if (excludeSet.has(entry.bubbleId)) continue;
      const sim = cosineSimilarity(targetEmbedding, entry.embedding);
      if (sim >= threshold) {
        results.push({ bubbleId: entry.bubbleId, similarity: sim });
      }
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, limit);
  }

  function removeEmbedding(bubbleId: string): void {
    db.run('DELETE FROM knowledge_embeddings WHERE bubble_id = ?', bubbleId);
  }

  async function handleBubbleEvent(event: RavenEvent): Promise<void> {
    if (event.type !== 'knowledge:bubble:created' && event.type !== 'knowledge:bubble:updated')
      return;
    const { bubbleId, title, filePath } = event.payload;
    try {
      const text = buildBubbleEmbeddingInput({ title, contentPreview: filePath });
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
      handleBubbleEvent(event);
    });
    eventBus.on('knowledge:bubble:updated', (event: RavenEvent) => {
      handleBubbleEvent(event);
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
