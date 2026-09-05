import { createProcessorLifecycle } from './processor-lifecycle.ts';
import {
  generateId,
  createLogger,
  type KnowledgeBubble,
  type KnowledgeChunk,
  type RavenEvent,
} from '@raven/shared';
import type { ManagedTransaction } from 'neo4j-driver';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { Neo4jClient } from './neo4j-client.ts';
import type { KnowledgeStore } from './knowledge-store.ts';
import { BGE_DOC_PREFIX, getPipeline } from './embeddings.ts';
import { knowledgeRevision } from './knowledge-revision.ts';

const log = createLogger('chunking');

const DEFAULT_CHUNK_SIZE = 300; // tokens (~1200 chars)
const DEFAULT_OVERLAP = 50; // tokens (~200 chars)
const MIN_CHUNK_TOKENS = 50;
const CHARS_PER_TOKEN = 4;
const BACKFILL_LOG_INTERVAL = 10;

interface PreparedChunk extends KnowledgeChunk {
  id: string;
  embedding: number[];
}

interface DerivedState {
  sourceRevision: string | null;
  chunkRevision: string | null;
  chunkCount: number;
}

async function replaceChunkRows(
  tx: ManagedTransaction,
  bubbleId: string,
  chunks: PreparedChunk[],
): Promise<void> {
  await tx.run(`MATCH (c:Chunk {bubbleId: $bubbleId}) DETACH DELETE c`, { bubbleId });
  for (const chunk of chunks) {
    await tx.run(
      `MATCH (b:Bubble {id: $bubbleId})
       CREATE (c:Chunk {
         id: $id, bubbleId: $bubbleId, index: $index,
         text: $text, startOffset: $startOffset, endOffset: $endOffset,
         embedding: $embedding
       })
       CREATE (b)-[:HAS_CHUNK]->(c)`,
      {
        bubbleId,
        id: chunk.id,
        index: chunk.index,
        text: chunk.text,
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
        embedding: chunk.embedding,
      },
    );
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function charsFromTokens(tokens: number): number {
  return tokens * CHARS_PER_TOKEN;
}

/** Split text on sentence boundaries (. ! ? followed by whitespace/newline/end). */
function splitSentences(text: string): string[] {
  const parts = text.split(/(?<=[.!?])\s+/);
  return parts.filter((p) => p.length > 0);
}

/** Split content into overlapping chunks with whitespace-aware boundaries. */
// eslint-disable-next-line max-lines-per-function, complexity -- chunking algorithm with multiple split strategies
export function chunkContent(
  content: string,
  options?: { chunkSize?: number; overlap?: number },
): KnowledgeChunk[] {
  if (!content.trim()) return [];
  const chunkSizeTokens = options?.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const overlapTokens = options?.overlap ?? DEFAULT_OVERLAP;
  const totalTokens = estimateTokens(content);

  // Short content: single chunk
  if (totalTokens <= chunkSizeTokens) {
    return [
      { id: '', bubbleId: '', index: 0, text: content, startOffset: 0, endOffset: content.length },
    ];
  }

  const overlapChars = charsFromTokens(overlapTokens);
  const paragraphs = content.split(/\n\n+/);
  const chunks: KnowledgeChunk[] = [];
  let currentText = '';
  let currentStart = 0;
  let globalOffset = 0;

  function flushChunk(): void {
    if (estimateTokens(currentText) >= MIN_CHUNK_TOKENS) {
      chunks.push({
        id: '',
        bubbleId: '',
        index: chunks.length,
        text: currentText.trim(),
        startOffset: currentStart,
        endOffset: currentStart + currentText.length,
      });
    }
  }

  for (const para of paragraphs) {
    const paraWithSep = globalOffset > 0 ? '\n\n' + para : para;
    const sepLen = globalOffset > 0 ? 2 : 0;

    if (estimateTokens(para) > chunkSizeTokens) {
      // Large paragraph: split on sentence boundaries
      if (currentText) flushChunk();
      const sentences = splitSentences(para);
      currentText = '';
      currentStart = globalOffset + sepLen;

      for (const sentence of sentences) {
        if (estimateTokens(currentText + ' ' + sentence) > chunkSizeTokens && currentText) {
          flushChunk();
          // Overlap: keep tail of current chunk
          const overlapText = currentText.slice(-overlapChars);
          currentStart = currentStart + currentText.length - overlapText.length;
          currentText = overlapText + ' ' + sentence;
        } else {
          currentText = currentText ? currentText + ' ' + sentence : sentence;
        }
      }
    } else if (estimateTokens(currentText + paraWithSep) > chunkSizeTokens) {
      flushChunk();
      // Overlap: keep tail of current chunk
      const overlapText = currentText.slice(-overlapChars);
      currentStart = currentStart + currentText.length - overlapText.length;
      currentText = overlapText + '\n\n' + para;
    } else {
      currentText = currentText ? currentText + '\n\n' + para : para;
      if (!currentText || chunks.length === 0) {
        currentStart = globalOffset;
      }
    }

    globalOffset += sepLen + para.length;
  }

  // Flush remaining
  if (currentText.trim()) flushChunk();

  return chunks;
}

export interface ChunkingEngine {
  indexBubble: (bubbleId: string) => Promise<void>;
  removeChunks: (bubbleId: string) => Promise<void>;
  backfillChunks: () => Promise<{ indexed: number; skipped: number }>;
  reindexAllChunks: () => Promise<{ total: number; indexed: number; errors: string[] }>;
  start: () => void;
  stop: () => Promise<void>;
}

interface ChunkingDeps {
  neo4j: Neo4jClient;
  eventBus: EventBus;
  knowledgeStore: KnowledgeStore;
  knowledgeDir: string;
}

// eslint-disable-next-line max-lines-per-function -- factory function for chunking engine
export function createChunkingEngine(deps: ChunkingDeps): ChunkingEngine {
  const { eventBus } = deps;
  const lifetime = createProcessorLifecycle(eventBus, 'chunking');
  const neo4j = lifetime.guard(deps.neo4j);
  const knowledgeStore = lifetime.guard(deps.knowledgeStore);
  let started = false;
  const indexes = new Map<string, Promise<void>>();

  async function embedChunkText(text: string, tags: string[]): Promise<number[]> {
    lifetime.assertActive();
    const input = BGE_DOC_PREFIX + `Tags: ${tags.join(', ')}. ` + text;
    const pipe = await getPipeline();
    lifetime.assertActive();
    const output = await pipe(input, { pooling: 'mean', normalize: true });
    return Array.from(new Float32Array(output.data));
  }

  async function derivedState(bubbleId: string): Promise<DerivedState> {
    const row = await neo4j.queryOne<DerivedState>(
      `MATCH (b:Bubble {id: $bubbleId})
       OPTIONAL MATCH (c:Chunk {bubbleId: $bubbleId})
       RETURN b.sourceRevision AS sourceRevision,
              b.chunkRevision AS chunkRevision,
              count(c) AS chunkCount`,
      { bubbleId },
    );
    if (!row) throw new Error(`Knowledge bubble ${bubbleId} not found`);
    return {
      sourceRevision: row.sourceRevision ?? null,
      chunkRevision: row.chunkRevision ?? null,
      chunkCount: Number(row.chunkCount ?? 0),
    };
  }

  async function prepareChunks(
    bubble: Pick<KnowledgeBubble, 'title' | 'content' | 'tags'>,
  ): Promise<{ revision: string; chunks: PreparedChunk[] }> {
    const revision = knowledgeRevision({
      title: bubble.title,
      content: bubble.content,
      tags: bubble.tags,
    });
    const rawChunks = bubble.content.trim() ? chunkContent(bubble.content) : [];
    const chunks: PreparedChunk[] = [];
    for (const chunk of rawChunks) {
      chunks.push({
        ...chunk,
        id: generateId(),
        embedding: await embedChunkText(chunk.text, bubble.tags),
      });
    }
    return { revision, chunks };
  }

  async function commitChunks(
    bubbleId: string,
    prepared: { revision: string; chunks: PreparedChunk[] },
  ): Promise<void> {
    const { revision, chunks } = prepared;
    await neo4j.withTransaction(async (tx) => {
      await tx.run(
        `MATCH (b:Bubble {id: $bubbleId})
         SET b.__ravenDerivedLock = $lock
         REMOVE b.__ravenDerivedLock`,
        { bubbleId, lock: generateId() },
      );
      const check = await tx.run(
        `MATCH (b:Bubble {id: $bubbleId})
         WHERE b.sourceRevision = $sourceRevision
         RETURN b.id AS id`,
        {
          bubbleId,
          sourceRevision: revision,
        },
      );
      if (check.records.length === 0) {
        throw new Error(`Knowledge bubble ${bubbleId} changed before chunk commit`);
      }
      await replaceChunkRows(tx, bubbleId, chunks);
      await tx.run(`MATCH (b:Bubble {id: $bubbleId}) SET b.chunkRevision = $chunkRevision`, {
        bubbleId,
        chunkRevision: revision,
      });
    });
  }

  async function indexBubbleOnce(bubbleId: string): Promise<void> {
    const bubble = await knowledgeStore.getById(bubbleId, { trackAccess: false });
    if (!bubble) {
      throw new Error(`Knowledge bubble ${bubbleId} not found`);
    }

    const initialState = await derivedState(bubbleId);
    const revision = knowledgeRevision({
      title: bubble.title,
      content: bubble.content,
      tags: bubble.tags,
    });
    if (initialState.sourceRevision !== revision) {
      throw new Error(`Knowledge bubble ${bubbleId} source changed; reindex required`);
    }
    if (
      initialState.chunkRevision === revision &&
      initialState.chunkCount === chunkContent(bubble.content).length
    )
      return;
    const prepared = await prepareChunks(bubble);
    const current = await knowledgeStore.getById(bubbleId, { trackAccess: false });
    if (
      !current ||
      knowledgeRevision({
        title: current.title,
        content: current.content,
        tags: current.tags,
      }) !== prepared.revision
    ) {
      throw new Error(`Knowledge bubble ${bubbleId} changed while chunks were generated`);
    }

    await commitChunks(bubbleId, prepared);

    lifetime.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'chunking',
      type: 'knowledge:chunk:indexed',
      payload: { bubbleId, chunkCount: prepared.chunks.length },
    } as RavenEvent);

    log.info(`Indexed ${prepared.chunks.length} chunks for bubble ${bubbleId}`);
  }

  async function indexBubble(bubbleId: string): Promise<void> {
    const existing = indexes.get(bubbleId);
    if (existing) return existing;
    const current = indexBubbleOnce(bubbleId);
    indexes.set(bubbleId, current);
    try {
      await current;
    } finally {
      if (indexes.get(bubbleId) === current) indexes.delete(bubbleId);
    }
  }

  async function removeChunks(bubbleId: string): Promise<void> {
    await neo4j.withTransaction(async (tx) => {
      // Match chunks independently so orphaned rows are removed even after the Bubble is gone.
      await tx.run(`MATCH (c:Chunk {bubbleId: $bubbleId}) DETACH DELETE c`, { bubbleId });
      await tx.run(`MATCH (b:Bubble {id: $bubbleId}) REMOVE b.chunkRevision`, { bubbleId });
    });
  }

  async function backfillChunks(): Promise<{ indexed: number; skipped: number }> {
    const rows = await neo4j.query<{ id: string }>(
      `MATCH (b:Bubble) WHERE NOT (b)-[:HAS_CHUNK]->(:Chunk) RETURN b.id AS id`,
    );

    let indexed = 0;
    let skipped = 0;

    for (const row of rows) {
      try {
        await indexBubble(row.id);
        indexed++;
        if (indexed % BACKFILL_LOG_INTERVAL === 0) {
          log.info(`Chunk backfill progress: ${indexed}/${rows.length}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`Chunk backfill failed for bubble ${row.id}: ${msg}`);
        skipped++;
      }
    }

    log.info(`Chunk backfill complete: ${indexed} indexed, ${skipped} skipped`);
    return { indexed, skipped };
  }

  async function reindexAllChunks(): Promise<{ total: number; indexed: number; errors: string[] }> {
    const rows = await neo4j.query<{ id: string }>('MATCH (b:Bubble) RETURN b.id AS id');
    const total = rows.length;
    const errors: string[] = [];
    let indexed = 0;

    for (const row of rows) {
      try {
        await indexBubble(row.id);
        indexed++;

        lifetime.assertActive();
        lifetime.emit({
          id: generateId(),
          timestamp: Date.now(),
          source: 'chunking',
          type: 'knowledge:reindex:progress',
          payload: { completed: indexed, total, bubbleId: row.id },
        } as RavenEvent);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${row.id}: ${msg}`);
        log.warn(`Chunk reindex failed for bubble ${row.id}: ${msg}`);
      }
    }

    lifetime.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'chunking',
      type: 'knowledge:reindex:complete',
      payload: { total, indexed, errors },
    } as RavenEvent);

    log.info(`Chunk reindex complete: ${indexed}/${total} indexed, ${errors.length} errors`);
    return { total, indexed, errors };
  }

  function start(): void {
    lifetime.assertActive();
    if (started) return;
    started = true;
    lifetime.listen('knowledge:embedding:generated', async (event) => {
      if (event.type === 'knowledge:embedding:generated') await indexBubble(event.payload.bubbleId);
    });
    lifetime.listen('knowledge:bubble:deleted', async (event) => {
      if (event.type === 'knowledge:bubble:deleted') await removeChunks(event.payload.bubbleId);
    });
  }

  return {
    indexBubble: (id) => lifetime.run(() => indexBubble(id)),
    removeChunks: (id) => lifetime.run(() => removeChunks(id)),
    backfillChunks: () => lifetime.run(backfillChunks),
    reindexAllChunks: () => lifetime.run(reindexAllChunks),
    start,
    stop: lifetime.stop,
  };
}
