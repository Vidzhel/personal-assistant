import { generateId, createLogger, type KnowledgeCluster, type RavenEvent } from '@raven/shared';
import type { Neo4jClient } from './neo4j-client.ts';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { EmbeddingEngine } from './embeddings.ts';
import { agglomerativeCluster } from './clustering-utils.ts';

const log = createLogger('clustering-ops');

const CLUSTER_SIMILARITY_THRESHOLD = 0.6;

export interface ClusteringOps {
  runClustering: () => Promise<{ clusterCount: number; clusteredBubbles: number }>;
  getClusters: () => Promise<KnowledgeCluster[]>;
  getClusterMembers: (clusterId: string) => Promise<string[]>;
  deleteCluster: (clusterId: string) => Promise<boolean>;
}

interface ClusteringOpsDeps {
  neo4j: Neo4jClient;
  eventBus: EventBus;
  embeddingEngine: EmbeddingEngine;
}

// eslint-disable-next-line max-lines-per-function -- factory function for clustering ops
export function createClusteringOps(deps: ClusteringOpsDeps): ClusteringOps {
  const { neo4j, eventBus, embeddingEngine } = deps;

  async function runClustering(): Promise<{
    clusterCount: number;
    clusteredBubbles: number;
  }> {
    const allEmbeddings = await embeddingEngine.getAllEmbeddings();
    if (allEmbeddings.length === 0) return { clusterCount: 0, clusteredBubbles: 0 };

    const groups = agglomerativeCluster(
      allEmbeddings.map((e) => ({ id: e.bubbleId, embedding: e.embedding })),
      CLUSTER_SIMILARITY_THRESHOLD,
    );

    // Clear existing clusters (idempotent)
    await neo4j.run('MATCH (c:Cluster) DETACH DELETE c');

    let clusteredBubbles = 0;
    const now = new Date().toISOString();

    for (const group of groups) {
      if (group.length < 2) continue;

      const clusterId = generateId();
      const label = `Cluster (${group.length} items)`;

      await neo4j.run(
        `CREATE (c:Cluster {id: $id, label: $label, description: null, createdAt: $now, updatedAt: $now})`,
        { id: clusterId, label, now },
      );

      for (const bubbleId of group) {
        await neo4j.run(
          `MATCH (b:Bubble {id: $bubbleId}), (c:Cluster {id: $clusterId})
           CREATE (b)-[:IN_CLUSTER]->(c)`,
          { bubbleId, clusterId },
        );
      }
      clusteredBubbles += group.length;

      // Request LLM for cluster label
      const taskId = generateId();
      eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: 'clustering',
        type: 'agent:task:request',
        payload: {
          taskId,
          prompt: `Generate a concise label for a knowledge cluster containing ${group.length} items. Bubble IDs: ${group.join(', ')}. Return JSON: {"label": "...", "description": "..."}`,
          skillName: 'knowledge-clustering',
          mcpServers: {},
          priority: 'low',
        },
      } as RavenEvent);
    }

    const clusterCount = groups.filter((g) => g.length >= 2).length;
    log.info(`Clustering complete: ${clusterCount} clusters, ${clusteredBubbles} bubbles`);
    return { clusterCount, clusteredBubbles };
  }

  async function getClusters(): Promise<KnowledgeCluster[]> {
    const rows = await neo4j.query<{
      id: string;
      label: string;
      description: string | null;
      memberCount: number;
      createdAt: string;
      updatedAt: string;
    }>(
      `MATCH (c:Cluster)
       OPTIONAL MATCH (b:Bubble)-[:IN_CLUSTER]->(c)
       RETURN c.id AS id, c.label AS label, c.description AS description,
              count(b) AS memberCount, c.createdAt AS createdAt, c.updatedAt AS updatedAt
       ORDER BY c.createdAt DESC`,
    );
    return rows;
  }

  async function getClusterMembers(clusterId: string): Promise<string[]> {
    const rows = await neo4j.query<{ bubbleId: string }>(
      `MATCH (b:Bubble)-[:IN_CLUSTER]->(c:Cluster {id: $clusterId})
       RETURN b.id AS bubbleId`,
      { clusterId },
    );
    return rows.map((r) => r.bubbleId);
  }

  async function deleteCluster(clusterId: string): Promise<boolean> {
    const result = await neo4j.run(
      `MATCH (c:Cluster {id: $clusterId}) DETACH DELETE c RETURN count(*) AS deleted`,
      { clusterId },
    );
    return result.records.length > 0 && result.records[0].get('deleted').toNumber() > 0;
  }

  return { runClustering, getClusters, getClusterMembers, deleteCluster };
}
