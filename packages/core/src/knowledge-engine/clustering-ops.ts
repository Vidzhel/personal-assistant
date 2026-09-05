import { createProcessorLifecycle } from './processor-lifecycle.ts';
import { generateId, createLogger, type KnowledgeCluster, type RavenEvent } from '@raven/shared';
import { z } from 'zod';
import type { Neo4jClient } from './neo4j-client.ts';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { EmbeddingEngine } from './embeddings.ts';
import type { KnowledgeStore } from './knowledge-store.ts';
import { agglomerativeCluster } from './clustering-utils.ts';
import { waitForAgentTask } from './task-completion.ts';
import { readKnowledgeSnapshots, type KnowledgeSnapshot } from './knowledge-snapshots.ts';

const log = createLogger('clustering-ops');
const CLUSTER_SIMILARITY_THRESHOLD = 0.6;
const LABEL_TIMEOUT_MS = 30_000;

export interface ClusteringOps {
  runClustering: () => Promise<{ clusterCount: number; clusteredBubbles: number }>;
  getClusters: () => Promise<KnowledgeCluster[]>;
  getClusterMembers: (clusterId: string) => Promise<string[]>;
  deleteCluster: (clusterId: string) => Promise<boolean>;
  start: () => void;
  stop: () => Promise<void>;
}

interface ClusteringOpsDeps {
  neo4j: Neo4jClient;
  eventBus: EventBus;
  embeddingEngine: EmbeddingEngine;
  knowledgeStore: KnowledgeStore;
}

interface PreparedCluster {
  memberIds: string[];
  promptContent: string;
  snapshots: KnowledgeSnapshot[];
}

interface ClusterLabel {
  label: string;
  description: string;
}

const LabelResultSchema = z
  .object({
    label: z.string().trim().min(1),
    description: z.string().trim().min(1),
  })
  .strict();

// eslint-disable-next-line max-lines-per-function -- factory wires lifecycle and graph collaborators
export function createClusteringOps(deps: ClusteringOpsDeps): ClusteringOps {
  const { eventBus } = deps;
  const lifetime = createProcessorLifecycle(eventBus, 'clustering-ops');
  const neo4j = lifetime.guard(deps.neo4j);
  const embeddingEngine = lifetime.guard(deps.embeddingEngine);
  const knowledgeStore = lifetime.guard(deps.knowledgeStore);
  let started = false;
  let busy = false;

  async function prepareClusters(): Promise<PreparedCluster[]> {
    const embeddings = await embeddingEngine.getAllEmbeddings();
    const groups = agglomerativeCluster(
      embeddings.map((item) => ({ id: item.bubbleId, embedding: item.embedding })),
      CLUSTER_SIMILARITY_THRESHOLD,
    ).filter((group) => group.length >= 2);
    const prepared: PreparedCluster[] = [];
    for (const memberIds of groups) {
      const snapshots = await readKnowledgeSnapshots(knowledgeStore, memberIds);
      prepared.push({
        memberIds,
        promptContent: snapshots
          .map(({ bubble }) => `### ${bubble.title}\n${bubble.content}`)
          .join('\n\n'),
        snapshots,
      });
    }
    return prepared;
  }

  async function labelCluster(group: PreparedCluster): Promise<ClusterLabel> {
    const taskId = generateId();
    const completion = waitForAgentTask({
      eventBus,
      taskId,
      timeoutMs: LABEL_TIMEOUT_MS,
      signal: lifetime.signal,
      dispatch: () => {
        lifetime.emit({
          id: generateId(),
          timestamp: Date.now(),
          source: 'clustering-ops',
          type: 'agent:task:request',
          payload: {
            taskId,
            prompt: `Generate a concise label and description for a knowledge cluster. Member IDs: ${group.memberIds.join(', ')}.\n\nCanonical member Markdown:\n${group.promptContent}\n\nReturn JSON: {"label":"...","description":"..."}`,
            skillName: 'knowledge-clustering',
            mcpServers: {},
            priority: 'low',
          },
        } as RavenEvent);
      },
    });
    const result = await completion;
    if (result.error || !result.result) {
      throw new Error(result.error ?? `Cluster label task ${taskId} returned no result`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(result.result);
    } catch {
      throw new Error(`Cluster label task ${taskId} returned invalid JSON`);
    }
    const parsed = LabelResultSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`Invalid cluster label response: ${parsed.error.message}`);
    return parsed.data;
  }

  async function replaceClusters(groups: PreparedCluster[], labels: ClusterLabel[]): Promise<void> {
    const now = new Date().toISOString();
    await neo4j.withTransaction(async (tx) => {
      const guardedTx = lifetime.guard(tx);
      const memberIds = groups.flatMap((group) => group.memberIds);
      const existing = await guardedTx.run(
        `UNWIND $memberIds AS bubbleId
         OPTIONAL MATCH (b:Bubble {id: bubbleId})
         WITH bubbleId, b
         WHERE b IS NULL
         RETURN collect(bubbleId) AS missing`,
        { memberIds },
      );
      if (existing.records.length > 0) {
        const missing = existing.records[0].get('missing') as string[] | undefined;
        if (missing && missing.length > 0) {
          throw new Error(`Cluster source disappeared: ${missing.join(', ')}`);
        }
      }
      lifetime.assertActive();
      await guardedTx.run('MATCH (c:Cluster) DETACH DELETE c');
      for (let index = 0; index < groups.length; index += 1) {
        const clusterId = generateId();
        await guardedTx.run(
          `CREATE (c:Cluster {id: $id, label: $label, description: $description, createdAt: $now, updatedAt: $now})`,
          { id: clusterId, ...labels[index], now },
        );
        await guardedTx.run(
          `UNWIND $memberIds AS bubbleId
           MATCH (b:Bubble {id: bubbleId}), (c:Cluster {id: $clusterId})
           CREATE (b)-[:IN_CLUSTER]->(c)`,
          { memberIds: groups[index].memberIds, clusterId },
        );
        lifetime.assertActive();
      }
      lifetime.assertActive();
    });
    lifetime.assertActive();
  }

  async function runClustering(): Promise<{
    clusterCount: number;
    clusteredBubbles: number;
  }> {
    if (busy) throw new Error('Clustering is already running');
    busy = true;
    try {
      const groups = await prepareClusters();
      const labels: ClusterLabel[] = [];
      for (const group of groups) labels.push(await labelCluster(group));
      const expected = new Map(
        groups.flatMap((group) =>
          group.snapshots.map((snapshot) => [snapshot.bubble.id, snapshot.revision]),
        ),
      );
      if (expected.size > 0) {
        const current = await readKnowledgeSnapshots(knowledgeStore, [...expected.keys()]);
        if (current.some((snapshot) => expected.get(snapshot.bubble.id) !== snapshot.revision)) {
          throw new Error('Cluster sources changed while labels were generated');
        }
      }
      lifetime.assertActive();
      await replaceClusters(groups, labels);
      const clusteredBubbles = groups.reduce((total, group) => total + group.memberIds.length, 0);
      log.info(`Clustering complete: ${groups.length} clusters, ${clusteredBubbles} bubbles`);
      return { clusterCount: groups.length, clusteredBubbles };
    } finally {
      busy = false;
    }
  }

  async function getClusters(): Promise<KnowledgeCluster[]> {
    return neo4j.query(
      `MATCH (c:Cluster)
       OPTIONAL MATCH (b:Bubble)-[:IN_CLUSTER]->(c)
       RETURN c.id AS id, c.label AS label, c.description AS description,
              count(DISTINCT b) AS memberCount, c.createdAt AS createdAt, c.updatedAt AS updatedAt
       ORDER BY c.createdAt DESC`,
    );
  }

  async function getClusterMembers(clusterId: string): Promise<string[]> {
    const rows = await neo4j.query<{ bubbleId: string }>(
      `MATCH (b:Bubble)-[:IN_CLUSTER]->(c:Cluster {id: $clusterId})
       RETURN DISTINCT b.id AS bubbleId`,
      { clusterId },
    );
    return rows.map((row) => row.bubbleId);
  }

  async function deleteCluster(clusterId: string): Promise<boolean> {
    const result = await neo4j.run(
      `MATCH (c:Cluster {id: $clusterId}) DETACH DELETE c RETURN count(*) AS deleted`,
      { clusterId },
    );
    return result.records.length > 0 && result.records[0].get('deleted').toNumber() > 0;
  }

  function start(): void {
    lifetime.assertActive();
    if (started) return;
    started = true;
  }

  return {
    runClustering: () => lifetime.run(runClustering),
    getClusters,
    getClusterMembers,
    deleteCluster,
    start,
    stop: lifetime.stop,
  };
}
