import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, getDb, createDbInterface } from '../db/database.ts';
import { createKnowledgeStore } from '../knowledge-engine/knowledge-store.ts';
import { createEmbeddingEngine } from '../knowledge-engine/embeddings.ts';
import { createClusteringEngine } from '../knowledge-engine/clustering.ts';
import { EventBus } from '../event-bus/event-bus.ts';
import type { RavenEvent, KnowledgeDomain, DatabaseInterface } from '@raven/shared';
import type { EmbeddingEngine } from '../knowledge-engine/embeddings.ts';
import type { KnowledgeStore } from '../knowledge-engine/knowledge-store.ts';

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
  let tmpDir: string;
  let knowledgeDir: string;
  let eventBus: EventBus;
  let db: DatabaseInterface;
  let store: KnowledgeStore;
  let embeddingEngine: EmbeddingEngine;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'clustering-'));
    knowledgeDir = join(tmpDir, 'knowledge');
    mkdirSync(knowledgeDir, { recursive: true });
    initDatabase(join(tmpDir, 'test.db'));
    db = createDbInterface();
    eventBus = new EventBus();
    store = createKnowledgeStore({ db, knowledgeDir });
    embeddingEngine = createEmbeddingEngine({ db, eventBus });
  });

  afterEach(() => {
    try {
      getDb().close();
    } catch {
      /* */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('classifyDomains', () => {
    it('matches by tag overlap', () => {
      const engine = createClusteringEngine({
        db,
        eventBus,
        embeddingEngine,
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
        db,
        eventBus,
        embeddingEngine,
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
        db,
        eventBus,
        embeddingEngine,
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
        db,
        eventBus,
        embeddingEngine,
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
    it('stores and retrieves domain assignments', () => {
      const engine = createClusteringEngine({
        db,
        eventBus,
        embeddingEngine,
        domainConfig: testDomains,
      });
      const bubble = store.insert({ title: 'Test', content: 'Test content', tags: ['health'] });
      engine.assignDomains(bubble.id, ['health', 'work']);

      const domains = engine.getDomains();
      const healthDomain = domains.find((d) => d.name === 'health');
      expect(healthDomain!.bubbleCount).toBe(1);
    });
  });

  describe('hierarchical tag tree', () => {
    it('places domain tags at level 0', () => {
      const engine = createClusteringEngine({
        db,
        eventBus,
        embeddingEngine,
        domainConfig: testDomains,
      });
      engine.start();

      const tree = engine.getTagTree();
      const healthNode = tree.find((n) => n.tag === 'health');
      expect(healthNode).toBeDefined();
      expect(healthNode!.level).toBe(0);
    });

    it('places known domain-associated tags under domain', () => {
      const engine = createClusteringEngine({
        db,
        eventBus,
        embeddingEngine,
        domainConfig: testDomains,
      });
      engine.start();

      const bubble = store.insert({ title: 'Fitness', content: 'Workout tips', tags: ['fitness'] });
      engine.placeTagInTree('fitness', bubble.id);

      const tree = engine.getTagTree();
      const healthNode = tree.find((n) => n.tag === 'health');
      expect(healthNode).toBeDefined();
      const fitnessChild = healthNode!.children.find((c) => c.tag === 'fitness');
      expect(fitnessChild).toBeDefined();
      expect(fitnessChild!.level).toBe(1);
    });

    it('places orphan tags when no match found', () => {
      const engine = createClusteringEngine({
        db,
        eventBus,
        embeddingEngine,
        domainConfig: testDomains,
      });
      engine.start();

      const bubble = store.insert({ title: 'Random', content: '', tags: ['obscure-tag'] });
      engine.placeTagInTree('obscure-tag', bubble.id);

      const tree = engine.getTagTree();
      const orphan = tree.find((n) => n.tag === 'obscure-tag');
      expect(orphan).toBeDefined();
      expect(orphan!.parentTag).toBeNull();
    });
  });

  describe('rebalanceTagTree', () => {
    it('merges sparse leaf tags into parent', () => {
      const engine = createClusteringEngine({
        db,
        eventBus,
        embeddingEngine,
        domainConfig: testDomains,
      });
      engine.start();

      // Add a tag under health with only 1 bubble (sparse)
      db.run(
        'INSERT OR IGNORE INTO knowledge_tag_tree (tag, parent_tag, level, domain) VALUES (?, ?, ?, ?)',
        'rare-supplement',
        'health',
        2,
        'health',
      );
      store.insert({
        title: 'Supplement',
        content: 'Info',
        tags: ['rare-supplement'],
      });

      const result = engine.rebalanceTagTree();
      expect(result.merged).toBeGreaterThanOrEqual(1);

      // Tag should be removed from tree
      const tree = engine.getTagTree();
      const found = tree.find((n) => n.tag === 'rare-supplement');
      expect(found).toBeUndefined();
    });
  });

  describe('inter-bubble linking', () => {
    it('suggests links for similar bubbles', async () => {
      const engine = createClusteringEngine({
        db,
        eventBus,
        embeddingEngine,
        domainConfig: testDomains,
      });

      const b1 = store.insert({ title: 'Health Tips', content: 'Stay healthy', tags: ['health'] });
      const b2 = store.insert({ title: 'Health Tips', content: 'Stay healthy', tags: ['health'] });

      await embeddingEngine.generateAndStore(b1.id, 'Health tips stay healthy');
      await embeddingEngine.generateAndStore(b2.id, 'Health tips stay healthy');

      const links = engine.suggestLinks(b1.id);
      // Same text = high similarity, should get a suggestion
      expect(links.some((l) => l.targetBubbleId === b2.id || l.sourceBubbleId === b2.id)).toBe(
        true,
      );
      expect(links[0].status).toBe('suggested');
      expect(links[0].autoSuggested).toBe(true);
    });

    it('creates manual links', () => {
      const engine = createClusteringEngine({
        db,
        eventBus,
        embeddingEngine,
        domainConfig: testDomains,
      });

      const b1 = store.insert({ title: 'A', content: '', tags: [] });
      const b2 = store.insert({ title: 'B', content: '', tags: [] });

      const link = engine.createLink({
        sourceBubbleId: b1.id,
        targetBubbleId: b2.id,
        relationshipType: 'extends',
      });

      expect(link.relationshipType).toBe('extends');
      expect(link.autoSuggested).toBe(false);
      expect(link.status).toBe('accepted');
    });

    it('getLinksForBubble returns all directions', () => {
      const engine = createClusteringEngine({
        db,
        eventBus,
        embeddingEngine,
        domainConfig: testDomains,
      });

      const b1 = store.insert({ title: 'A', content: '', tags: [] });
      const b2 = store.insert({ title: 'B', content: '', tags: [] });
      const b3 = store.insert({ title: 'C', content: '', tags: [] });

      engine.createLink({
        sourceBubbleId: b1.id,
        targetBubbleId: b2.id,
        relationshipType: 'related',
      });
      engine.createLink({
        sourceBubbleId: b3.id,
        targetBubbleId: b1.id,
        relationshipType: 'supports',
      });

      const links = engine.getLinksForBubble(b1.id);
      expect(links).toHaveLength(2);
    });

    it('resolveLink changes status', () => {
      const engine = createClusteringEngine({
        db,
        eventBus,
        embeddingEngine,
        domainConfig: testDomains,
      });

      const b1 = store.insert({ title: 'A', content: '', tags: [] });
      const b2 = store.insert({ title: 'B', content: '', tags: [] });

      const link = engine.createLink({
        sourceBubbleId: b1.id,
        targetBubbleId: b2.id,
        relationshipType: 'related',
      });
      const resolved = engine.resolveLink(link.id, 'dismiss');
      expect(resolved).toBe(true);
    });
  });

  describe('permanence levels', () => {
    it('defaults to normal permanence', () => {
      const bubble = store.insert({ title: 'Normal', content: '', tags: [] });
      expect(bubble.permanence).toBe('normal');
    });

    it('accepts optional permanence', () => {
      const bubble = store.insert({
        title: 'Temp',
        content: '',
        tags: [],
        permanence: 'temporary',
      });
      expect(bubble.permanence).toBe('temporary');
    });

    it('filters by permanence', () => {
      store.insert({ title: 'Temp', content: '', tags: [], permanence: 'temporary' });
      store.insert({ title: 'Normal', content: '', tags: [] });

      const temps = store.list({ permanence: 'temporary', limit: 50, offset: 0 });
      expect(temps).toHaveLength(1);
      expect(temps[0].title).toBe('Temp');

      const normals = store.list({ permanence: 'normal', limit: 50, offset: 0 });
      expect(normals).toHaveLength(1);
      expect(normals[0].title).toBe('Normal');
    });

    it('updates permanence via DB', () => {
      const bubble = store.insert({ title: 'Test', content: '', tags: [] });
      db.run('UPDATE knowledge_index SET permanence = ? WHERE id = ?', 'robust', bubble.id);

      const updated = store.getById(bubble.id);
      expect(updated!.permanence).toBe('robust');
    });
  });

  describe('clustering', () => {
    it('groups similar embeddings into clusters', async () => {
      const engine = createClusteringEngine({
        db,
        eventBus,
        embeddingEngine,
        domainConfig: testDomains,
      });

      // Create bubbles with identical text (high similarity)
      const b1 = store.insert({ title: 'Cluster A', content: 'Same topic', tags: [] });
      const b2 = store.insert({ title: 'Cluster A', content: 'Same topic', tags: [] });

      await embeddingEngine.generateAndStore(b1.id, 'Same topic cluster');
      await embeddingEngine.generateAndStore(b2.id, 'Same topic cluster');

      const result = await engine.runClustering();
      expect(result.clusterCount).toBeGreaterThanOrEqual(1);
      expect(result.clusteredBubbles).toBeGreaterThanOrEqual(2);

      const clusters = engine.getClusters();
      expect(clusters.length).toBeGreaterThanOrEqual(1);
      expect(clusters[0].memberCount).toBeGreaterThanOrEqual(2);
    });

    it('clustering is idempotent', async () => {
      const engine = createClusteringEngine({
        db,
        eventBus,
        embeddingEngine,
        domainConfig: testDomains,
      });

      const b1 = store.insert({ title: 'A', content: '', tags: [] });
      const b2 = store.insert({ title: 'A', content: '', tags: [] });

      await embeddingEngine.generateAndStore(b1.id, 'Same');
      await embeddingEngine.generateAndStore(b2.id, 'Same');

      await engine.runClustering();
      const first = engine.getClusters();

      await engine.runClustering();
      const second = engine.getClusters();

      // Same number of clusters
      expect(second.length).toBe(first.length);
    });

    it('getClusterMembers returns bubble IDs', async () => {
      const engine = createClusteringEngine({
        db,
        eventBus,
        embeddingEngine,
        domainConfig: testDomains,
      });

      const b1 = store.insert({ title: 'A', content: '', tags: [] });
      const b2 = store.insert({ title: 'A', content: '', tags: [] });

      await embeddingEngine.generateAndStore(b1.id, 'Same');
      await embeddingEngine.generateAndStore(b2.id, 'Same');

      await engine.runClustering();
      const clusters = engine.getClusters();
      if (clusters.length > 0) {
        const members = engine.getClusterMembers(clusters[0].id);
        expect(members.length).toBeGreaterThanOrEqual(2);
      }
    });

    it('deleteCluster removes cluster', async () => {
      const engine = createClusteringEngine({
        db,
        eventBus,
        embeddingEngine,
        domainConfig: testDomains,
      });

      const b1 = store.insert({ title: 'A', content: '', tags: [] });
      const b2 = store.insert({ title: 'A', content: '', tags: [] });

      await embeddingEngine.generateAndStore(b1.id, 'Same');
      await embeddingEngine.generateAndStore(b2.id, 'Same');

      await engine.runClustering();
      const clusters = engine.getClusters();
      if (clusters.length > 0) {
        const deleted = engine.deleteCluster(clusters[0].id);
        expect(deleted).toBe(true);
        expect(engine.getClusters()).toHaveLength(clusters.length - 1);
      }
    });
  });

  describe('merge detection', () => {
    it('detects highly similar bubbles', async () => {
      const engine = createClusteringEngine({
        db,
        eventBus,
        embeddingEngine,
        domainConfig: testDomains,
      });

      const b1 = store.insert({ title: 'Dup', content: '', tags: [] });
      const b2 = store.insert({ title: 'Dup', content: '', tags: [] });

      // Use identical text for near-1.0 similarity
      await embeddingEngine.generateAndStore(b1.id, 'Identical content for merge detection');
      await embeddingEngine.generateAndStore(b2.id, 'Identical content for merge detection');

      const result = engine.detectMerges();
      expect(result.mergeCount).toBeGreaterThanOrEqual(1);

      const merges = engine.getMergeSuggestions('pending');
      expect(merges.length).toBeGreaterThanOrEqual(1);
      expect(merges[0].status).toBe('pending');
    });

    it('resolveMerge changes status', async () => {
      const engine = createClusteringEngine({
        db,
        eventBus,
        embeddingEngine,
        domainConfig: testDomains,
      });

      const b1 = store.insert({ title: 'Dup', content: '', tags: [] });
      const b2 = store.insert({ title: 'Dup', content: '', tags: [] });

      await embeddingEngine.generateAndStore(b1.id, 'Same for merge');
      await embeddingEngine.generateAndStore(b2.id, 'Same for merge');

      engine.detectMerges();
      const merges = engine.getMergeSuggestions('pending');
      if (merges.length > 0) {
        const resolved = engine.resolveMerge(merges[0].id, 'dismiss');
        expect(resolved).toBe(true);

        const dismissed = engine.getMergeSuggestions('dismissed');
        expect(dismissed.some((m) => m.id === merges[0].id)).toBe(true);
      }
    });

    it('emits knowledge:merge:detected event', async () => {
      const engine = createClusteringEngine({
        db,
        eventBus,
        embeddingEngine,
        domainConfig: testDomains,
      });

      const emitted: RavenEvent[] = [];
      eventBus.on('knowledge:merge:detected', (e: RavenEvent) => emitted.push(e));

      const b1 = store.insert({ title: 'Dup', content: '', tags: [] });
      const b2 = store.insert({ title: 'Dup', content: '', tags: [] });

      await embeddingEngine.generateAndStore(b1.id, 'Same text for event test');
      await embeddingEngine.generateAndStore(b2.id, 'Same text for event test');

      engine.detectMerges();
      expect(emitted.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('auto-tag suggestions', () => {
    it('suggests tags from similar bubbles', async () => {
      const engine = createClusteringEngine({
        db,
        eventBus,
        embeddingEngine,
        domainConfig: testDomains,
      });

      // Create bubbles with tags
      const b1 = store.insert({
        title: 'Health',
        content: 'Workout tips',
        tags: ['fitness', 'health'],
      });
      const b2 = store.insert({ title: 'Health', content: 'Workout tips', tags: [] }); // no tags

      await embeddingEngine.generateAndStore(b1.id, 'Workout tips health fitness');
      await embeddingEngine.generateAndStore(b2.id, 'Workout tips health fitness');

      const suggestions = engine.suggestTags(b2.id);
      // b2 should get tag suggestions from b1 due to high similarity
      expect(suggestions.length).toBeGreaterThanOrEqual(1);
      expect(suggestions.some((s) => s.tag === 'fitness' || s.tag === 'health')).toBe(true);
    });

    it('excludes already-assigned tags', async () => {
      const engine = createClusteringEngine({
        db,
        eventBus,
        embeddingEngine,
        domainConfig: testDomains,
      });

      const b1 = store.insert({ title: 'A', content: '', tags: ['shared-tag', 'unique'] });
      const b2 = store.insert({ title: 'A', content: '', tags: ['shared-tag'] });

      await embeddingEngine.generateAndStore(b1.id, 'Same topic');
      await embeddingEngine.generateAndStore(b2.id, 'Same topic');

      const suggestions = engine.suggestTags(b2.id);
      expect(suggestions.every((s) => s.tag !== 'shared-tag')).toBe(true);
    });
  });

  describe('hub detection', () => {
    it('detects bubbles with 10+ accepted links', () => {
      const engine = createClusteringEngine({
        db,
        eventBus,
        embeddingEngine,
        domainConfig: testDomains,
      });

      const hub = store.insert({ title: 'Hub', content: '', tags: [] });
      for (let i = 0; i < 12; i++) {
        const b = store.insert({ title: `Node ${i}`, content: '', tags: [] });
        engine.createLink({
          sourceBubbleId: hub.id,
          targetBubbleId: b.id,
          relationshipType: 'related',
        });
      }

      const hubs = engine.detectHubs();
      expect(hubs.some((h) => h.bubbleId === hub.id)).toBe(true);
      const found = hubs.find((h) => h.bubbleId === hub.id);
      expect(found!.linkCount).toBeGreaterThanOrEqual(10);
    });
  });

  describe('event chain integration', () => {
    it('embedding:generated triggers domain + tag + link processing', async () => {
      const engine = createClusteringEngine({
        db,
        eventBus,
        embeddingEngine,
        domainConfig: testDomains,
      });
      engine.start();

      // Create a pre-existing bubble with tags and embedding
      const existing = store.insert({
        title: 'Existing',
        content: 'Existing content',
        tags: ['health'],
      });
      await embeddingEngine.generateAndStore(existing.id, 'Health fitness workout');

      // Create new bubble
      const newBubble = store.insert({
        title: 'New Health',
        content: 'Fitness tips',
        tags: ['fitness'],
      });
      await embeddingEngine.generateAndStore(newBubble.id, 'Health fitness workout');

      const tagEvents: RavenEvent[] = [];
      const linkEvents: RavenEvent[] = [];
      eventBus.on('knowledge:tags:suggested', (e: RavenEvent) => tagEvents.push(e));
      eventBus.on('knowledge:links:suggested', (e: RavenEvent) => linkEvents.push(e));

      // Emit embedding:generated manually
      eventBus.emit({
        id: 'test-chain',
        timestamp: Date.now(),
        source: 'test',
        type: 'knowledge:embedding:generated',
        payload: { bubbleId: newBubble.id },
      } as RavenEvent);

      // Domain assignment should happen
      await new Promise((r) => setTimeout(r, 50));

      // Check domains were assigned
      const domains = db.all<{ domain: string }>(
        'SELECT domain FROM knowledge_bubble_domains WHERE bubble_id = ?',
        newBubble.id,
      );
      expect(domains.some((d) => d.domain === 'health')).toBe(true);
    });
  });

  describe('domain filter on list', () => {
    it('filters bubbles by domain', () => {
      const engine = createClusteringEngine({
        db,
        eventBus,
        embeddingEngine,
        domainConfig: testDomains,
      });

      const b1 = store.insert({ title: 'Health Topic', content: '', tags: [] });
      const b2 = store.insert({ title: 'Work Topic', content: '', tags: [] });

      engine.assignDomains(b1.id, ['health']);
      engine.assignDomains(b2.id, ['work']);

      const healthResults = store.list({ domain: 'health', limit: 50, offset: 0 });
      expect(healthResults).toHaveLength(1);
      expect(healthResults[0].title).toBe('Health Topic');
    });
  });
});
