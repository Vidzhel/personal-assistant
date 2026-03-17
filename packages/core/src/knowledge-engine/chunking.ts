import { join } from 'node:path';
import { generateId, createLogger, type KnowledgeChunk, type RavenEvent } from '@raven/shared';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { Neo4jClient } from './neo4j-client.ts';
import type { KnowledgeStore } from './knowledge-store.ts';
import { readBubbleFile } from './knowledge-file.ts';
import { BGE_DOC_PREFIX, getPipeline } from './embeddings.ts';

const log = createLogger('chunking');

const DEFAULT_CHUNK_SIZE = 300; // tokens (~1200 chars)
const DEFAULT_OVERLAP = 50; // tokens (~200 chars)
const MIN_CHUNK_TOKENS = 50;
const CHARS_PER_TOKEN = 4;
const BACKFILL_LOG_INTERVAL = 10;

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
}

interface ChunkingDeps {
  neo4j: Neo4jClient;
  eventBus: EventBus;
  knowledgeStore: KnowledgeStore;
  knowledgeDir: string;
}

// eslint-disable-next-line max-lines-per-function -- factory function for chunking engine
export function createChunkingEngine(deps: ChunkingDeps): ChunkingEngine {
  const { neo4j, eventBus, knowledgeStore, knowledgeDir } = deps;

  async function embedChunkText(text: string, tags: string[]): Promise<number[]> {
    const input = BGE_DOC_PREFIX + `Tags: ${tags.join(', ')}. ` + text;
    const pipe = await getPipeline();
    const output = await pipe(input, { pooling: 'mean', normalize: true });
    return Array.from(new Float32Array(output.data));
  }

  async function indexBubble(bubbleId: string): Promise<void> {
    const bubble = await knowledgeStore.getById(bubbleId);
    if (!bubble) {
      log.warn(`Cannot index chunks: bubble ${bubbleId} not found`);
      return;
    }

    // Read full content from disk
    let content = bubble.content;
    if (!content) {
      try {
        const file = readBubbleFile(join(knowledgeDir, bubble.filePath));
        content = file.content;
      } catch {
        log.warn(`Cannot read file for bubble ${bubbleId}: ${bubble.filePath}`);
        return;
      }
    }

    if (!content.trim()) return;

    // Remove existing chunks first
    await removeChunks(bubbleId);

    const rawChunks = chunkContent(content);
    for (const chunk of rawChunks) {
      const chunkId = generateId();
      const embedding = await embedChunkText(chunk.text, bubble.tags);
      await neo4j.run(
        `MATCH (b:Bubble {id: $bubbleId})
         CREATE (c:Chunk {
           id: $id, bubbleId: $bubbleId, index: $index,
           text: $text, startOffset: $startOffset, endOffset: $endOffset,
           embedding: $embedding
         })
         CREATE (b)-[:HAS_CHUNK]->(c)`,
        {
          bubbleId,
          id: chunkId,
          index: chunk.index,
          text: chunk.text,
          startOffset: chunk.startOffset,
          endOffset: chunk.endOffset,
          embedding,
        },
      );
    }

    eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'chunking',
      type: 'knowledge:chunk:indexed',
      payload: { bubbleId, chunkCount: rawChunks.length },
    } as RavenEvent);

    log.info(`Indexed ${rawChunks.length} chunks for bubble ${bubbleId}`);
  }

  async function removeChunks(bubbleId: string): Promise<void> {
    await neo4j.run(`MATCH (b:Bubble {id: $bubbleId})-[:HAS_CHUNK]->(c:Chunk) DETACH DELETE c`, {
      bubbleId,
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
    // Delete ALL chunk nodes
    await neo4j.run('MATCH (c:Chunk) DETACH DELETE c');

    const rows = await neo4j.query<{ id: string }>('MATCH (b:Bubble) RETURN b.id AS id');
    const total = rows.length;
    const errors: string[] = [];
    let indexed = 0;

    for (const row of rows) {
      try {
        await indexBubble(row.id);
        indexed++;

        eventBus.emit({
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

    eventBus.emit({
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
    // Listen for embedding generated → index chunks for that bubble
    eventBus.on('knowledge:embedding:generated', (event: RavenEvent) => {
      if (event.type !== 'knowledge:embedding:generated') return;
      indexBubble(event.payload.bubbleId).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`Unhandled error in chunk indexing for ${event.payload.bubbleId}: ${msg}`);
      });
    });

    // Listen for bubble delete → clean up chunks
    eventBus.on('knowledge:bubble:deleted', (event: RavenEvent) => {
      if (event.type !== 'knowledge:bubble:deleted') return;
      removeChunks(event.payload.bubbleId).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`Unhandled error removing chunks for ${event.payload.bubbleId}: ${msg}`);
      });
    });

    log.info(
      'Chunking engine started — listening for embedding:generated and bubble:deleted events',
    );
  }

  return { indexBubble, removeChunks, backfillChunks, reindexAllChunks, start };
}
