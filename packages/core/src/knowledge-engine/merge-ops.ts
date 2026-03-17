import {
  generateId,
  createLogger,
  type KnowledgeMergeSuggestion,
  type RavenEvent,
} from '@raven/shared';
import type { Neo4jClient } from './neo4j-client.ts';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { EmbeddingEngine } from './embeddings.ts';

const log = createLogger('merge-ops');

const MERGE_SIMILARITY_THRESHOLD = 0.9;
const COSINE_PRECISION = 3;
// Max candidates to check per bubble via vector index — keeps merge detection O(n) not O(n^2)
const MERGE_CANDIDATES_PER_BUBBLE = 5;

export interface MergeEngine {
  detectMerges: () => Promise<{ mergeCount: number }>;
  getMergeSuggestions: (status?: string) => Promise<KnowledgeMergeSuggestion[]>;
  resolveMerge: (mergeId: string, resolution: 'accept' | 'dismiss') => Promise<boolean>;
}

interface MergeDeps {
  neo4j: Neo4jClient;
  eventBus: EventBus;
  embeddingEngine: EmbeddingEngine;
}

// eslint-disable-next-line max-lines-per-function -- factory function for merge engine
export function createMergeEngine(deps: MergeDeps): MergeEngine {
  const { neo4j, eventBus, embeddingEngine } = deps;

  // eslint-disable-next-line max-lines-per-function -- merge detection with vector index queries
  async function detectMerges(): Promise<{ mergeCount: number }> {
    // Use vector index for approximate nearest neighbor search per bubble — O(n) not O(n^2).
    // For each bubble with an embedding, find its closest neighbors above the merge threshold.
    const allBubbleIds = await neo4j.query<{ bubbleId: string }>(
      `MATCH (b:Bubble) WHERE b.embedding IS NOT NULL RETURN b.id AS bubbleId`,
    );
    let mergeCount = 0;
    const seen = new Set<string>();

    for (const { bubbleId } of allBubbleIds) {
      const embedding = await embeddingEngine.getEmbedding(bubbleId);
      if (!embedding) continue;

      const similar = await embeddingEngine.findSimilar(embedding, {
        limit: MERGE_CANDIDATES_PER_BUBBLE,
        threshold: MERGE_SIMILARITY_THRESHOLD,
        excludeIds: [bubbleId],
      });

      for (const s of similar) {
        // Deduplicate pairs (A,B) vs (B,A)
        const pairKey = [bubbleId, s.bubbleId].sort().join(':');
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);

        // Check if already suggested
        const existing = await neo4j.queryOne<{ id: string }>(
          `MATCH (a:Bubble {id: $a})-[r:MERGE_CANDIDATE]-(b:Bubble {id: $b})
           RETURN r.id AS id LIMIT 1`,
          { a: bubbleId, b: s.bubbleId },
        );
        if (existing) continue;

        const id = generateId();
        const now = new Date().toISOString();
        await neo4j.run(
          `MATCH (a:Bubble {id: $aId}), (b:Bubble {id: $bId})
           CREATE (a)-[:MERGE_CANDIDATE {
             id: $id, overlapReason: $reason,
             confidence: $confidence, status: 'pending',
             createdAt: $now, resolvedAt: null
           }]->(b)`,
          {
            aId: bubbleId,
            bId: s.bubbleId,
            id,
            reason: `Cosine similarity: ${s.similarity.toFixed(COSINE_PRECISION)}`,
            confidence: s.similarity,
            now,
          },
        );
        mergeCount++;
      }
    }

    if (mergeCount > 0) {
      eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: 'clustering',
        type: 'knowledge:merge:detected',
        payload: { mergeCount },
      } as RavenEvent);
    }

    log.info(`Merge detection: ${mergeCount} new suggestions`);
    return { mergeCount };
  }

  async function getMergeSuggestions(status?: string): Promise<KnowledgeMergeSuggestion[]> {
    const cypher = status
      ? `MATCH (a:Bubble)-[r:MERGE_CANDIDATE {status: $status}]->(b:Bubble)
         RETURN r.id AS id, a.id AS bubbleId1, b.id AS bubbleId2,
                r.overlapReason AS overlapReason, r.confidence AS confidence,
                r.status AS status, r.createdAt AS createdAt, r.resolvedAt AS resolvedAt
         ORDER BY r.confidence DESC`
      : `MATCH (a:Bubble)-[r:MERGE_CANDIDATE]->(b:Bubble)
         RETURN r.id AS id, a.id AS bubbleId1, b.id AS bubbleId2,
                r.overlapReason AS overlapReason, r.confidence AS confidence,
                r.status AS status, r.createdAt AS createdAt, r.resolvedAt AS resolvedAt
         ORDER BY r.confidence DESC`;

    return neo4j.query<KnowledgeMergeSuggestion>(cypher, status ? { status } : {});
  }

  async function resolveMerge(mergeId: string, resolution: 'accept' | 'dismiss'): Promise<boolean> {
    const newStatus = resolution === 'accept' ? 'accepted' : 'dismissed';
    const now = new Date().toISOString();
    const result = await neo4j.run(
      `MATCH ()-[r:MERGE_CANDIDATE {id: $mergeId}]->()
       SET r.status = $status, r.resolvedAt = $now
       RETURN r.id AS id`,
      { mergeId, status: newStatus, now },
    );
    return result.records.length > 0;
  }

  return { detectMerges, getMergeSuggestions, resolveMerge };
}
