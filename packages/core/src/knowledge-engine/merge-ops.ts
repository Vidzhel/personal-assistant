import {
  generateId,
  createLogger,
  type KnowledgeMergeSuggestion,
  type RavenEvent,
} from '@raven/shared';
import type { Neo4jClient } from './neo4j-client.ts';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { EmbeddingEngine } from './embeddings.ts';
import { cosineSimilarity } from './embeddings.ts';

const log = createLogger('merge-ops');

const MERGE_SIMILARITY_THRESHOLD = 0.9;
const COSINE_PRECISION = 3;

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

  async function detectMerges(): Promise<{ mergeCount: number }> {
    const allEmbeddings = await embeddingEngine.getAllEmbeddings();
    let mergeCount = 0;

    for (let i = 0; i < allEmbeddings.length; i++) {
      for (let j = i + 1; j < allEmbeddings.length; j++) {
        const sim = cosineSimilarity(allEmbeddings[i].embedding, allEmbeddings[j].embedding);
        if (sim > MERGE_SIMILARITY_THRESHOLD) {
          // Check if already suggested
          const existing = await neo4j.queryOne<{ id: string }>(
            `MATCH (a:Bubble {id: $a})-[r:MERGE_CANDIDATE]-(b:Bubble {id: $b})
             RETURN r.id AS id LIMIT 1`,
            { a: allEmbeddings[i].bubbleId, b: allEmbeddings[j].bubbleId },
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
              aId: allEmbeddings[i].bubbleId,
              bId: allEmbeddings[j].bubbleId,
              id,
              reason: `Cosine similarity: ${sim.toFixed(COSINE_PRECISION)}`,
              confidence: sim,
              now,
            },
          );
          mergeCount++;
        }
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
