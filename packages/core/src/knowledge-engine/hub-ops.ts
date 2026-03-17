import { generateId, createLogger, type RavenEvent } from '@raven/shared';
import type { Neo4jClient } from './neo4j-client.ts';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { EmbeddingEngine } from './embeddings.ts';
import type { KnowledgeStore } from './knowledge-store.ts';
import type { LinkEngine } from './link-ops.ts';
import { agglomerativeCluster } from './clustering-utils.ts';

const log = createLogger('hub-ops');

const HUB_LINK_THRESHOLD = 10;
const HUB_SPLIT_GROUP_THRESHOLD = 0.5;
const SYNTH_LINK_CONFIDENCE = 0.8;
const HUB_ID_PREVIEW_LENGTH = 8;
const MAX_SYNTH_TAGS = 5;

export interface HubEngine {
  detectHubs: () => Promise<Array<{ bubbleId: string; linkCount: number }>>;
  splitHub: (hubBubbleId: string) => Promise<void>;
  start: () => void;
}

interface HubDeps {
  neo4j: Neo4jClient;
  eventBus: EventBus;
  embeddingEngine: EmbeddingEngine;
  knowledgeStore: KnowledgeStore;
  linkEngine: LinkEngine;
}

// eslint-disable-next-line max-lines-per-function -- factory function for hub engine
export function createHubEngine(deps: HubDeps): HubEngine {
  const { neo4j, eventBus, embeddingEngine, knowledgeStore, linkEngine } = deps;

  // Track pending LLM synthesis tasks: taskId → synthBubbleId
  const pendingSynthesisTasks = new Map<string, string>();

  async function detectHubs(): Promise<Array<{ bubbleId: string; linkCount: number }>> {
    // Count distinct links in both directions (outgoing + incoming)
    const rows = await neo4j.query<{ bubbleId: string; linkCount: number }>(
      `MATCH (b:Bubble)-[r:LINKS_TO {status: 'accepted'}]-()
       WITH b, count(DISTINCT r) AS linkCount
       WHERE linkCount >= $threshold
       RETURN b.id AS bubbleId, linkCount`,
      { threshold: HUB_LINK_THRESHOLD },
    );
    return rows;
  }

  // eslint-disable-next-line max-lines-per-function -- hub splitting is an inherently complex multi-step operation
  async function splitHub(hubBubbleId: string): Promise<void> {
    const links = await linkEngine.getLinksForBubble(hubBubbleId);
    const acceptedLinks = links.filter((l) => l.status === 'accepted');
    const linkedIds = new Set<string>();
    for (const link of acceptedLinks) {
      if (link.sourceBubbleId !== hubBubbleId) linkedIds.add(link.sourceBubbleId);
      if (link.targetBubbleId !== hubBubbleId) linkedIds.add(link.targetBubbleId);
    }

    if (linkedIds.size < HUB_LINK_THRESHOLD) return;

    // Cluster linked bubbles by embedding similarity
    const bubbleEmbeddings: Array<{ id: string; embedding: Float32Array }> = [];
    for (const id of linkedIds) {
      const emb = await embeddingEngine.getEmbedding(id);
      if (emb) bubbleEmbeddings.push({ id, embedding: emb });
    }

    const groups = agglomerativeCluster(bubbleEmbeddings, HUB_SPLIT_GROUP_THRESHOLD);

    for (const group of groups) {
      if (group.length < 2) continue;

      // Collect tags from group members
      const tagRows = await neo4j.query<{ name: string }>(
        `MATCH (b:Bubble)-[:HAS_TAG]->(t:Tag)
         WHERE b.id IN $memberIds
         RETURN DISTINCT t.name AS name`,
        { memberIds: group },
      );
      const groupTags = tagRows.map((r) => r.name);

      // Create placeholder synthesis bubble in knowledge store (creates file + Neo4j node)
      const synthBubble = await knowledgeStore.insert({
        title: `Synthesis: Hub ${hubBubbleId.slice(0, HUB_ID_PREVIEW_LENGTH)} group`,
        content: `Placeholder synthesis for hub split. Group members: ${group.join(', ')}`,
        tags: groupTags.slice(0, MAX_SYNTH_TAGS),
        source: 'synthesis',
      });

      // Request LLM to generate proper title/summary
      const taskId = generateId();
      pendingSynthesisTasks.set(taskId, synthBubble.id);
      eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: 'clustering',
        type: 'agent:task:request',
        payload: {
          taskId,
          prompt: `Generate a brief synthesis title and summary for a knowledge hub group. The hub bubble ID is ${hubBubbleId}. Group member IDs: ${group.join(', ')}. Tags: ${groupTags.join(', ')}. Return JSON: {"title": "...", "summary": "..."}`,
          skillName: 'knowledge-synthesis',
          mcpServers: {},
          priority: 'low',
        },
      } as RavenEvent);

      // Create links using the real synthesis bubble ID
      await linkEngine.createLinkInternal({
        sourceBubbleId: synthBubble.id,
        targetBubbleId: hubBubbleId,
        relationshipType: 'derived-from',
        confidence: 1.0,
        autoSuggested: true,
        status: 'accepted',
      });

      for (const memberId of group) {
        await linkEngine.createLinkInternal({
          sourceBubbleId: memberId,
          targetBubbleId: synthBubble.id,
          relationshipType: 'related',
          confidence: SYNTH_LINK_CONFIDENCE,
          autoSuggested: true,
          status: 'accepted',
        });
        // Remove old direct link from hub to member
        await neo4j.run(
          `MATCH (a:Bubble {id: $hubId})-[r:LINKS_TO]-(b:Bubble {id: $memberId})
           DELETE r`,
          { hubId: hubBubbleId, memberId },
        );
      }

      log.info(
        `Hub split: created synthesis ${synthBubble.id} for ${group.length} members from hub ${hubBubbleId}`,
      );
    }
  }

  function handleSynthesisComplete(event: RavenEvent): void {
    if (event.type !== 'agent:task:complete') return;
    const payload = event.payload as {
      taskId: string;
      result: string;
      success: boolean;
    };
    const synthBubbleId = pendingSynthesisTasks.get(payload.taskId);
    if (!synthBubbleId) return;
    pendingSynthesisTasks.delete(payload.taskId);

    if (!payload.success) {
      log.warn(`Synthesis LLM task ${payload.taskId} failed — keeping placeholder`);
      return;
    }

    try {
      const parsed = JSON.parse(payload.result) as { title?: string; summary?: string };
      if (parsed.title) {
        knowledgeStore
          .update(synthBubbleId, {
            title: parsed.title,
            content: parsed.summary ?? parsed.title,
          })
          .then(() => log.info(`Synthesis bubble ${synthBubbleId} updated with LLM content`))
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            log.error(`Failed to update synthesis bubble ${synthBubbleId}: ${msg}`);
          });
      }
    } catch {
      log.warn(`Failed to parse synthesis LLM response for task ${payload.taskId}`);
    }
  }

  function start(): void {
    eventBus.on('agent:task:complete', (event: RavenEvent) => {
      handleSynthesisComplete(event);
    });
  }

  return { detectHubs, splitHub, start };
}
