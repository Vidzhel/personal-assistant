import { createProcessorLifecycle } from './processor-lifecycle.ts';
import { createLogger, generateId, type AgentTask } from '@raven/shared';
import type { Neo4jClient } from './neo4j-client.ts';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { KnowledgeStore } from './knowledge-store.ts';
import type { EmbeddingEngine } from './embeddings.ts';
import type { ChunkingEngine } from './chunking.ts';
import { runAgentTask } from '../agent-manager/agent-session.ts';
import {
  readKnowledgeSnapshots,
  mergeSources,
  type KnowledgeSnapshot,
} from './knowledge-snapshots.ts';
import { knowledgeRevision } from './knowledge-revision.ts';
import {
  parseConsolidationPlan,
  validateConsolidationPlans,
  type ProjectConsolidationPlan,
} from './knowledge-consolidation-plan.ts';

const log = createLogger('knowledge-consolidation');

export interface ConsolidationResult {
  mergedCount: number;
  prunedCount: number;
  digestCreated: boolean;
  digestIds: string[];
  mergedIds: string[];
}

interface ConsolidationDeps {
  neo4j: Neo4jClient;
  eventBus: EventBus;
  knowledgeStore: KnowledgeStore;
  embeddingEngine: Pick<EmbeddingEngine, 'refreshBubble'>;
  chunkingEngine: Pick<ChunkingEngine, 'indexBubble'>;
  signal?: AbortSignal;
}

export interface KnowledgeConsolidation {
  runConsolidation: (projectId?: string) => Promise<ConsolidationResult>;
  stop: () => Promise<void>;
}

const CONSOLIDATION_PROMPT = `Analyze these auto-generated knowledge sources and return only JSON:
{"merges":[{"keepId":"title-source-id","removeIds":["other-source-id"],"mergedContent":"combined text"}],"prunes":["outdated-source-id"],"digest":"project knowledge summary"}
Use only the supplied IDs. Merge overlapping sources, preserving all useful facts.
keepId chooses the title; each merge creates a new source and replaces all its inputs.
Do not use any source in more than one merge or prune. Omit operations that are unnecessary.
The optional digest should summarize this project's knowledge in 2-3 paragraphs.`;

function selectedSnapshot(byId: Map<string, KnowledgeSnapshot>, id: string): KnowledgeSnapshot {
  const snapshot = byId.get(id);
  if (!snapshot) throw new Error(`Knowledge source is outside the selected plan: ${id}`);
  return snapshot;
}

async function selectProjects(
  deps: ConsolidationDeps,
  projectId?: string,
): Promise<Map<string, KnowledgeSnapshot[]>> {
  const rows = await deps.neo4j.query<{ id: string; projectId: string }>(
    `MATCH (b:Bubble)-[:BELONGS_TO_PROJECT]->(p:Project${projectId ? ' {id: $projectId}' : ''})
     RETURN DISTINCT b.id AS id, p.id AS projectId`,
    projectId ? { projectId } : {},
  );
  const snapshots = await readKnowledgeSnapshots(deps.knowledgeStore, [
    ...new Set(rows.map((row) => row.id)),
  ]);
  const byId = new Map(snapshots.map((snapshot) => [snapshot.bubble.id, snapshot]));
  const projects = new Map<string, KnowledgeSnapshot[]>();
  for (const row of rows) {
    const snapshot = selectedSnapshot(byId, row.id);
    // Source metadata, like the body, is owned by the current Markdown file.
    if (!snapshot.bubble.source?.startsWith('auto-retrospective')) continue;
    const sources = projects.get(row.projectId) ?? [];
    sources.push(snapshot);
    projects.set(row.projectId, sources);
  }
  return projects;
}

async function planProject(
  deps: ConsolidationDeps,
  selection: { projectId: string; snapshots: KnowledgeSnapshot[] },
): Promise<ProjectConsolidationPlan> {
  deps.signal?.throwIfAborted();
  const { projectId, snapshots } = selection;
  const sources = snapshots.map(
    ({ bubble }) =>
      `ID: ${bubble.id}\nTitle: ${bubble.title}\nContent: ${bubble.content}\nTags: ${bubble.tags.join(', ')}`,
  );
  const task: AgentTask = {
    id: generateId(),
    projectId,
    skillName: 'knowledge-consolidation',
    prompt: `${CONSOLIDATION_PROMPT}\n\nProject ${projectId}:\n\n${sources.join('\n---\n')}`,
    status: 'queued',
    priority: 'low',
    mcpServers: {},
    agentDefinitions: {},
    createdAt: Date.now(),
  };
  const result = await runAgentTask({
    task,
    eventBus: deps.eventBus,
    mcpServers: {},
    agentDefinitions: {},
    signal: deps.signal,
  });
  deps.signal?.throwIfAborted();
  if (!result.success)
    throw new Error(
      `Knowledge consolidation failed for ${projectId}: ${result.errors?.join('; ') ?? 'unsuccessful result'}`,
    );
  return { ...selection, plan: parseConsolidationPlan(result.result) };
}

async function verifyCurrentSelection(
  deps: ConsolidationDeps,
  plans: ProjectConsolidationPlan[],
): Promise<void> {
  for (const { projectId, snapshots } of plans) {
    const memberships = await deps.neo4j.query<{ id: string }>(
      `MATCH (b:Bubble)-[:BELONGS_TO_PROJECT]->(:Project {id: $projectId}) RETURN DISTINCT b.id AS id`,
      { projectId },
    );
    const selected = new Set(memberships.map((row) => row.id));
    for (const snapshot of snapshots) {
      deps.signal?.throwIfAborted();
      const current = await deps.knowledgeStore.getById(snapshot.bubble.id, { trackAccess: false });
      if (
        !selected.has(snapshot.bubble.id) ||
        !current ||
        knowledgeRevision(current) !== snapshot.revision ||
        current.source !== snapshot.bubble.source
      ) {
        throw new Error(`Knowledge source changed during consolidation: ${snapshot.bubble.id}`);
      }
    }
  }
}

async function applyProject(
  deps: ConsolidationDeps,
  planned: ProjectConsolidationPlan,
  result: ConsolidationResult,
): Promise<void> {
  const { projectId, snapshots, plan } = planned;
  const byId = new Map(snapshots.map((snapshot) => [snapshot.bubble.id, snapshot]));
  for (const merge of plan.merges) {
    deps.signal?.throwIfAborted();
    const selected = [merge.keepId, ...merge.removeIds].map((id) => selectedSnapshot(byId, id));
    const merged = await deps.knowledgeStore.mergeOwned({
      sources: mergeSources(selected),
      title: selectedSnapshot(byId, merge.keepId).bubble.title,
      content: merge.mergedContent,
      signal: deps.signal,
    });
    result.mergedIds.push(merged.id);
    result.mergedCount += merge.removeIds.length;
  }
  for (const id of plan.prunes) {
    deps.signal?.throwIfAborted();
    const removed = await deps.knowledgeStore.remove(id, {
      expectedRevision: selectedSnapshot(byId, id).revision,
      signal: deps.signal,
    });
    if (!removed) throw new Error(`Consolidation source disappeared before prune: ${id}`);
    result.prunedCount++;
  }
  if (plan.digest) {
    const digest = await deps.knowledgeStore.insert(
      {
        title: `Project ${projectId} knowledge digest`,
        content: plan.digest,
        tags: ['digest'],
        source: 'consolidation-digest',
      },
      { projectIds: [projectId], signal: deps.signal },
    );
    result.digestIds.push(digest.id);
    result.digestCreated = true;
  }
}

async function refreshResults(deps: ConsolidationDeps, result: ConsolidationResult): Promise<void> {
  for (const id of [...result.mergedIds, ...result.digestIds]) {
    deps.signal?.throwIfAborted();
    await deps.embeddingEngine.refreshBubble(id);
    await deps.chunkingEngine.indexBubble(id);
  }
}

export function createKnowledgeConsolidation(deps: ConsolidationDeps): KnowledgeConsolidation {
  const lifetime = createProcessorLifecycle(deps.eventBus, 'knowledge-consolidation');
  const owned = {
    ...deps,
    neo4j: lifetime.guard(deps.neo4j),
    knowledgeStore: lifetime.guard(deps.knowledgeStore),
    embeddingEngine: lifetime.guard(deps.embeddingEngine),
    chunkingEngine: lifetime.guard(deps.chunkingEngine),
    signal: lifetime.signal,
  };
  let running = false;

  async function runConsolidation(projectId?: string): Promise<ConsolidationResult> {
    if (running) throw new Error('Knowledge consolidation is already running');
    running = true;
    const result: ConsolidationResult = {
      mergedCount: 0,
      prunedCount: 0,
      digestCreated: false,
      digestIds: [],
      mergedIds: [],
    };
    try {
      const projects = await selectProjects(owned, projectId);
      const plans: ProjectConsolidationPlan[] = [];
      for (const [id, snapshots] of projects)
        plans.push(await planProject(owned, { projectId: id, snapshots }));
      validateConsolidationPlans(plans);
      await verifyCurrentSelection(owned, plans);
      for (const plan of plans) await applyProject(owned, plan, result);
      await refreshResults(owned, result);
      log.info(
        `Knowledge consolidation complete: merged=${result.mergedCount}, pruned=${result.prunedCount}, digests=${result.digestIds.length}`,
      );
      return result;
    } catch (error) {
      // Earlier committed operations remain real; never turn a partial run into success.
      throw new Error(
        `Knowledge consolidation ${owned.signal.aborted ? 'stopped' : 'failed'} (completed merges: ${result.mergedIds.join(', ') || 'none'}; prunes: ${result.prunedCount}; digests: ${result.digestIds.join(', ') || 'none'}). Reconcile/reindex before retry: ${String(error)}`,
        { cause: error },
      );
    } finally {
      running = false;
    }
  }

  return {
    runConsolidation: (id) => lifetime.run(() => runConsolidation(id)),
    stop: lifetime.stop,
  };
}
