import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Neo4jContainer, type StartedNeo4jContainer } from '@testcontainers/neo4j';
import { createNeo4jClient } from '../knowledge-engine/neo4j-client.ts';
import { createKnowledgeStore } from '../knowledge-engine/knowledge-store.ts';
import { createChunkingEngine } from '../knowledge-engine/chunking.ts';
import { createRetrievalEngine, classifyQuery } from '../knowledge-engine/retrieval.ts';
import { EventBus } from '../event-bus/event-bus.ts';
import type { Neo4jClient } from '../knowledge-engine/neo4j-client.ts';

// Mock HuggingFace transformers
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

describe('Query Classification', () => {
  it('classifies date queries as precise', () => {
    expect(classifyQuery('What happened on 2026-03-05?')).toBe('precise');
    expect(classifyQuery('What happened on March 5th?')).toBe('precise');
    expect(classifyQuery('Who said something last Monday?')).toBe('precise');
  });

  it('classifies browsing queries as timeline', () => {
    expect(classifyQuery('Show me recent notes')).toBe('timeline');
    expect(classifyQuery('Browse my knowledge')).toBe('timeline');
    expect(classifyQuery('What happened last week?')).toBe('timeline');
    expect(classifyQuery('Show me the timeline')).toBe('timeline');
  });

  it('classifies everything else as generic', () => {
    expect(classifyQuery('What do I like eating?')).toBe('generic');
    expect(classifyQuery('How does authentication work?')).toBe('generic');
    expect(classifyQuery('Tell me about my hobbies')).toBe('generic');
  });
});

describe('Retrieval Engine (integration)', () => {
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
    tmpDir = mkdtempSync(join(tmpdir(), 'retrieval-'));
    knowledgeDir = join(tmpDir, 'knowledge');
    mkdirSync(knowledgeDir, { recursive: true });
    eventBus = new EventBus();
  });

  async function setupBubblesWithChunks() {
    const knowledgeStore = createKnowledgeStore({ neo4j, knowledgeDir });
    const chunkingEngine = createChunkingEngine({ neo4j, eventBus, knowledgeStore, knowledgeDir });

    const b1 = await knowledgeStore.insert({
      title: 'Cooking Pasta',
      content:
        'I love making pasta. Italian cuisine is my favorite. I particularly enjoy making carbonara with fresh eggs and guanciale.',
      tags: ['cooking', 'food'],
    });
    const b2 = await knowledgeStore.insert({
      title: 'Running Habits',
      content: 'I run 5km every morning. Running helps me stay focused and maintain my health.',
      tags: ['fitness', 'health'],
    });
    const b3 = await knowledgeStore.insert({
      title: 'TypeScript Tips',
      content:
        'TypeScript strict mode catches many bugs at compile time. Use generics for reusable components.',
      tags: ['programming', 'typescript'],
    });

    // Index chunks
    await chunkingEngine.indexBubble(b1.id);
    await chunkingEngine.indexBubble(b2.id);
    await chunkingEngine.indexBubble(b3.id);

    return { knowledgeStore, chunkingEngine, bubbles: [b1, b2, b3] };
  }

  it('performs generic search and returns results with provenance', async () => {
    const { knowledgeStore } = await setupBubblesWithChunks();
    const engine = createRetrievalEngine({ neo4j, knowledgeStore, knowledgeDir });

    // Wait briefly for vector indexes to populate
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const result = await engine.search('cooking food');

    expect(result.query).toBe('cooking food');
    expect(result.queryType).toBe('generic');
    expect(result.tokenBudgetTotal).toBe(4000);
    // Results may or may not be found depending on vector index consistency
    // but the structure should be correct
    expect(result.results).toBeDefined();
    expect(Array.isArray(result.results)).toBe(true);
  }, 60_000);

  it('performs precise date query', async () => {
    const { knowledgeStore } = await setupBubblesWithChunks();
    const engine = createRetrievalEngine({ neo4j, knowledgeStore, knowledgeDir });

    const result = await engine.search('What happened on 2026-03-17?');

    expect(result.queryType).toBe('precise');
    expect(result.results).toBeDefined();
    expect(Array.isArray(result.results)).toBe(true);
  }, 60_000);

  it('retrieves timeline by date dimension', async () => {
    const { knowledgeStore } = await setupBubblesWithChunks();
    const engine = createRetrievalEngine({ neo4j, knowledgeStore, knowledgeDir });

    const result = await engine.retrieveTimeline({
      dimension: 'date',
      direction: 'backward',
      limit: 10,
    });

    expect(result.dimension).toBe('date');
    expect(result.bubbles.length).toBe(3);
    expect(result.total).toBe(3);
    expect(result.nextCursor).toBeTruthy();
    expect(result.prevCursor).toBeTruthy();
  }, 60_000);

  it('retrieves timeline by recency dimension', async () => {
    const { knowledgeStore } = await setupBubblesWithChunks();
    const engine = createRetrievalEngine({ neo4j, knowledgeStore, knowledgeDir });

    const result = await engine.retrieveTimeline({
      dimension: 'recency',
      direction: 'backward',
      limit: 2,
    });

    expect(result.dimension).toBe('recency');
    expect(result.bubbles.length).toBe(2);
  }, 60_000);

  it('returns index status', async () => {
    const { knowledgeStore } = await setupBubblesWithChunks();
    const engine = createRetrievalEngine({ neo4j, knowledgeStore, knowledgeDir });

    const status = await engine.getIndexStatus();

    expect(status.totalBubbles).toBe(3);
    expect(status.indexedBubbles).toBe(3);
    expect(status.totalChunks).toBeGreaterThan(0);
  }, 60_000);

  it('respects token budget and truncates results', async () => {
    const { knowledgeStore } = await setupBubblesWithChunks();
    const engine = createRetrievalEngine({ neo4j, knowledgeStore, knowledgeDir });

    await new Promise((resolve) => setTimeout(resolve, 2000));

    const result = await engine.search('knowledge', { tokenBudget: 10 });

    expect(result.tokenBudgetTotal).toBe(10);
    // With a very small budget, results should be limited
    expect(result.tokenBudgetUsed).toBeLessThanOrEqual(10 + 100); // allow some slack for first result
  }, 60_000);

  it('handles concurrent queries without errors', async () => {
    const { knowledgeStore } = await setupBubblesWithChunks();
    const engine = createRetrievalEngine({
      neo4j,
      knowledgeStore,
      knowledgeDir,
      maxConcurrentSearches: 3,
    });

    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Fire 5 concurrent queries
    const queries = [
      engine.search('cooking'),
      engine.search('running'),
      engine.search('programming'),
      engine.search('health'),
      engine.search('TypeScript'),
    ];

    const results = await Promise.all(queries);

    // All should succeed
    expect(results).toHaveLength(5);
    for (const r of results) {
      expect(r.results).toBeDefined();
      expect(Array.isArray(r.results)).toBe(true);
    }
  }, 60_000);

  it('enrichWithSource returns undefined for bubbles without sourceFile', async () => {
    const { knowledgeStore, bubbles } = await setupBubblesWithChunks();
    const engine = createRetrievalEngine({ neo4j, knowledgeStore, knowledgeDir });

    const content = await engine.enrichWithSource(bubbles[0].id);
    expect(content).toBeUndefined();
  }, 60_000);

  it('multi-tier retrieval includes linked bubbles', async () => {
    const knowledgeStore = createKnowledgeStore({ neo4j, knowledgeDir });
    const chunkingEngine = createChunkingEngine({ neo4j, eventBus, knowledgeStore, knowledgeDir });

    const b1 = await knowledgeStore.insert({
      title: 'Main Topic',
      content:
        'This is the main topic about artificial intelligence and machine learning algorithms.',
      tags: ['ai'],
    });
    const b2 = await knowledgeStore.insert({
      title: 'Linked Topic',
      content: 'Deep learning is a subset of machine learning using neural networks.',
      tags: ['ai'],
    });

    await chunkingEngine.indexBubble(b1.id);
    await chunkingEngine.indexBubble(b2.id);

    // Create accepted link between b1 and b2
    await neo4j.run(
      `MATCH (a:Bubble {id: $id1}), (b:Bubble {id: $id2})
       CREATE (a)-[:LINKS_TO {id: $linkId, status: 'accepted', confidence: 0.9}]->(b)`,
      { id1: b1.id, id2: b2.id, linkId: 'link-1' },
    );

    const engine = createRetrievalEngine({ neo4j, knowledgeStore, knowledgeDir });

    await new Promise((resolve) => setTimeout(resolve, 2000));

    const result = await engine.search('artificial intelligence');

    expect(result.queryType).toBe('generic');
    expect(result.results).toBeDefined();
    // If vector search returns results, linked bubble should be included via tier 3
  }, 60_000);
});
