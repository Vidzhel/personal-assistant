import type { JobRegistry } from './job-registry.ts';
import type { Retrospective } from '../knowledge-engine/retrospective.ts';
import type { KnowledgeConsolidation } from '../knowledge-engine/knowledge-consolidation.ts';

interface ArchiverLike {
  archiveCompletedTasks(): number;
}

export interface CoreJobDeps {
  taskStore: ArchiverLike;
  // Undefined when the knowledge engine failed to initialize (e.g. Neo4j
  // unreachable at boot) — the corresponding job is simply not registered,
  // so scheduleEngine logs "handler not registered" and skips it instead
  // of throwing.
  retrospective?: Retrospective;
  knowledgeConsolidation?: KnowledgeConsolidation;
}

export function registerCoreJobs(registry: JobRegistry, deps: CoreJobDeps): void {
  registry.register('task-archival', async () => {
    const count = deps.taskStore.archiveCompletedTasks();
    return { summary: `Archived ${count} completed tasks` };
  });

  const { retrospective, knowledgeConsolidation } = deps;

  if (retrospective) {
    registry.register('knowledge-retrospective', async () => {
      await retrospective.runFullRetrospective();
      return { summary: 'Knowledge retrospective complete' };
    });
  }

  if (knowledgeConsolidation) {
    registry.register('knowledge-consolidation', async () => {
      await knowledgeConsolidation.runConsolidation();
      return { summary: 'Knowledge consolidation complete' };
    });
  }
}
