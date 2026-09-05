import { createProcessorLifecycle } from './processor-lifecycle.ts';
import { generateId, createLogger, type RavenEvent } from '@raven/shared';
import { z } from 'zod';
import type { Neo4jClient } from './neo4j-client.ts';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { EmbeddingEngine } from './embeddings.ts';
import type { KnowledgeStore } from './knowledge-store.ts';
import type { LinkEngine } from './link-ops.ts';
import type { ManagedTransaction } from 'neo4j-driver';
import { agglomerativeCluster } from './clustering-utils.ts';
import { waitForAgentTask } from './task-completion.ts';
import { readKnowledgeSnapshots, type KnowledgeSnapshot } from './knowledge-snapshots.ts';

const log = createLogger('hub-ops');
const HUB_LINK_THRESHOLD = 10;
const HUB_SPLIT_GROUP_THRESHOLD = 0.5;
const MAX_SYNTH_TAGS = 5;
const SYNTHESIS_TIMEOUT_MS = 30_000;

export interface HubSplitResult {
  hubBubbleId: string;
  createdIds: string[];
  status: 'completed' | 'noop';
}

export interface HubEngine {
  detectHubs: () => Promise<Array<{ bubbleId: string; linkCount: number }>>;
  splitHub: (hubBubbleId: string) => Promise<HubSplitResult>;
  start: () => void;
  stop: () => Promise<void>;
}

interface HubDeps {
  neo4j: Neo4jClient;
  eventBus: EventBus;
  embeddingEngine: EmbeddingEngine;
  knowledgeStore: KnowledgeStore;
  linkEngine: LinkEngine;
}

interface HubGroup {
  memberIds: string[];
  tags: string[];
  promptContent: string;
  snapshots: KnowledgeSnapshot[];
}

interface Synthesis {
  title: string;
  summary: string;
  tags: string[];
}

const SynthesisResultSchema = z
  .object({
    title: z.string().trim().min(1),
    summary: z.string().trim().min(1),
  })
  .strict();

// eslint-disable-next-line max-lines-per-function -- factory wires lifecycle and graph collaborators
export function createHubEngine(deps: HubDeps): HubEngine {
  const { eventBus } = deps;
  const lifetime = createProcessorLifecycle(eventBus, 'hub-ops');
  const neo4j = lifetime.guard(deps.neo4j);
  const embeddingEngine = lifetime.guard(deps.embeddingEngine);
  const knowledgeStore = lifetime.guard(deps.knowledgeStore);
  const linkEngine = lifetime.guard(deps.linkEngine);
  let started = false;
  let busy = false;

  async function detectHubs(): Promise<Array<{ bubbleId: string; linkCount: number }>> {
    return neo4j.query(
      `MATCH (b:Bubble)-[r:LINKS_TO {status: 'accepted'}]-()
       WITH b, count(DISTINCT r) AS linkCount
       WHERE linkCount >= $threshold
       RETURN b.id AS bubbleId, linkCount`,
      { threshold: HUB_LINK_THRESHOLD },
    );
  }

  async function readHubGroups(hubBubbleId: string): Promise<HubGroup[]> {
    const [hubSnapshot] = await readKnowledgeSnapshots(knowledgeStore, [hubBubbleId]);
    const links = await linkEngine.getLinksForBubble(hubBubbleId);
    const linkedIds = new Set<string>();
    for (const link of links.filter((item) => item.status === 'accepted')) {
      if (link.sourceBubbleId !== hubBubbleId) linkedIds.add(link.sourceBubbleId);
      if (link.targetBubbleId !== hubBubbleId) linkedIds.add(link.targetBubbleId);
    }
    if (linkedIds.size < HUB_LINK_THRESHOLD) return [];

    const embeddings: Array<{ id: string; embedding: Float32Array }> = [];
    for (const id of linkedIds) {
      const embedding = await embeddingEngine.getEmbedding(id);
      if (embedding) embeddings.push({ id, embedding });
    }
    const groups = agglomerativeCluster(embeddings, HUB_SPLIT_GROUP_THRESHOLD).filter(
      (group) => group.length >= 2,
    );
    const prepared: HubGroup[] = [];
    for (const memberIds of groups) {
      const snapshots = await readKnowledgeSnapshots(knowledgeStore, memberIds);
      prepared.push({
        memberIds,
        tags: [...new Set(snapshots.flatMap(({ bubble }) => bubble.tags))].slice(0, MAX_SYNTH_TAGS),
        promptContent: snapshots
          .map(({ bubble }) => `### ${bubble.title}\n${bubble.content}`)
          .join('\n\n'),
        snapshots: [hubSnapshot, ...snapshots],
      });
    }
    return prepared;
  }

  async function synthesizeGroup(hubBubbleId: string, group: HubGroup): Promise<Synthesis> {
    const taskId = generateId();
    const completion = waitForAgentTask({
      eventBus,
      taskId,
      timeoutMs: SYNTHESIS_TIMEOUT_MS,
      signal: lifetime.signal,
      dispatch: () => {
        lifetime.emit({
          id: generateId(),
          timestamp: Date.now(),
          source: 'hub-ops',
          type: 'agent:task:request',
          payload: {
            taskId,
            prompt: `Generate a brief synthesis title and summary for a knowledge hub group. Hub ID: ${hubBubbleId}. Member IDs: ${group.memberIds.join(', ')}.\n\nCanonical member Markdown:\n${group.promptContent}\n\nReturn JSON: {"title":"...","summary":"..."}`,
            skillName: 'knowledge-synthesis',
            mcpServers: {},
            priority: 'low',
          },
        } as RavenEvent);
      },
    });
    const result = await completion;
    if (result.error || !result.result) {
      throw new Error(result.error ?? `Synthesis task ${taskId} returned no result`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(result.result);
    } catch {
      throw new Error(`Synthesis task ${taskId} returned invalid JSON`);
    }
    const parsed = SynthesisResultSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`Invalid synthesis response: ${parsed.error.message}`);
    return { ...parsed.data, tags: group.tags };
  }

  async function loadMemberships(
    tx: ManagedTransaction,
    memberIds: string[],
  ): Promise<Array<{ id: string; properties: Record<string, unknown> }>> {
    const ownership = await tx.run(
      `MATCH (member:Bubble)-[membership:BELONGS_TO_PROJECT]->(p:Project)
       WHERE member.id IN $memberIds
       RETURN p.id AS projectId, collect(DISTINCT properties(membership)) AS propertyMaps`,
      { memberIds },
    );
    const projects: Array<{ id: string; properties: Record<string, unknown> }> = [];
    for (const record of ownership.records) {
      const projectId = record.get('projectId') as string;
      const propertyMaps = (record.get('propertyMaps') as Record<string, unknown>[]) ?? [];
      for (const properties of propertyMaps) projects.push({ id: projectId, properties });
    }
    return projects;
  }

  async function copyMemberships(
    tx: ManagedTransaction,
    projects: Array<{ id: string; properties: Record<string, unknown> }>,
    synthesisId: string,
  ): Promise<void> {
    for (const project of projects) {
      await tx.run(
        `MATCH (s:Bubble {id: $synthId}), (p:Project {id: $projectId})
         CREATE (s)-[inherited:BELONGS_TO_PROJECT]->(p)
         SET inherited = $properties`,
        { synthId: synthesisId, projectId: project.id, properties: project.properties },
      );
      lifetime.assertActive();
    }
  }

  async function assertNodesExist(tx: ManagedTransaction, ids: string[]): Promise<void> {
    const result = await tx.run(
      `UNWIND $ids AS id
       OPTIONAL MATCH (b:Bubble {id: id})
       WITH id, b
       WHERE b IS NULL
       RETURN collect(id) AS missing`,
      { ids },
    );
    if (result.records.length === 0) return;
    const missing = result.records[0].get('missing') as string[] | undefined;
    if (missing && missing.length > 0)
      throw new Error(`Hub graph source disappeared: ${missing.join(', ')}`);
  }

  async function rewireEdges(
    tx: ManagedTransaction,
    ids: { hubBubbleId: string; memberIds: string[]; synthesisId: string },
  ): Promise<void> {
    await tx.run(
      `MATCH (h:Bubble {id: $hubId})-[old:LINKS_TO {status: 'accepted'}]->(member:Bubble)
       WHERE member.id IN $memberIds
       MATCH (s:Bubble {id: $synthId})
       CREATE (s)-[replacement:LINKS_TO]->(member)
       SET replacement = properties(old)
       DELETE old`,
      { hubId: ids.hubBubbleId, memberIds: ids.memberIds, synthId: ids.synthesisId },
    );
    await tx.run(
      `MATCH (member:Bubble)-[old:LINKS_TO {status: 'accepted'}]->(h:Bubble {id: $hubId})
       WHERE member.id IN $memberIds
       MATCH (s:Bubble {id: $synthId})
       CREATE (member)-[replacement:LINKS_TO]->(s)
       SET replacement = properties(old)
       DELETE old`,
      { hubId: ids.hubBubbleId, memberIds: ids.memberIds, synthId: ids.synthesisId },
    );
    lifetime.assertActive();
  }

  async function rewireGroup(
    hubBubbleId: string,
    group: HubGroup,
    synthesisId: string,
  ): Promise<void> {
    await neo4j.withTransaction(async (rawTx) => {
      const tx = lifetime.guard(rawTx);
      lifetime.assertActive();
      await assertNodesExist(tx, [hubBubbleId, synthesisId, ...group.memberIds]);
      lifetime.assertActive();
      const projects = await loadMemberships(tx, group.memberIds);
      lifetime.assertActive();
      await copyMemberships(tx, projects, synthesisId);
      await tx.run(
        `MATCH (s:Bubble {id: $synthId}), (h:Bubble {id: $hubId})
         CREATE (s)-[:LINKS_TO {id: $derivedId, relationshipType: 'derived-from', confidence: 1.0, autoSuggested: true, status: 'accepted', createdAt: $now}]->(h)`,
        {
          synthId: synthesisId,
          hubId: hubBubbleId,
          derivedId: generateId(),
          now: new Date().toISOString(),
        },
      );
      await rewireEdges(tx, { hubBubbleId, memberIds: group.memberIds, synthesisId });
      lifetime.assertActive();
    });
    lifetime.assertActive();
  }

  async function commitGroup(
    hubBubbleId: string,
    group: HubGroup,
    synthesis: Synthesis,
  ): Promise<string> {
    const bubble = await knowledgeStore.insert(
      {
        title: synthesis.title,
        content: synthesis.summary,
        tags: synthesis.tags,
        source: 'synthesis',
        permanence: 'robust',
      },
      { signal: lifetime.signal },
    );
    try {
      await rewireGroup(hubBubbleId, group, bubble.id);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Hub split created synthesis bubble ${bubble.id}, but graph rewiring failed. ` +
          `Reconcile bubble ${bubble.id} before retrying: ${reason}`,
        { cause: error },
      );
    }
    return bubble.id;
  }

  async function splitHub(hubBubbleId: string): Promise<HubSplitResult> {
    if (busy) throw new Error('Hub split is already running');
    busy = true;
    try {
      const groups = await readHubGroups(hubBubbleId);
      if (groups.length === 0) return { hubBubbleId, createdIds: [], status: 'noop' };
      const syntheses: Synthesis[] = [];
      for (const group of groups) syntheses.push(await synthesizeGroup(hubBubbleId, group));
      const expected = new Map(
        groups.flatMap((group) =>
          group.snapshots.map((snapshot) => [snapshot.bubble.id, snapshot.revision]),
        ),
      );
      const current = await readKnowledgeSnapshots(knowledgeStore, [...expected.keys()]);
      if (current.some((snapshot) => expected.get(snapshot.bubble.id) !== snapshot.revision)) {
        throw new Error('Hub split sources changed while synthesis was in progress');
      }
      lifetime.assertActive();
      const createdIds: string[] = [];
      for (let index = 0; index < groups.length; index += 1) {
        createdIds.push(await commitGroup(hubBubbleId, groups[index], syntheses[index]));
      }
      log.info(`Hub split completed: ${hubBubbleId} → ${createdIds.length} synthesis bubbles`);
      return { hubBubbleId, createdIds, status: 'completed' };
    } finally {
      busy = false;
    }
  }

  function start(): void {
    lifetime.assertActive();
    if (started) return;
    started = true;
  }

  return {
    detectHubs,
    splitHub: (id) => lifetime.run(() => splitHub(id)),
    start,
    stop: lifetime.stop,
  };
}
