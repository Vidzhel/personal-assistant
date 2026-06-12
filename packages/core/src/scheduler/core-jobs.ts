import type { JobRegistry } from './job-registry.ts';
import type { Retrospective } from '../knowledge-engine/retrospective.ts';
import type { KnowledgeConsolidation } from '../knowledge-engine/knowledge-consolidation.ts';

interface ArchiverLike {
  archiveCompletedTasks(): number;
}

export interface CoreJobDeps {
  taskStore: ArchiverLike;
  retrospective: Retrospective;
  knowledgeConsolidation: KnowledgeConsolidation;
}

export function registerCoreJobs(registry: JobRegistry, deps: CoreJobDeps): void {
  registry.register('task-archival', async () => {
    const count = deps.taskStore.archiveCompletedTasks();
    return { summary: `Archived ${count} completed tasks` };
  });

  registry.register('knowledge-retrospective', async () => {
    await deps.retrospective.runFullRetrospective();
    return { summary: 'Knowledge retrospective complete' };
  });

  registry.register('knowledge-consolidation', async () => {
    await deps.knowledgeConsolidation.runConsolidation();
    return { summary: 'Knowledge consolidation complete' };
  });
}
