import { createLogger, generateId } from '@raven/shared';
import type { Neo4jClient } from './neo4j-client.ts';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { AppConfig } from '../config.ts';
import { runAgentTask } from '../agent-manager/agent-session.ts';

const log = createLogger('knowledge-consolidation');

interface ConsolidationBubbleRow {
  id: string;
  title: string;
  content: string;
  tags: string[];
  projectId: string;
}

export interface ConsolidationResult {
  mergedCount: number;
  prunedCount: number;
  digestCreated: boolean;
}

interface ParsedConsolidation {
  merges?: Array<{ keepId: string; removeIds: string[]; mergedContent: string }>;
  prunes?: string[];
  digest?: string;
}

interface ConsolidationDeps {
  neo4j: Neo4jClient;
  eventBus: EventBus;
  config: AppConfig;
}

const CONSOLIDATION_PROMPT = `You are a knowledge consolidation agent. Analyze the following auto-generated knowledge bubbles and produce a JSON response:
{
  "merges": [
    { "keepId": "id-to-keep", "removeIds": ["id-to-remove-1"], "mergedContent": "combined content" }
  ],
  "prunes": ["id-of-outdated-bubble"],
  "digest": "A single consolidated summary of all knowledge for this project (2-3 paragraphs)"
}

Guidelines:
- Merge bubbles with overlapping content into one (keep the better-titled one)
- Prune bubbles that are outdated, superseded, or no longer relevant
- Create a concise digest summarizing the overall project knowledge
- Only output valid JSON. No markdown code fences, no explanation.`;

export interface KnowledgeConsolidation {
  runConsolidation: (projectId?: string) => Promise<ConsolidationResult>;
}

function groupByProject(bubbles: ConsolidationBubbleRow[]): Map<string, ConsolidationBubbleRow[]> {
  const groups = new Map<string, ConsolidationBubbleRow[]>();
  for (const bubble of bubbles) {
    const existing = groups.get(bubble.projectId) ?? [];
    existing.push(bubble);
    groups.set(bubble.projectId, existing);
  }
  return groups;
}

async function executeMerges(
  neo4j: Neo4jClient,
  merges: ParsedConsolidation['merges'],
): Promise<number> {
  let count = 0;
  for (const merge of merges ?? []) {
    try {
      await neo4j.run(`MATCH (b:Bubble {id: $id}) SET b.content = $content`, {
        id: merge.keepId,
        content: merge.mergedContent,
      });
      for (const removeId of merge.removeIds) {
        await neo4j.run(`MATCH (b:Bubble {id: $id}) DETACH DELETE b`, { id: removeId });
      }
      count += merge.removeIds.length;
    } catch (err) {
      log.error(`Merge failed for ${merge.keepId}: ${err}`);
    }
  }
  return count;
}

async function executePrunes(
  neo4j: Neo4jClient,
  prunes: ParsedConsolidation['prunes'],
): Promise<number> {
  let count = 0;
  for (const pruneId of prunes ?? []) {
    try {
      await neo4j.run(`MATCH (b:Bubble {id: $id}) DETACH DELETE b`, { id: pruneId });
      count++;
    } catch (err) {
      log.error(`Prune failed for ${pruneId}: ${err}`);
    }
  }
  return count;
}

// eslint-disable-next-line max-lines-per-function -- orchestrates consolidation: query, agent spawn, merge/prune/digest
export function createKnowledgeConsolidation(deps: ConsolidationDeps): KnowledgeConsolidation {
  const { neo4j, eventBus } = deps;

  async function runConsolidation(projectId?: string): Promise<ConsolidationResult> {
    log.info(`Running knowledge consolidation${projectId ? ` for project ${projectId}` : ''}`);

    const cypher = `MATCH (b:Bubble)-[:BELONGS_TO_PROJECT]->(p:Project${projectId ? ' {id: $projectId}' : ''})
       WHERE b.source STARTS WITH 'auto-retrospective'
       RETURN b.id AS id, b.title AS title, b.content AS content, b.tags AS tags, p.id AS projectId`;

    const bubbles = await neo4j.query<ConsolidationBubbleRow>(
      cypher,
      projectId ? { projectId } : {},
    );

    if (bubbles.length === 0) {
      log.info('No auto-retrospective bubbles to consolidate');
      return { mergedCount: 0, prunedCount: 0, digestCreated: false };
    }

    const byProject = groupByProject(bubbles);
    let totalMerged = 0;
    let totalPruned = 0;
    let digestCreated = false;

    for (const [pid, projectBubbles] of byProject) {
      const bubbleList = projectBubbles
        .map(
          (b) =>
            `ID: ${b.id}\nTitle: ${b.title}\nContent: ${b.content}\nTags: ${(b.tags ?? []).join(', ')}`,
        )
        .join('\n---\n');

      const task = {
        id: generateId(),
        skillName: 'knowledge-consolidation',
        prompt: `${CONSOLIDATION_PROMPT}\n\n---\n\nBubbles for project ${pid}:\n\n${bubbleList}`,
        status: 'queued' as const,
        priority: 'low' as const,
        mcpServers: {},
        agentDefinitions: {},
        createdAt: Date.now(),
      };

      const result = await runAgentTask({ task, eventBus, mcpServers: {}, agentDefinitions: {} });

      try {
        const parsed = JSON.parse(result.result) as ParsedConsolidation;
        totalMerged += await executeMerges(neo4j, parsed.merges);
        totalPruned += await executePrunes(neo4j, parsed.prunes);
        if (parsed.digest) digestCreated = true;
      } catch (err) {
        log.error(`Failed to parse consolidation result for project ${pid}: ${err}`);
      }
    }

    log.info(
      `Consolidation complete: merged=${totalMerged}, pruned=${totalPruned}, digest=${digestCreated}`,
    );

    return { mergedCount: totalMerged, prunedCount: totalPruned, digestCreated };
  }

  return { runConsolidation };
}
