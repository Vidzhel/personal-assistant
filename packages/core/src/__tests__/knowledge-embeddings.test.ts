import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Neo4jContainer, type StartedNeo4jContainer } from '@testcontainers/neo4j';
import { createNeo4jClient } from '../knowledge-engine/neo4j-client.ts';
import { createKnowledgeStore } from '../knowledge-engine/knowledge-store.ts';
import {
  createEmbeddingEngine,
  cosineSimilarity,
  buildBubbleEmbeddingInput,
  buildQueryEmbeddingInput,
} from '../knowledge-engine/embeddings.ts';
import { EventBus } from '../event-bus/event-bus.ts';
import type { RavenEvent } from '@raven/shared';
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

describe('Embedding Engine', () => {
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
    tmpDir = mkdtempSync(join(tmpdir(), 'embeddings-'));
    knowledgeDir = join(tmpDir, 'knowledge');
    mkdirSync(knowledgeDir, { recursive: true });
    eventBus = new EventBus();
  });

  describe('cosineSimilarity', () => {
    it('returns 1 for identical vectors', () => {
      const a = new Float32Array([1, 0, 0]);
      expect(cosineSimilarity(a, a)).toBeCloseTo(1.0);
    });

    it('returns 0 for orthogonal vectors', () => {
      const a = new Float32Array([1, 0, 0]);
      const b = new Float32Array([0, 1, 0]);
      expect(cosineSimilarity(a, b)).toBeCloseTo(0.0);
    });

    it('returns -1 for opposite vectors', () => {
      const a = new Float32Array([1, 0, 0]);
      const b = new Float32Array([-1, 0, 0]);
      expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0);
    });

    it('returns 0 for zero vectors', () => {
      const a = new Float32Array([0, 0, 0]);
      const b = new Float32Array([1, 0, 0]);
      expect(cosineSimilarity(a, b)).toBe(0);
    });
  });

  describe('buildBubbleEmbeddingInput', () => {
    it('includes tags, domains, title, and preview', () => {
      const input = buildBubbleEmbeddingInput({
        title: 'My Note',
        contentPreview: 'Some preview text',
        tags: ['health', 'fitness'],
        domains: ['health'],
      });
      expect(input).toContain('Represent this document for retrieval:');
      expect(input).toContain('Tags: health, fitness.');
      expect(input).toContain('Domains: health.');
      expect(input).toContain('My Note');
      expect(input).toContain('Some preview text');
    });

    it('omits empty tags/domains', () => {
      const input = buildBubbleEmbeddingInput({ title: 'Title Only' });
      expect(input).not.toContain('Tags:');
      expect(input).not.toContain('Domains:');
    });
  });

  describe('buildQueryEmbeddingInput', () => {
    it('prefixes with query instruction', () => {
      const input = buildQueryEmbeddingInput('search term');
      expect(input).toContain('Represent this sentence for searching relevant passages:');
      expect(input).toContain('search term');
    });
  });

  describe('createEmbeddingEngine', () => {
    it('generates and stores embeddings', async () => {
      const store = createKnowledgeStore({ neo4j, knowledgeDir });
      const bubble = await store.insert({ title: 'Test', content: 'health content', tags: [] });

      const engine = createEmbeddingEngine({ neo4j, eventBus, knowledgeStore: store });
      await engine.generateAndStore(bubble.id, 'Some text about health');

      const emb = await engine.getEmbedding(bubble.id);
      expect(emb).toBeInstanceOf(Float32Array);
      expect(emb!.length).toBe(384);
    });

    it('returns undefined for missing embedding', async () => {
      const store = createKnowledgeStore({ neo4j, knowledgeDir });
      const engine = createEmbeddingEngine({ neo4j, eventBus, knowledgeStore: store });
      expect(await engine.getEmbedding('nonexistent')).toBeUndefined();
    });

    it('getAllEmbeddings returns all stored', async () => {
      const store = createKnowledgeStore({ neo4j, knowledgeDir });
      const b1 = await store.insert({ title: 'B1', content: 'text', tags: [] });
      const b2 = await store.insert({ title: 'B2', content: 'text', tags: [] });

      const engine = createEmbeddingEngine({ neo4j, eventBus, knowledgeStore: store });
      await engine.generateAndStore(b1.id, 'Text one');
      await engine.generateAndStore(b2.id, 'Text two');

      const all = await engine.getAllEmbeddings();
      expect(all).toHaveLength(2);
    });

    it('removeEmbedding removes from graph', async () => {
      const store = createKnowledgeStore({ neo4j, knowledgeDir });
      const bubble = await store.insert({ title: 'Remove', content: '', tags: [] });

      const engine = createEmbeddingEngine({ neo4j, eventBus, knowledgeStore: store });
      await engine.generateAndStore(bubble.id, 'Text');
      expect(await engine.getEmbedding(bubble.id)).toBeDefined();

      await engine.removeEmbedding(bubble.id);
      expect(await engine.getEmbedding(bubble.id)).toBeUndefined();
    });

    it('emits knowledge:embedding:generated on bubble created event', async () => {
      const store = createKnowledgeStore({ neo4j, knowledgeDir });
      const bubble = await store.insert({
        title: 'Test Bubble',
        content: 'Preview text',
        tags: [],
      });

      const engine = createEmbeddingEngine({ neo4j, eventBus, knowledgeStore: store });
      engine.start();

      const eventPromise = new Promise<RavenEvent>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Timed out waiting for embedding event')),
          5000,
        );
        eventBus.on('knowledge:embedding:generated', (e: RavenEvent) => {
          clearTimeout(timeout);
          resolve(e);
        });
      });

      eventBus.emit({
        id: 'test-1',
        timestamp: Date.now(),
        source: 'test',
        type: 'knowledge:bubble:created',
        payload: { bubbleId: bubble.id, title: 'Test Bubble', filePath: 'test.md' },
      } as RavenEvent);

      const event = await eventPromise;
      expect(event.type).toBe('knowledge:embedding:generated');
    });
  });
});
