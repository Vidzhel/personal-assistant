import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Neo4jContainer, type StartedNeo4jContainer } from '@testcontainers/neo4j';
import { createNeo4jClient } from '../knowledge-engine/neo4j-client.ts';
import { createKnowledgeStore } from '../knowledge-engine/knowledge-store.ts';
import { createEmbeddingEngine } from '../knowledge-engine/embeddings.ts';
import { createClusteringEngine } from '../knowledge-engine/clustering.ts';
import { EventBus } from '../event-bus/event-bus.ts';
import type { RavenEvent, KnowledgeDomain } from '@raven/shared';
import type { EmbeddingEngine } from '../knowledge-engine/embeddings.ts';
import type { KnowledgeStore } from '../knowledge-engine/knowledge-store.ts';
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

const testDomains: KnowledgeDomain[] = [
  {
    name: 'health',
    description: 'Health',
    rules: {
      tags: ['health', 'fitness', 'nutrition'],
      keywords: ['doctor', 'workout', 'calories'],
    },
  },
  {
    name: 'work',
    description: 'Work',
    rules: {
      tags: ['work', 'project', 'meeting'],
      keywords: ['sprint', 'deploy', 'review'],
    },
  },
];

describe('Clustering Engine', () => {
  let container: StartedNeo4jContainer;
  let neo4j: Neo4jClient;
  let tmpDir: string;
  let knowledgeDir: string;
  let eventBus: EventBus;
  let store: KnowledgeStore;
  let embeddingEngine: EmbeddingEngine;

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
    await neo4j.close();
    await container.stop();
  });

  beforeEach(async () => {
    await neo4j.run('MATCH (n) DETACH DELETE n');
    tmpDir = mkdtempSync(join(tmpdir(), 'clustering-'));
    knowledgeDir = join(tmpDir, 'knowledge');
    mkdirSync(knowledgeDir, { recursive: true });
    eventBus = new EventBus();
    store = createKnowledgeStore({ neo4j, knowledgeDir });
    embeddingEngine = createEmbeddingEngine({ neo4j, eventBus, knowledgeStore: store });
  });

  describe('classifyDomains', () => {
    it('matches by tag overlap', () => {
      const engine = createClusteringEngine({
        neo4j,
        eventBus,
        embeddingEngine,
        knowledgeStore: store,
        domainConfig: testDomains,
      });
      const domains = engine.classifyDomains({
        id: 'b1',
        tags: ['health', 'nutrition'],
        title: 'Food Guide',
        content: 'Eating well',
      });
      expect(domains).toContain('health');
      expect(domains).not.toContain('work');
    });

    it('matches by keyword presence', () => {
      const engine = createClusteringEngine({
        neo4j,
        eventBus,
        embeddingEngine,
        knowledgeStore: store,
        domainConfig: testDomains,
      });
      const domains = engine.classifyDomains({
        id: 'b1',
        tags: [],
        title: 'Sprint Planning',
        content: 'Let me review the sprint goals',
      });
      expect(domains).toContain('work');
    });

    it('assigns multiple domains when both match', () => {
      const engine = createClusteringEngine({
        neo4j,
        eventBus,
        embeddingEngine,
        knowledgeStore: store,
        domainConfig: testDomains,
      });
      const domains = engine.classifyDomains({
        id: 'b1',
        tags: ['health'],
        title: 'Workplace Ergonomics',
        content: 'deploy standing desk for better workout routine',
      });
      expect(domains).toContain('health');
      expect(domains).toContain('work');
    });

    it('returns empty when no match', () => {
      const engine = createClusteringEngine({
        neo4j,
        eventBus,
        embeddingEngine,
        knowledgeStore: store,
        domainConfig: testDomains,
      });
      const domains = engine.classifyDomains({
        id: 'b1',
        tags: ['cooking'],
        title: 'My Recipe',
        content: 'Mix ingredients',
      });
      expect(domains).toHaveLength(0);
    });
  });

  describe('assignDomains and getDomains', () => {
    it('stores and retrieves domain assignments', async () => {
      const engine = createClusteringEngine({
        neo4j,
        eventBus,
        embeddingEngine,
        knowledgeStore: store,
        domainConfig: testDomains,
      });
      await engine.start();

      const bubble = await store.insert({
        title: 'Test',
        content: 'Test content',
        tags: ['health'],
      });
      await engine.assignDomains(bubble.id, ['health', 'work']);

      const domains = await engine.getDomains();
      const healthDomain = domains.find((d) => d.name === 'health');
      expect(healthDomain!.bubbleCount).toBe(1);
    });
  });

  describe('hierarchical tag tree', () => {
    it('places domain tags at level 0 on start', async () => {
      const engine = createClusteringEngine({
        neo4j,
        eventBus,
        embeddingEngine,
        knowledgeStore: store,
        domainConfig: testDomains,
      });
      await engine.start();

      const tree = await engine.getTagTree();
      const healthNode = tree.find((n) => n.tag === 'health');
      expect(healthNode).toBeDefined();
      expect(healthNode!.level).toBe(0);
    });

    it('places known domain-associated tags under domain', async () => {
      const engine = createClusteringEngine({
        neo4j,
        eventBus,
        embeddingEngine,
        knowledgeStore: store,
        domainConfig: testDomains,
      });
      await engine.start();

      const bubble = await store.insert({
        title: 'Fitness',
        content: 'Workout tips',
        tags: ['fitness'],
      });
      await engine.placeTagInTree('fitness', bubble.id);

      const tree = await engine.getTagTree();
      const healthNode = tree.find((n) => n.tag === 'health');
      expect(healthNode).toBeDefined();
      const fitnessChild = healthNode!.children.find((c) => c.tag === 'fitness');
      expect(fitnessChild).toBeDefined();
      expect(fitnessChild!.level).toBe(1);
    });
  });

  describe('inter-bubble linking', () => {
    it('creates manual links', async () => {
      const engine = createClusteringEngine({
        neo4j,
        eventBus,
        embeddingEngine,
        knowledgeStore: store,
        domainConfig: testDomains,
      });

      const b1 = await store.insert({ title: 'A', content: '', tags: [] });
      const b2 = await store.insert({ title: 'B', content: '', tags: [] });

      const link = await engine.createLink({
        sourceBubbleId: b1.id,
        targetBubbleId: b2.id,
        relationshipType: 'extends',
      });

      expect(link.relationshipType).toBe('extends');
      expect(link.autoSuggested).toBe(false);
      expect(link.status).toBe('accepted');
    });

    it('getLinksForBubble returns all directions', async () => {
      const engine = createClusteringEngine({
        neo4j,
        eventBus,
        embeddingEngine,
        knowledgeStore: store,
        domainConfig: testDomains,
      });

      const b1 = await store.insert({ title: 'A', content: '', tags: [] });
      const b2 = await store.insert({ title: 'B', content: '', tags: [] });
      const b3 = await store.insert({ title: 'C', content: '', tags: [] });

      await engine.createLink({
        sourceBubbleId: b1.id,
        targetBubbleId: b2.id,
        relationshipType: 'related',
      });
      await engine.createLink({
        sourceBubbleId: b3.id,
        targetBubbleId: b1.id,
        relationshipType: 'supports',
      });

      const links = await engine.getLinksForBubble(b1.id);
      expect(links).toHaveLength(2);
    });

    it('resolveLink changes status', async () => {
      const engine = createClusteringEngine({
        neo4j,
        eventBus,
        embeddingEngine,
        knowledgeStore: store,
        domainConfig: testDomains,
      });

      const b1 = await store.insert({ title: 'A', content: '', tags: [] });
      const b2 = await store.insert({ title: 'B', content: '', tags: [] });

      const link = await engine.createLink({
        sourceBubbleId: b1.id,
        targetBubbleId: b2.id,
        relationshipType: 'related',
      });
      const resolved = await engine.resolveLink(link.id, 'dismiss');
      expect(resolved).toBe(true);
    });
  });

  describe('clustering', () => {
    it('groups similar embeddings into clusters', async () => {
      const engine = createClusteringEngine({
        neo4j,
        eventBus,
        embeddingEngine,
        knowledgeStore: store,
        domainConfig: testDomains,
      });

      const b1 = await store.insert({ title: 'Cluster A', content: 'Same topic', tags: [] });
      const b2 = await store.insert({ title: 'Cluster A', content: 'Same topic', tags: [] });

      await embeddingEngine.generateAndStore(b1.id, 'Same topic cluster');
      await embeddingEngine.generateAndStore(b2.id, 'Same topic cluster');

      const result = await engine.runClustering();
      expect(result.clusterCount).toBeGreaterThanOrEqual(1);
      expect(result.clusteredBubbles).toBeGreaterThanOrEqual(2);

      const clusters = await engine.getClusters();
      expect(clusters.length).toBeGreaterThanOrEqual(1);
      expect(clusters[0].memberCount).toBeGreaterThanOrEqual(2);
    });

    it('deleteCluster removes cluster', async () => {
      const engine = createClusteringEngine({
        neo4j,
        eventBus,
        embeddingEngine,
        knowledgeStore: store,
        domainConfig: testDomains,
      });

      const b1 = await store.insert({ title: 'A', content: '', tags: [] });
      const b2 = await store.insert({ title: 'A', content: '', tags: [] });

      await embeddingEngine.generateAndStore(b1.id, 'Same');
      await embeddingEngine.generateAndStore(b2.id, 'Same');

      await engine.runClustering();
      const clusters = await engine.getClusters();
      if (clusters.length > 0) {
        const deleted = await engine.deleteCluster(clusters[0].id);
        expect(deleted).toBe(true);
        expect(await engine.getClusters()).toHaveLength(clusters.length - 1);
      }
    });
  });

  describe('merge detection', () => {
    it('detects highly similar bubbles', async () => {
      const engine = createClusteringEngine({
        neo4j,
        eventBus,
        embeddingEngine,
        knowledgeStore: store,
        domainConfig: testDomains,
      });

      const b1 = await store.insert({ title: 'Dup', content: '', tags: [] });
      const b2 = await store.insert({ title: 'Dup', content: '', tags: [] });

      await embeddingEngine.generateAndStore(b1.id, 'Identical content for merge detection');
      await embeddingEngine.generateAndStore(b2.id, 'Identical content for merge detection');

      const result = await engine.detectMerges();
      expect(result.mergeCount).toBeGreaterThanOrEqual(1);

      const merges = await engine.getMergeSuggestions('pending');
      expect(merges.length).toBeGreaterThanOrEqual(1);
      expect(merges[0].status).toBe('pending');
    });

    it('resolveMerge changes status', async () => {
      const engine = createClusteringEngine({
        neo4j,
        eventBus,
        embeddingEngine,
        knowledgeStore: store,
        domainConfig: testDomains,
      });

      const b1 = await store.insert({ title: 'Dup', content: '', tags: [] });
      const b2 = await store.insert({ title: 'Dup', content: '', tags: [] });

      await embeddingEngine.generateAndStore(b1.id, 'Same for merge');
      await embeddingEngine.generateAndStore(b2.id, 'Same for merge');

      await engine.detectMerges();
      const merges = await engine.getMergeSuggestions('pending');
      if (merges.length > 0) {
        const resolved = await engine.resolveMerge(merges[0].id, 'dismiss');
        expect(resolved).toBe(true);

        const dismissed = await engine.getMergeSuggestions('dismissed');
        expect(dismissed.some((m) => m.id === merges[0].id)).toBe(true);
      }
    });
  });

  describe('hub detection', () => {
    it('detects bubbles with 10+ accepted links', async () => {
      const engine = createClusteringEngine({
        neo4j,
        eventBus,
        embeddingEngine,
        knowledgeStore: store,
        domainConfig: testDomains,
      });

      const hub = await store.insert({ title: 'Hub', content: '', tags: [] });
      for (let i = 0; i < 12; i++) {
        const b = await store.insert({ title: `Node ${i}`, content: '', tags: [] });
        await engine.createLink({
          sourceBubbleId: hub.id,
          targetBubbleId: b.id,
          relationshipType: 'related',
        });
      }

      const hubs = await engine.detectHubs();
      expect(hubs.some((h) => h.bubbleId === hub.id)).toBe(true);
      const found = hubs.find((h) => h.bubbleId === hub.id);
      expect(found!.linkCount).toBeGreaterThanOrEqual(10);
    });
  });

  describe('event chain integration', () => {
    it('embedding:generated triggers domain assignment', async () => {
      const engine = createClusteringEngine({
        neo4j,
        eventBus,
        embeddingEngine,
        knowledgeStore: store,
        domainConfig: testDomains,
      });
      await engine.start();

      const bubble = await store.insert({
        title: 'New Health',
        content: 'Fitness tips',
        tags: ['fitness'],
      });
      await embeddingEngine.generateAndStore(bubble.id, 'Health fitness workout');

      // Emit embedding:generated manually
      eventBus.emit({
        id: 'test-chain',
        timestamp: Date.now(),
        source: 'test',
        type: 'knowledge:embedding:generated',
        payload: { bubbleId: bubble.id },
      } as RavenEvent);

      await new Promise((r) => setTimeout(r, 200));

      // Check domains were assigned in Neo4j
      const domains = await neo4j.query<{ name: string }>(
        'MATCH (b:Bubble {id: $id})-[:IN_DOMAIN]->(d:Domain) RETURN d.name AS name',
        { id: bubble.id },
      );
      expect(domains.some((d) => d.name === 'health')).toBe(true);
    });
  });
});
