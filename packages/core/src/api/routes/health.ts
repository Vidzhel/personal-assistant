import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../server.ts';

const ONE_HOUR_MS = 3_600_000;
const FAILURE_RATE_THRESHOLD = 0.2;
const BYTES_PER_MB = 1_048_576;

// Reads the library's skill names, degrading to an empty (error-status) list
// rather than throwing when the library never loaded — getSkillNames()
// throws if load() hasn't succeeded.
function readSkillNames(deps: ApiDeps): { names: string[]; status: 'ok' | 'error' } {
  if (!deps.capabilityLibrary) return { names: [], status: 'error' };
  try {
    return { names: deps.capabilityLibrary.getSkillNames(), status: 'ok' };
  } catch {
    return { names: [], status: 'error' };
  }
}

// eslint-disable-next-line max-lines-per-function -- health endpoint aggregates all subsystem statuses
export function registerHealthRoute(app: FastifyInstance, deps: ApiDeps): void {
  // eslint-disable-next-line max-lines-per-function -- health endpoint aggregates all subsystem statuses
  app.get('/api/health', async () => {
    const { names: skillNames, status: skillsStatus } = readSkillNames(deps);
    const taskStats = deps.executionLogger.getTaskStats(ONE_HOUR_MS);
    const mem = process.memoryUsage();

    const failureRate = taskStats.total1h > 0 ? taskStats.failed1h / taskStats.total1h : 0;

    let dbStatus: 'ok' | 'error' = 'ok';
    let dbLatencyMs = 0;
    try {
      const start = performance.now();
      deps.executionLogger.getTaskStats(0);
      dbLatencyMs = Math.round(performance.now() - start);
    } catch {
      dbStatus = 'error';
    }

    const overallStatus: 'ok' | 'degraded' | 'error' =
      dbStatus === 'error'
        ? 'error'
        : skillsStatus === 'error' || failureRate >= FAILURE_RATE_THRESHOLD
          ? 'degraded'
          : 'ok';

    return {
      status: overallStatus,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      knowledge: deps.knowledgeStore ? ('ok' as const) : ('unavailable' as const),
      services: {
        loaded: deps.serviceRunner.getRunningCount(),
        configured: deps.configuredServiceCount,
      },
      subsystems: {
        database: { status: dbStatus, latencyMs: dbLatencyMs },
        eventBus: { status: 'ok', listenerCount: deps.eventBus.listenerCount() },
        skills: {
          status: skillsStatus,
          loaded: skillNames.length,
          configured: skillNames.length,
          names: skillNames,
        },
        scheduler: { status: 'ok', activeJobs: deps.scheduleEngine.getActiveCount() },
        agentManager: {
          status: 'ok',
          queueLength: deps.agentManager.getQueueLength(),
          runningCount: deps.agentManager.getRunningCount(),
        },
      },
      taskStats,
      memory: {
        heapUsedMB: Math.round(mem.heapUsed / BYTES_PER_MB),
        heapTotalMB: Math.round(mem.heapTotal / BYTES_PER_MB),
        rssMB: Math.round(mem.rss / BYTES_PER_MB),
      },
    };
  });
}
