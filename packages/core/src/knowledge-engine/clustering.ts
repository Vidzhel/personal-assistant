import {
  generateId,
  createLogger,
  type KnowledgeDomain,
  type RavenEvent,
  type KnowledgeLink,
  type KnowledgeCluster,
  type KnowledgeMergeSuggestion,
  type TagTreeNode,
} from '@raven/shared';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { EmbeddingEngine } from './embeddings.ts';
import type { Neo4jClient } from './neo4j-client.ts';
import type { KnowledgeStore } from './knowledge-store.ts';
import { createTagTreeEngine, type TagTreeEngine } from './tag-tree.ts';
import { createLinkEngine, type LinkEngine } from './link-ops.ts';
import { createHubEngine, type HubEngine } from './hub-ops.ts';
import { createClusteringOps, type ClusteringOps } from './clustering-ops.ts';
import { createMergeEngine, type MergeEngine } from './merge-ops.ts';

const log = createLogger('clustering');

const TOP_K_SIMILAR = 5;
const TAG_SIMILARITY_THRESHOLD = 0.3;
const HUB_LINK_THRESHOLD = 10;

export interface ClusteringEngine {
  classifyDomains: (bubble: {
    id: string;
    tags: string[];
    title: string;
    content: string;
  }) => string[];
  assignDomains: (bubbleId: string, domains: string[]) => Promise<void>;
  getDomains: () => Promise<Array<{ name: string; bubbleCount: number }>>;
  getTagTree: () => Promise<TagTreeNode[]>;
  placeTagInTree: (tag: string, bubbleId: string) => Promise<void>;
  rebalanceTagTree: () => Promise<{ merged: number; restructured: number }>;
  suggestLinks: (bubbleId: string) => Promise<KnowledgeLink[]>;
  getLinksForBubble: (bubbleId: string) => Promise<KnowledgeLink[]>;
  createLink: (link: {
    sourceBubbleId: string;
    targetBubbleId: string;
    relationshipType: string;
    confidence?: number | null;
  }) => Promise<KnowledgeLink>;
  resolveLink: (linkId: string, action: 'accept' | 'dismiss') => Promise<boolean>;
  detectHubs: () => Promise<Array<{ bubbleId: string; linkCount: number }>>;
  splitHub: (hubBubbleId: string) => Promise<void>;
  runClustering: () => Promise<{ clusterCount: number; clusteredBubbles: number }>;
  getClusters: () => Promise<KnowledgeCluster[]>;
  getClusterMembers: (clusterId: string) => Promise<string[]>;
  deleteCluster: (clusterId: string) => Promise<boolean>;
  detectMerges: () => Promise<{ mergeCount: number }>;
  getMergeSuggestions: (status?: string) => Promise<KnowledgeMergeSuggestion[]>;
  resolveMerge: (mergeId: string, resolution: 'accept' | 'dismiss') => Promise<boolean>;
  suggestTags: (
    bubbleId: string,
  ) => Promise<Array<{ tag: string; confidence: number; parentTag: string | null }>>;
  start: () => Promise<void>;
}

interface ClusteringDeps {
  neo4j: Neo4jClient;
  eventBus: EventBus;
  embeddingEngine: EmbeddingEngine;
  knowledgeStore: KnowledgeStore;
  domainConfig: KnowledgeDomain[];
}

// eslint-disable-next-line max-lines-per-function -- facade composing sub-engines
export function createClusteringEngine(deps: ClusteringDeps): ClusteringEngine {
  const { neo4j, eventBus, embeddingEngine, knowledgeStore, domainConfig } = deps;

  // Create sub-engines
  const tagTree: TagTreeEngine = createTagTreeEngine({ neo4j, embeddingEngine, domainConfig });
  const linkEngine: LinkEngine = createLinkEngine({ neo4j, embeddingEngine });
  const hubEngine: HubEngine = createHubEngine({
    neo4j,
    eventBus,
    embeddingEngine,
    knowledgeStore,
    linkEngine,
  });
  const clusteringOps: ClusteringOps = createClusteringOps({ neo4j, eventBus, embeddingEngine });
  const mergeEngine: MergeEngine = createMergeEngine({ neo4j, eventBus, embeddingEngine });

  // --- Domain classification ---
  function classifyDomains(bubble: {
    id: string;
    tags: string[];
    title: string;
    content: string;
  }): string[] {
    const matched: string[] = [];
    const lowerContent = (bubble.title + ' ' + bubble.content).toLowerCase();

    for (const domain of domainConfig) {
      const tagMatch = bubble.tags.some((t) => domain.rules.tags.includes(t.toLowerCase()));
      const keywordMatch = domain.rules.keywords.some((kw) =>
        lowerContent.includes(kw.toLowerCase()),
      );
      if (tagMatch || keywordMatch) {
        matched.push(domain.name);
      }
    }
    return matched;
  }

  async function assignDomains(bubbleId: string, domains: string[]): Promise<void> {
    // Remove existing domain relationships
    await neo4j.run(`MATCH (b:Bubble {id: $bubbleId})-[r:IN_DOMAIN]->() DELETE r`, { bubbleId });
    // Create new ones
    for (const domain of domains) {
      await neo4j.run(
        `MERGE (d:Domain {name: $domain})
         WITH d
         MATCH (b:Bubble {id: $bubbleId})
         CREATE (b)-[:IN_DOMAIN]->(d)`,
        { domain, bubbleId },
      );
    }
  }

  async function getDomains(): Promise<Array<{ name: string; bubbleCount: number }>> {
    const rows = await neo4j.query<{ domain: string; count: number }>(
      `MATCH (d:Domain)
       OPTIONAL MATCH (b:Bubble)-[:IN_DOMAIN]->(d)
       RETURN d.name AS domain, count(b) AS count`,
    );
    return domainConfig.map((d) => ({
      name: d.name,
      bubbleCount: rows.find((r) => r.domain === d.name)?.count ?? 0,
    }));
  }

  // --- Auto-tag suggestions ---
  async function suggestTags(
    bubbleId: string,
  ): Promise<Array<{ tag: string; confidence: number; parentTag: string | null }>> {
    const embedding = await embeddingEngine.getEmbedding(bubbleId);
    if (!embedding) return [];

    const similar = await embeddingEngine.findSimilar(embedding, {
      limit: TOP_K_SIMILAR,
      threshold: TAG_SIMILARITY_THRESHOLD,
      excludeIds: [bubbleId],
    });

    // Collect tags from similar bubbles, weighted by similarity
    const tagScores = new Map<string, number>();
    for (const s of similar) {
      const tags = await neo4j.query<{ name: string }>(
        `MATCH (b:Bubble {id: $bubbleId})-[:HAS_TAG]->(t:Tag) RETURN t.name AS name`,
        { bubbleId: s.bubbleId },
      );
      for (const t of tags) {
        tagScores.set(t.name, (tagScores.get(t.name) ?? 0) + s.similarity);
      }
    }

    // Exclude tags the bubble already has
    const existingTags = await neo4j.query<{ name: string }>(
      `MATCH (b:Bubble {id: $bubbleId})-[:HAS_TAG]->(t:Tag) RETURN t.name AS name`,
      { bubbleId },
    );
    const existingSet = new Set(existingTags.map((t) => t.name));

    const suggestions: Array<{ tag: string; confidence: number; parentTag: string | null }> = [];

    for (const [tag, score] of tagScores.entries()) {
      if (existingSet.has(tag)) continue;
      const treeEntry = await neo4j.queryOne<{ parentName: string | null }>(
        `MATCH (t:Tag {name: $tag})
         OPTIONAL MATCH (t)-[:CHILD_OF]->(parent:Tag)
         RETURN parent.name AS parentName`,
        { tag },
      );
      suggestions.push({
        tag,
        confidence: Math.min(score / similar.length, 1),
        parentTag: treeEntry?.parentName ?? null,
      });
    }

    suggestions.sort((a, b) => b.confidence - a.confidence);
    return suggestions.slice(0, TOP_K_SIMILAR);
  }

  // --- Event-driven processing chain ---
  // eslint-disable-next-line max-lines-per-function -- event chain processing runs multiple operations sequentially
  async function handleEmbeddingGenerated(event: RavenEvent): Promise<void> {
    if (event.type !== 'knowledge:embedding:generated') return;
    const { bubbleId } = event.payload;

    try {
      // Get bubble info for domain classification
      const bubbleInfo = await neo4j.queryOne<{
        title: string;
        contentPreview: string | null;
      }>(
        `MATCH (b:Bubble {id: $bubbleId})
         RETURN b.title AS title, b.contentPreview AS contentPreview`,
        { bubbleId },
      );
      if (!bubbleInfo) return;

      const tagRows = await neo4j.query<{ name: string }>(
        `MATCH (b:Bubble {id: $bubbleId})-[:HAS_TAG]->(t:Tag) RETURN t.name AS name`,
        { bubbleId },
      );
      const tags = tagRows.map((r) => r.name);

      // Classify domains
      const domains = classifyDomains({
        id: bubbleId,
        tags,
        title: bubbleInfo.title,
        content: bubbleInfo.contentPreview ?? '',
      });
      await assignDomains(bubbleId, domains);

      // Place tags in tree
      for (const tag of tags) {
        await tagTree.placeTagInTree(tag, bubbleId);
      }

      // Suggest links
      const linkSuggestions = await linkEngine.suggestLinks(bubbleId);
      if (linkSuggestions.length > 0) {
        eventBus.emit({
          id: generateId(),
          timestamp: Date.now(),
          source: 'clustering',
          type: 'knowledge:links:suggested',
          payload: {
            bubbleId,
            links: linkSuggestions.map((l) => ({
              targetBubbleId: l.sourceBubbleId === bubbleId ? l.targetBubbleId : l.sourceBubbleId,
              confidence: l.confidence ?? 0,
              relationshipType: l.relationshipType,
            })),
          },
        } as RavenEvent);
      }

      // Suggest tags
      const tagSuggestions = await suggestTags(bubbleId);
      if (tagSuggestions.length > 0) {
        eventBus.emit({
          id: generateId(),
          timestamp: Date.now(),
          source: 'clustering',
          type: 'knowledge:tags:suggested',
          payload: { bubbleId, suggestedTags: tagSuggestions },
        } as RavenEvent);
      }

      // Check hub status
      const hubLinks = await linkEngine.getLinksForBubble(bubbleId);
      const acceptedLinks = hubLinks.filter((l) => l.status === 'accepted');
      if (acceptedLinks.length >= HUB_LINK_THRESHOLD) {
        eventBus.emit({
          id: generateId(),
          timestamp: Date.now(),
          source: 'clustering',
          type: 'knowledge:hub:detected',
          payload: { bubbleId, linkCount: acceptedLinks.length },
        } as RavenEvent);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Error processing embedding for bubble ${bubbleId}: ${msg}`);
    }
  }

  async function start(): Promise<void> {
    eventBus.on('knowledge:embedding:generated', (event: RavenEvent) => {
      handleEmbeddingGenerated(event);
    });
    // Ensure domain tags are level-0 entries
    await tagTree.ensureDomainRoots();
    // Ensure domain nodes exist
    for (const domain of domainConfig) {
      await neo4j.run(`MERGE (d:Domain {name: $name}) SET d.description = $description`, {
        name: domain.name,
        description: domain.description,
      });
    }
    log.info('Clustering engine started — listening for knowledge:embedding:generated events');
  }

  return {
    classifyDomains,
    assignDomains,
    getDomains,
    getTagTree: tagTree.getTagTree,
    placeTagInTree: tagTree.placeTagInTree,
    rebalanceTagTree: tagTree.rebalanceTagTree,
    suggestLinks: linkEngine.suggestLinks,
    getLinksForBubble: linkEngine.getLinksForBubble,
    createLink: linkEngine.createLink,
    resolveLink: linkEngine.resolveLink,
    detectHubs: hubEngine.detectHubs,
    splitHub: hubEngine.splitHub,
    runClustering: clusteringOps.runClustering,
    getClusters: clusteringOps.getClusters,
    getClusterMembers: clusteringOps.getClusterMembers,
    deleteCluster: clusteringOps.deleteCluster,
    detectMerges: mergeEngine.detectMerges,
    getMergeSuggestions: mergeEngine.getMergeSuggestions,
    resolveMerge: mergeEngine.resolveMerge,
    suggestTags,
    start,
  };
}
