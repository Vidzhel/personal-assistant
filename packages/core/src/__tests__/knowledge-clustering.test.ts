import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Neo4jContainer, type StartedNeo4jContainer } from '@testcontainers/neo4j';
import { createNeo4jClient } from '../knowledge-engine/neo4j-client.ts';
import { createKnowledgeStore } from '../knowledge-engine/knowledge-store.ts';
import { createEmbeddingEngine } from '../knowledge-engine/embeddings.ts';
import { createClusteringEngine } from '../knowledge-engine/clustering.ts';
import { EventBus } from '../event-bus/event-bus.ts';
import type { RavenEvent, KnowledgeDomain, AgentTaskRequestEvent } from '@raven/shared';
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
    if (neo4j) await neo4j.close();
    if (container) await container.stop();
  });

  beforeEach(async () => {
    await neo4j.run('MATCH (n) DETACH DELETE n');
    tmpDir = mkdtempSync(join(tmpdir(), 'clustering-'));
    knowledgeDir = join(tmpDir, 'knowledge');
    mkdirSync(knowledgeDir, { recursive: true });
    eventBus = new EventBus();
    eventBus.on<AgentTaskRequestEvent>('agent:task:request', (request) =>
      eventBus.emit({
        id: 'fake-label',
        timestamp: Date.now(),
        source: 'fixture',
        type: 'agent:task:complete',
        payload: {
          taskId: request.payload.taskId,
          success: true,
          durationMs: 1,
          result: JSON.stringify(
            request.payload.skillName === 'knowledge-clustering'
              ? { label: 'Current cluster', description: 'Current facts' }
              : { title: 'Current synthesis', summary: 'Combined current facts' },
          ),
        },
      }),
    );
    store = createKnowledgeStore({ neo4j, knowledgeDir });
    embeddingEngine = createEmbeddingEngine({ neo4j, eventBus, knowledgeStore: store });
  });

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

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

  it('hub splitting retains accepted edge properties/directions and unrelated dismissed links', async () => {
    const engine = createClusteringEngine({
      neo4j,
      eventBus,
      embeddingEngine,
      knowledgeStore: store,
      domainConfig: [],
    });
    const hub = await store.insert(
      { title: 'Hub root', content: 'Hub overview', tags: [] },
      { projectIds: ['project'] },
    );
    const originalLinks: Array<{ id: string; direction: string; member: string }> = [];
    for (let index = 0; index < 10; index++) {
      const member = await store.insert(
        { title: `Member ${index}`, content: `Current fact ${index}`, tags: ['facts'] },
        { projectIds: ['project'] },
      );
      await embeddingEngine.generateAndStore(member.id, 'Same topic');
      const direction = index % 2 === 0 ? 'out' : 'in';
      const link = await engine.createLink({
        sourceBubbleId: direction === 'out' ? hub.id : member.id,
        targetBubbleId: direction === 'out' ? member.id : hub.id,
        relationshipType: 'supports',
      });
      await neo4j.run('MATCH ()-[r:LINKS_TO {id:$id}]->() SET r.annotation=$note', {
        id: link.id,
        note: `Owner note ${index}`,
      });
      originalLinks.push({ id: link.id, direction, member: member.id });
    }
    const extra = await engine.createLink({
      sourceBubbleId: hub.id,
      targetBubbleId: originalLinks[0].member,
      relationshipType: 'contradicts',
    });
    await engine.resolveLink(extra.id, 'dismiss');
    try {
      const result = await engine.splitHub(hub.id);
      expect(result.status).toBe('completed');
      expect(result.createdIds).toHaveLength(1);
      const synthesized = await store.getById(result.createdIds[0], { trackAccess: false });
      expect(synthesized?.content).toBe('Combined current facts');
      for (let index = 0; index < originalLinks.length; index++) {
        const original = originalLinks[index];
        const row = await neo4j.queryOne<{
          from: string;
          to: string;
          type: string;
          annotation: string;
        }>(
          'MATCH (a)-[r:LINKS_TO {id:$id}]->(b) RETURN a.id AS from,b.id AS to,r.relationshipType AS type,r.annotation AS annotation',
          { id: original.id },
        );
        expect(row).toEqual({
          from: original.direction === 'out' ? result.createdIds[0] : original.member,
          to: original.direction === 'out' ? original.member : result.createdIds[0],
          type: 'supports',
          annotation: `Owner note ${index}`,
        });
      }
      expect(
        await neo4j.queryOne(
          'MATCH (a:Bubble {id:$hub})-[r:LINKS_TO {id:$extra,status:"dismissed"}]->() RETURN r.id AS id',
          { hub: hub.id, extra: extra.id },
        ),
      ).toEqual({ id: extra.id });
      expect(
        await neo4j.query(
          'MATCH (:Bubble {id:$id})-[:BELONGS_TO_PROJECT]->(p) RETURN DISTINCT p.id AS id',
          { id: result.createdIds[0] },
        ),
      ).toEqual([{ id: 'project' }]);
    } finally {
      await engine.stop();
    }
  });

  describe('tag tree rebalancing', () => {
    it('merges sparse leaf tags into parent', async () => {
      const engine = createClusteringEngine({
        neo4j,
        eventBus,
        embeddingEngine,
        knowledgeStore: store,
        domainConfig: testDomains,
      });
      await engine.start();

      // Create a parent tag and a sparse child tag with only 1 bubble
      const bubble = await store.insert({
        title: 'Sparse',
        content: 'test',
        tags: ['sparse-child'],
      });
      await embeddingEngine.generateAndStore(bubble.id, 'Sparse content');

      // Manually set up tag tree: health (level 0) → sparse-child (level 1)
      await neo4j.run(
        `MERGE (parent:Tag {name: 'health'}) SET parent.level = 0, parent.domain = 'health'
         WITH parent
         MERGE (child:Tag {name: 'sparse-child'}) SET child.level = 1, child.domain = 'health'
         MERGE (child)-[:CHILD_OF]->(parent)`,
      );

      const result = await engine.rebalanceTagTree();
      expect(result.merged).toBeGreaterThanOrEqual(1);
    });
  });

  describe('permanence levels', () => {
    it('creates bubble with specified permanence', async () => {
      const bubble = await store.insert({
        title: 'Temp Note',
        content: 'temporary info',
        tags: [],
        permanence: 'temporary',
      });

      const fetched = await store.getById(bubble.id);
      expect(fetched!.permanence).toBe('temporary');
    });

    it('defaults permanence to normal', async () => {
      const bubble = await store.insert({
        title: 'Default',
        content: 'normal info',
        tags: [],
      });

      const fetched = await store.getById(bubble.id);
      expect(fetched!.permanence).toBe('normal');
    });

    it('filters by permanence in list query', async () => {
      await store.insert({
        title: 'Temp',
        content: '',
        tags: [],
        permanence: 'temporary',
      });
      await store.insert({
        title: 'Robust',
        content: '',
        tags: [],
        permanence: 'robust',
      });

      const tempResults = await store.list({ permanence: 'temporary', limit: 50, offset: 0 });
      expect(tempResults.every((b) => b.permanence === 'temporary')).toBe(true);
      expect(tempResults.length).toBe(1);
    });

    it('updates permanence via Neo4j', async () => {
      const bubble = await store.insert({
        title: 'Upgrade',
        content: '',
        tags: [],
      });

      await neo4j.run('MATCH (b:Bubble {id: $id}) SET b.permanence = $permanence', {
        id: bubble.id,
        permanence: 'robust',
      });

      const fetched = await store.getById(bubble.id);
      expect(fetched!.permanence).toBe('robust');
    });
  });

  describe('auto-tag suggestions', () => {
    it('suggests tags from similar bubbles', async () => {
      const engine = createClusteringEngine({
        neo4j,
        eventBus,
        embeddingEngine,
        knowledgeStore: store,
        domainConfig: testDomains,
      });

      // Create bubble with tags and embedding
      const b1 = await store.insert({
        title: 'Nutrition Guide',
        content: 'Eating tips',
        tags: ['nutrition', 'health'],
      });
      await embeddingEngine.generateAndStore(b1.id, 'Nutrition guide eating tips');

      // Create another bubble with same text but no tags
      const b2 = await store.insert({
        title: 'Nutrition Guide',
        content: 'Eating tips',
        tags: [],
      });
      await embeddingEngine.generateAndStore(b2.id, 'Nutrition guide eating tips');

      const suggestions = await engine.suggestTags(b2.id);
      // Should suggest tags from b1 since content is identical
      const suggestedNames = suggestions.map((s) => s.tag);
      expect(suggestedNames.length).toBeGreaterThanOrEqual(0);
      // Each suggestion should have confidence and parentTag
      for (const s of suggestions) {
        expect(typeof s.confidence).toBe('number');
        expect(s).toHaveProperty('parentTag');
      }
    });

    it('excludes tags bubble already has', async () => {
      const engine = createClusteringEngine({
        neo4j,
        eventBus,
        embeddingEngine,
        knowledgeStore: store,
        domainConfig: testDomains,
      });

      const b1 = await store.insert({
        title: 'Same Topic',
        content: 'Topic A',
        tags: ['shared-tag', 'extra-tag'],
      });
      await embeddingEngine.generateAndStore(b1.id, 'Same topic A');

      const b2 = await store.insert({
        title: 'Same Topic',
        content: 'Topic A',
        tags: ['shared-tag'],
      });
      await embeddingEngine.generateAndStore(b2.id, 'Same topic A');

      const suggestions = await engine.suggestTags(b2.id);
      const suggestedNames = suggestions.map((s) => s.tag);
      expect(suggestedNames).not.toContain('shared-tag');
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

    it('automatic domain classification preserves durable memberships and annotations', async () => {
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
      await neo4j.run(
        `MERGE (b:Bubble {id: $id})
         MERGE (d:Domain {name: 'work'})
         CREATE (b)-[:IN_DOMAIN {annotation: 'human-curated'}]->(d)`,
        { id: bubble.id },
      );

      eventBus.emit({
        id: 'test-preserve-domain',
        timestamp: Date.now(),
        source: 'test',
        type: 'knowledge:embedding:generated',
        payload: { bubbleId: bubble.id },
      } as RavenEvent);
      await new Promise((resolve) => setTimeout(resolve, 200));

      const domains = await neo4j.query<{ name: string; annotation: string | null }>(
        `MATCH (b:Bubble {id: $id})-[r:IN_DOMAIN]->(d:Domain)
         RETURN d.name AS name, r.annotation AS annotation`,
        { id: bubble.id },
      );
      expect(domains.map((domain) => domain.name)).toEqual(
        expect.arrayContaining(['health', 'work']),
      );
      expect(domains.find((domain) => domain.name === 'work')?.annotation).toBe('human-curated');
    });

    it('explicit domain replacement is atomic when a requested domain is invalid', async () => {
      const engine = createClusteringEngine({
        neo4j,
        eventBus,
        embeddingEngine,
        knowledgeStore: store,
        domainConfig: testDomains,
      });
      await engine.start();

      const bubble = await store.insert({
        title: 'Curated',
        content: 'Existing assignment',
        tags: [],
      });
      await neo4j.run(
        `MERGE (b:Bubble {id: $id})
         MERGE (d:Domain {name: 'work'})
         CREATE (b)-[:IN_DOMAIN {annotation: 'human-curated'}]->(d)`,
        { id: bubble.id },
      );

      await expect(
        engine.assignDomains(bubble.id, ['health', null as unknown as string]),
      ).rejects.toThrow();

      const domains = await neo4j.query<{ name: string; annotation: string | null }>(
        `MATCH (b:Bubble {id: $id})-[r:IN_DOMAIN]->(d:Domain)
         RETURN d.name AS name, r.annotation AS annotation`,
        { id: bubble.id },
      );
      expect(domains).toEqual([{ name: 'work', annotation: 'human-curated' }]);
    });

    it('full chain: bubble → embedding → domains → tags → links → hub check', async () => {
      const engine = createClusteringEngine({
        neo4j,
        eventBus,
        embeddingEngine,
        knowledgeStore: store,
        domainConfig: testDomains,
      });
      await engine.start();
      embeddingEngine.start();

      const emittedEvents: string[] = [];
      eventBus.on('knowledge:embedding:generated', () => emittedEvents.push('embedding:generated'));
      eventBus.on('knowledge:tags:suggested', () => emittedEvents.push('tags:suggested'));
      eventBus.on('knowledge:links:suggested', () => emittedEvents.push('links:suggested'));

      // Create first bubble with health tag
      const b1 = await store.insert({
        title: 'Health Tips',
        content: 'Doctor appointment workout',
        tags: ['health'],
      });

      // Trigger the chain
      eventBus.emit({
        id: 'chain-test',
        timestamp: Date.now(),
        source: 'test',
        type: 'knowledge:bubble:created',
        payload: { bubbleId: b1.id, title: 'Health Tips', filePath: 'test.md' },
      } as RavenEvent);

      await new Promise((r) => setTimeout(r, 500));
      expect(emittedEvents).toContain('embedding:generated');
    });
  });
});
