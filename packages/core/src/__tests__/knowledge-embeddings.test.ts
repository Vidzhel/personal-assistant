import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, getDb, createDbInterface } from '../db/database.ts';
import {
  createEmbeddingEngine,
  cosineSimilarity,
  serializeEmbedding,
  deserializeEmbedding,
  buildBubbleEmbeddingInput,
  buildQueryEmbeddingInput,
} from '../knowledge-engine/embeddings.ts';
import { EventBus } from '../event-bus/event-bus.ts';
import type { RavenEvent } from '@raven/shared';

// Mock the HuggingFace transformers pipeline
vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn().mockResolvedValue(
    vi.fn().mockImplementation(async (text: string) => {
      // Return a deterministic fake embedding based on text hash
      const data = new Float32Array(384);
      let hash = 0;
      for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
      }
      for (let i = 0; i < 384; i++) {
        data[i] = Math.sin(hash + i) * 0.5;
      }
      // Normalize
      let norm = 0;
      for (let i = 0; i < 384; i++) norm += data[i] * data[i];
      norm = Math.sqrt(norm);
      for (let i = 0; i < 384; i++) data[i] /= norm;
      return { data };
    }),
  ),
}));

describe('Embedding Engine', () => {
  let tmpDir: string;
  let eventBus: EventBus;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'embeddings-'));
    initDatabase(join(tmpDir, 'test.db'));
    eventBus = new EventBus();
  });

  afterEach(() => {
    try {
      getDb().close();
    } catch {
      /* */
    }
    rmSync(tmpDir, { recursive: true, force: true });
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

  describe('serializeEmbedding / deserializeEmbedding', () => {
    it('round-trips a Float32Array through Buffer', () => {
      const original = new Float32Array([0.1, 0.2, 0.3, -0.4]);
      const serialized = serializeEmbedding(original);
      expect(serialized).toBeInstanceOf(Buffer);

      const deserialized = deserializeEmbedding(serialized);
      expect(deserialized).toHaveLength(4);
      for (let i = 0; i < original.length; i++) {
        expect(deserialized[i]).toBeCloseTo(original[i]);
      }
    });

    it('handles 384-dim embeddings', () => {
      const original = new Float32Array(384);
      for (let i = 0; i < 384; i++) original[i] = Math.random() * 2 - 1;
      const roundTripped = deserializeEmbedding(serializeEmbedding(original));
      expect(roundTripped).toHaveLength(384);
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
      const db = createDbInterface();
      const engine = createEmbeddingEngine({ db, eventBus });

      await engine.generateAndStore('bubble-1', 'Some text about health');
      const emb = engine.getEmbedding('bubble-1');
      expect(emb).toBeInstanceOf(Float32Array);
      expect(emb!.length).toBe(384);
    });

    it('returns undefined for missing embedding', () => {
      const db = createDbInterface();
      const engine = createEmbeddingEngine({ db, eventBus });
      expect(engine.getEmbedding('nonexistent')).toBeUndefined();
    });

    it('getAllEmbeddings returns all stored', async () => {
      const db = createDbInterface();
      const engine = createEmbeddingEngine({ db, eventBus });

      await engine.generateAndStore('b1', 'Text one');
      await engine.generateAndStore('b2', 'Text two');

      const all = engine.getAllEmbeddings();
      expect(all).toHaveLength(2);
    });

    it('findSimilar finds matching embeddings', async () => {
      const db = createDbInterface();
      const engine = createEmbeddingEngine({ db, eventBus });

      await engine.generateAndStore('b1', 'Health and fitness tips');
      await engine.generateAndStore('b2', 'Health and fitness tips'); // same text = high similarity
      await engine.generateAndStore('b3', 'Quantum physics theory');

      const emb = engine.getEmbedding('b1')!;
      const similar = engine.findSimilar(emb, { threshold: 0.9, excludeIds: ['b1'] });
      // b2 should be highly similar (same text)
      expect(similar.some((s) => s.bubbleId === 'b2')).toBe(true);
    });

    it('findSimilar respects excludeIds', async () => {
      const db = createDbInterface();
      const engine = createEmbeddingEngine({ db, eventBus });

      await engine.generateAndStore('b1', 'Same text');
      await engine.generateAndStore('b2', 'Same text');

      const emb = engine.getEmbedding('b1')!;
      const similar = engine.findSimilar(emb, { threshold: 0, excludeIds: ['b1', 'b2'] });
      expect(similar).toHaveLength(0);
    });

    it('findSimilar respects limit', async () => {
      const db = createDbInterface();
      const engine = createEmbeddingEngine({ db, eventBus });

      for (let i = 0; i < 10; i++) {
        await engine.generateAndStore(`b${i}`, `Text ${i}`);
      }

      const emb = engine.getEmbedding('b0')!;
      const similar = engine.findSimilar(emb, { limit: 3, threshold: 0, excludeIds: ['b0'] });
      expect(similar.length).toBeLessThanOrEqual(3);
    });

    it('removeEmbedding deletes from DB', async () => {
      const db = createDbInterface();
      const engine = createEmbeddingEngine({ db, eventBus });

      await engine.generateAndStore('b1', 'Text');
      expect(engine.getEmbedding('b1')).toBeDefined();

      engine.removeEmbedding('b1');
      expect(engine.getEmbedding('b1')).toBeUndefined();
    });

    it('emits knowledge:embedding:generated on bubble created event', async () => {
      const db = createDbInterface();
      const engine = createEmbeddingEngine({ db, eventBus });
      engine.start();

      const emitted: RavenEvent[] = [];
      eventBus.on('knowledge:embedding:generated', (e: RavenEvent) => emitted.push(e));

      eventBus.emit({
        id: 'test-1',
        timestamp: Date.now(),
        source: 'test',
        type: 'knowledge:bubble:created',
        payload: { bubbleId: 'b1', title: 'Test Bubble', filePath: 'test.md' },
      } as RavenEvent);

      // Wait for async handler
      await new Promise((r) => setTimeout(r, 100));
      expect(emitted).toHaveLength(1);
      expect(emitted[0].type).toBe('knowledge:embedding:generated');
    });
  });
});
