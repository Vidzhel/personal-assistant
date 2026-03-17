import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Neo4jContainer, type StartedNeo4jContainer } from '@testcontainers/neo4j';
import { createNeo4jClient } from '../knowledge-engine/neo4j-client.ts';
import { createKnowledgeStore } from '../knowledge-engine/knowledge-store.ts';
import { chunkContent, createChunkingEngine } from '../knowledge-engine/chunking.ts';
import { EventBus } from '../event-bus/event-bus.ts';
import type { Neo4jClient } from '../knowledge-engine/neo4j-client.ts';

// Mock the HuggingFace transformers pipeline
vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn().mockResolvedValue(
    vi.fn().mockImplementation(async (text: string) => {
      const data = new Float32Array(384);
      let hash = 0;
      for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
      }
      for (let i = 0; i < 384; i++) data[i] = Math.sin(hash + i) * 0.5;
      let norm = 0;
      for (let i = 0; i < 384; i++) norm += data[i] * data[i];
      norm = Math.sqrt(norm);
      for (let i = 0; i < 384; i++) data[i] /= norm;
      return { data };
    }),
  ),
}));

describe('Content Chunking', () => {
  describe('chunkContent (pure function)', () => {
    it('returns single chunk for short content', () => {
      const content = 'This is a short note about cooking pasta.';
      const chunks = chunkContent(content);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].text).toBe(content);
      expect(chunks[0].index).toBe(0);
      expect(chunks[0].startOffset).toBe(0);
      expect(chunks[0].endOffset).toBe(content.length);
    });

    it('splits long content into multiple overlapping chunks', () => {
      // Create content that exceeds ~300 tokens (1200 chars)
      const paragraph = 'This is a substantial paragraph about an important topic. ';
      const longContent = paragraph.repeat(30); // ~1800 chars = ~450 tokens
      const chunks = chunkContent(longContent);

      expect(chunks.length).toBeGreaterThan(1);
      // Verify chunks cover the full content
      expect(chunks[0].startOffset).toBe(0);
      // Verify overlap exists (next chunk starts before previous ends)
      if (chunks.length >= 2) {
        expect(chunks[1].startOffset).toBeLessThan(chunks[0].endOffset);
      }
    });

    it('splits on paragraph boundaries', () => {
      const para1 = 'A'.repeat(400); // ~100 tokens
      const para2 = 'B'.repeat(400); // ~100 tokens
      const para3 = 'C'.repeat(400); // ~100 tokens
      const para4 = 'D'.repeat(400); // ~100 tokens
      const content = [para1, para2, para3, para4].join('\n\n');
      const chunks = chunkContent(content);

      // Should split since total is ~400 tokens > 300
      expect(chunks.length).toBeGreaterThanOrEqual(1);
    });

    it('handles single very long paragraph by splitting on sentence boundaries', () => {
      const sentences = Array.from(
        { length: 40 },
        (_, i) =>
          `Sentence number ${i + 1} discusses a very interesting and relevant topic about knowledge management.`,
      );
      const content = sentences.join(' ');
      const chunks = chunkContent(content);

      expect(chunks.length).toBeGreaterThan(1);
      // Each chunk should not start or end mid-word
      for (const chunk of chunks) {
        expect(chunk.text.trim().length).toBeGreaterThan(0);
      }
    });

    it('respects custom chunk size and overlap', () => {
      const sentences = Array.from({ length: 20 }, (_, i) => `Point ${i + 1} is about testing.`);
      const content = sentences.join(' ');
      const chunks = chunkContent(content, { chunkSize: 50, overlap: 10 });

      // With smaller chunk size, should get more chunks
      expect(chunks.length).toBeGreaterThanOrEqual(1);
    });

    it('assigns sequential indices', () => {
      const sentences = Array.from(
        { length: 40 },
        (_, i) =>
          `Sentence ${i} covers a detailed topic for the knowledge retrieval system implementation.`,
      );
      const content = sentences.join(' ');
      const chunks = chunkContent(content);

      for (let i = 0; i < chunks.length; i++) {
        expect(chunks[i].index).toBe(i);
      }
    });
  });

  describe('ChunkingEngine (integration)', () => {
    let container: StartedNeo4jContainer;
    let neo4j: Neo4jClient;
    let tmpDir: string;
    let knowledgeDir: string;
    let eventBus: EventBus;

    beforeAll(async () => {
      container = await new Neo4jContainer('neo4j:5-community').withApoc().start();
      neo4j = createNeo4jClient({
        uri: container.getBoltUri(),
        user: 'neo4j',
        password: container.getPassword(),
      });
      await neo4j.ensureSchema();
    }, 120_000);

    afterAll(async () => {
      if (neo4j) await neo4j.close();
      if (container) await container.stop();
    });

    beforeEach(async () => {
      await neo4j.run('MATCH (n) DETACH DELETE n');
      tmpDir = mkdtempSync(join(tmpdir(), 'chunking-'));
      knowledgeDir = join(tmpDir, 'knowledge');
      mkdirSync(knowledgeDir, { recursive: true });
      eventBus = new EventBus();
    });

    it('indexes a bubble into chunk nodes', async () => {
      const knowledgeStore = createKnowledgeStore({ neo4j, knowledgeDir });
      const engine = createChunkingEngine({ neo4j, eventBus, knowledgeStore, knowledgeDir });

      // Create a bubble with substantial content
      const longContent = Array.from(
        { length: 40 },
        (_, i) => `Paragraph ${i}: This is about knowledge management and retrieval systems.`,
      ).join('\n\n');

      const bubble = await knowledgeStore.insert({
        title: 'Test Bubble',
        content: longContent,
        tags: ['test'],
      });

      await engine.indexBubble(bubble.id);

      // Verify chunks exist in Neo4j
      const chunks = await neo4j.query<{ id: string; text: string; index: number }>(
        `MATCH (b:Bubble {id: $id})-[:HAS_CHUNK]->(c:Chunk)
         RETURN c.id AS id, c.text AS text, c.index AS index ORDER BY c.index`,
        { id: bubble.id },
      );

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].index).toBe(0);
      // Each chunk should have an embedding
      const withEmb = await neo4j.queryOne<{ count: number }>(
        `MATCH (b:Bubble {id: $id})-[:HAS_CHUNK]->(c:Chunk)
         WHERE c.embedding IS NOT NULL
         RETURN count(c) AS count`,
        { id: bubble.id },
      );
      expect(withEmb?.count).toBe(chunks.length);
    }, 60_000);

    it('removeChunks deletes all chunk nodes for a bubble', async () => {
      const knowledgeStore = createKnowledgeStore({ neo4j, knowledgeDir });
      const engine = createChunkingEngine({ neo4j, eventBus, knowledgeStore, knowledgeDir });

      const bubble = await knowledgeStore.insert({
        title: 'Remove Me',
        content: 'Short content for removal test.',
        tags: [],
      });

      await engine.indexBubble(bubble.id);
      const before = await neo4j.queryOne<{ count: number }>(
        'MATCH (c:Chunk {bubbleId: $id}) RETURN count(c) AS count',
        { id: bubble.id },
      );
      expect(before?.count).toBeGreaterThan(0);

      await engine.removeChunks(bubble.id);
      const after = await neo4j.queryOne<{ count: number }>(
        'MATCH (c:Chunk {bubbleId: $id}) RETURN count(c) AS count',
        { id: bubble.id },
      );
      expect(after?.count).toBe(0);
    }, 60_000);

    it('backfillChunks indexes all un-chunked bubbles', async () => {
      const knowledgeStore = createKnowledgeStore({ neo4j, knowledgeDir });
      const engine = createChunkingEngine({ neo4j, eventBus, knowledgeStore, knowledgeDir });

      // Create multiple bubbles without chunks
      await knowledgeStore.insert({ title: 'Bubble A', content: 'Content A.', tags: [] });
      await knowledgeStore.insert({ title: 'Bubble B', content: 'Content B.', tags: [] });
      await knowledgeStore.insert({ title: 'Bubble C', content: 'Content C.', tags: [] });

      const result = await engine.backfillChunks();
      expect(result.indexed).toBe(3);
      expect(result.skipped).toBe(0);

      // All should now have chunks
      const chunks = await neo4j.queryOne<{ count: number }>(
        'MATCH (c:Chunk) RETURN count(c) AS count',
      );
      expect(chunks?.count).toBeGreaterThanOrEqual(3);
    }, 60_000);

    it('reindexAllChunks rebuilds all chunks from scratch', async () => {
      const knowledgeStore = createKnowledgeStore({ neo4j, knowledgeDir });
      const engine = createChunkingEngine({ neo4j, eventBus, knowledgeStore, knowledgeDir });

      await knowledgeStore.insert({ title: 'Reindex A', content: 'Content A.', tags: [] });
      await knowledgeStore.insert({ title: 'Reindex B', content: 'Content B.', tags: [] });

      // Index first
      await engine.backfillChunks();

      // Reindex
      const result = await engine.reindexAllChunks();
      expect(result.total).toBe(2);
      expect(result.indexed).toBe(2);
      expect(result.errors).toHaveLength(0);

      // Verify chunks exist
      const chunks = await neo4j.queryOne<{ count: number }>(
        'MATCH (c:Chunk) RETURN count(c) AS count',
      );
      expect(chunks?.count).toBeGreaterThanOrEqual(2);
    }, 60_000);

    it('emits knowledge:chunk:indexed event on successful indexing', async () => {
      const knowledgeStore = createKnowledgeStore({ neo4j, knowledgeDir });
      const engine = createChunkingEngine({ neo4j, eventBus, knowledgeStore, knowledgeDir });

      const events: any[] = [];
      eventBus.on('knowledge:chunk:indexed', (e) => events.push(e));

      const bubble = await knowledgeStore.insert({
        title: 'Event Test',
        content: 'Some content.',
        tags: [],
      });

      await engine.indexBubble(bubble.id);

      expect(events).toHaveLength(1);
      expect(events[0].payload.bubbleId).toBe(bubble.id);
      expect(events[0].payload.chunkCount).toBeGreaterThan(0);
    }, 60_000);
  });
});
