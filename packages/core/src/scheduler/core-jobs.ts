import type { JobRegistry } from './job-registry.ts';
import type { Retrospective } from '../knowledge-engine/retrospective.ts';
import type { KnowledgeConsolidation } from '../knowledge-engine/knowledge-consolidation.ts';
import type { MemoryConsolidation } from '../agent-memory/memory-consolidation.ts';
import type { SystemRetrospectiveDeps } from '../agent-memory/system-retrospective.ts';
import { runSystemRetrospective } from '../agent-memory/system-retrospective.ts';

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
  // Unlike the two above, raven.ts constructs these unconditionally (the
  // memory loop has no Neo4j dependency) — optional here only so callers
  // that don't care about memory jobs (most existing tests) can omit them.
  memoryConsolidation?: MemoryConsolidation;
  systemRetrospectiveDeps?: SystemRetrospectiveDeps;
}

export function registerCoreJobs(registry: JobRegistry, deps: CoreJobDeps): void {
  registry.register('task-archival', async () => {
    const count = deps.taskStore.archiveCompletedTasks();
    return { summary: `Archived ${count} completed tasks` };
  });

  const { retrospective, knowledgeConsolidation, memoryConsolidation, systemRetrospectiveDeps } =
    deps;

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

  if (memoryConsolidation) {
    registry.register('memory-consolidation', async () => {
      const result = await memoryConsolidation.runConsolidation();
      return {
        summary: `Memory consolidation: ${result.agentsProcessed} agent(s), ${result.opsApplied} op(s), ${result.candidatesArchived} candidate(s) archived`,
      };
    });
  }

  if (systemRetrospectiveDeps) {
    registry.register('system-retrospective', async () => {
      const result = await runSystemRetrospective(systemRetrospectiveDeps);
      return {
        summary: result.candidateWritten
          ? `System retrospective: candidate written (${result.failureCount} failures, ${result.stuckTreeCount} stuck trees)`
          : 'System retrospective: nothing to report',
      };
    });
  }
}
