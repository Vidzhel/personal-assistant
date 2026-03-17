import { generateId, type KnowledgeLink } from '@raven/shared';
import type { Neo4jClient } from './neo4j-client.ts';
import type { EmbeddingEngine } from './embeddings.ts';

const LINK_SIMILARITY_THRESHOLD = 0.7;
const TOP_K_LINK_SUGGESTIONS = 5;
// For the link-vs-tag decision, only count neighbors with strong similarity (> 0.85).
// This avoids suppressing link suggestions when marginally similar bubbles inflate the count.
const LINK_VS_TAG_SIMILARITY_THRESHOLD = 0.85;
const LINK_VS_TAG_COUNT_THRESHOLD = 2; // 2+ strongly similar neighbors = 3+ bubbles sharing concept → tag territory

export interface LinkEngine {
  suggestLinks: (bubbleId: string) => Promise<KnowledgeLink[]>;
  createLink: (link: {
    sourceBubbleId: string;
    targetBubbleId: string;
    relationshipType: string;
    confidence?: number | null;
  }) => Promise<KnowledgeLink>;
  getLinksForBubble: (bubbleId: string) => Promise<KnowledgeLink[]>;
  resolveLink: (linkId: string, action: 'accept' | 'dismiss') => Promise<boolean>;
  createLinkInternal: (params: {
    sourceBubbleId: string;
    targetBubbleId: string;
    relationshipType: string;
    confidence?: number | null;
    autoSuggested: boolean;
    status: string;
  }) => Promise<KnowledgeLink>;
}

interface LinkDeps {
  neo4j: Neo4jClient;
  embeddingEngine: EmbeddingEngine;
}

interface LinkRelProps {
  id: string;
  relationshipType: string;
  confidence: number | null;
  autoSuggested: boolean;
  status: string;
  createdAt: string;
}

// eslint-disable-next-line max-lines-per-function -- factory function for link engine
export function createLinkEngine(deps: LinkDeps): LinkEngine {
  const { neo4j, embeddingEngine } = deps;

  async function createLinkInternal(params: {
    sourceBubbleId: string;
    targetBubbleId: string;
    relationshipType: string;
    confidence?: number | null;
    autoSuggested: boolean;
    status: string;
  }): Promise<KnowledgeLink> {
    const id = generateId();
    const now = new Date().toISOString();
    await neo4j.run(
      `MATCH (source:Bubble {id: $sourceId}), (target:Bubble {id: $targetId})
       CREATE (source)-[:LINKS_TO {
         id: $id, relationshipType: $relType,
         confidence: $confidence, autoSuggested: $autoSuggested,
         status: $status, createdAt: $createdAt
       }]->(target)`,
      {
        sourceId: params.sourceBubbleId,
        targetId: params.targetBubbleId,
        id,
        relType: params.relationshipType,
        confidence: params.confidence ?? null,
        autoSuggested: params.autoSuggested,
        status: params.status,
        createdAt: now,
      },
    );
    return {
      id,
      sourceBubbleId: params.sourceBubbleId,
      targetBubbleId: params.targetBubbleId,
      relationshipType: params.relationshipType,
      confidence: params.confidence ?? null,
      autoSuggested: params.autoSuggested,
      status: params.status,
      createdAt: now,
    };
  }

  async function createLink(params: {
    sourceBubbleId: string;
    targetBubbleId: string;
    relationshipType: string;
    confidence?: number | null;
  }): Promise<KnowledgeLink> {
    return createLinkInternal({
      ...params,
      autoSuggested: false,
      status: 'accepted',
    });
  }

  async function suggestLinks(bubbleId: string): Promise<KnowledgeLink[]> {
    const embedding = await embeddingEngine.getEmbedding(bubbleId);
    if (!embedding) return [];

    const similar = await embeddingEngine.findSimilar(embedding, {
      limit: TOP_K_LINK_SUGGESTIONS,
      threshold: LINK_SIMILARITY_THRESHOLD,
      excludeIds: [bubbleId],
    });

    // Link vs tag heuristic: count only strongly similar neighbors (> 0.85).
    // If 3+ bubbles share a concept (2+ strongly similar neighbors), skip link suggestions —
    // the tag suggestion pipeline handles shared concepts. Links are for specific
    // relationships between exactly 2 bubbles.
    const strongNeighborCount = similar.filter(
      (s) => s.similarity >= LINK_VS_TAG_SIMILARITY_THRESHOLD,
    ).length;
    if (strongNeighborCount >= LINK_VS_TAG_COUNT_THRESHOLD) return [];

    const links: KnowledgeLink[] = [];
    for (const s of similar) {
      // Check if link already exists in either direction
      const existing = await neo4j.queryOne<{ id: string }>(
        `MATCH (a:Bubble {id: $a})-[r:LINKS_TO]-(b:Bubble {id: $b})
         RETURN r.id AS id LIMIT 1`,
        { a: bubbleId, b: s.bubbleId },
      );
      if (existing) continue;

      const link = await createLinkInternal({
        sourceBubbleId: bubbleId,
        targetBubbleId: s.bubbleId,
        relationshipType: 'related',
        confidence: s.similarity,
        autoSuggested: true,
        status: 'suggested',
      });
      links.push(link);
    }
    return links;
  }

  async function getLinksForBubble(bubbleId: string): Promise<KnowledgeLink[]> {
    const rows = await neo4j.query<{
      sourceId: string;
      targetId: string;
      props: LinkRelProps;
    }>(
      `MATCH (a:Bubble)-[r:LINKS_TO]->(b:Bubble)
       WHERE a.id = $id OR b.id = $id
       RETURN a.id AS sourceId, b.id AS targetId,
              r {.id, .relationshipType, .confidence, .autoSuggested, .status, .createdAt} AS props`,
      { id: bubbleId },
    );
    return rows.map((r) => ({
      id: r.props.id,
      sourceBubbleId: r.sourceId,
      targetBubbleId: r.targetId,
      relationshipType: r.props.relationshipType,
      confidence: r.props.confidence,
      autoSuggested: r.props.autoSuggested,
      status: r.props.status,
      createdAt: r.props.createdAt,
    }));
  }

  async function resolveLink(linkId: string, action: 'accept' | 'dismiss'): Promise<boolean> {
    const newStatus = action === 'accept' ? 'accepted' : 'dismissed';
    const result = await neo4j.run(
      `MATCH ()-[r:LINKS_TO {id: $linkId}]->()
       SET r.status = $status
       RETURN r.id AS id`,
      { linkId, status: newStatus },
    );
    return result.records.length > 0;
  }

  return { suggestLinks, createLink, getLinksForBubble, resolveLink, createLinkInternal };
}
