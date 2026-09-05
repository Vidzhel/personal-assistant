import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../server.ts';
import { getSelfTestStatus } from '../../services/system/self-test.ts';
import {
  collectCurrentDefinitionDiagnostics,
  DEFINITION_VIOLATION_PREFIX,
} from '../../diagnostics/current-definition-diagnostics.ts';

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

function overallHealthStatus(input: {
  database: 'ok' | 'error';
  skills: 'ok' | 'error';
  definitionsHaveErrors: boolean;
  failureRate: number;
  selfTestOk: boolean;
}): 'ok' | 'degraded' | 'error' {
  if (input.database === 'error') return 'error';
  if (
    input.skills === 'error' ||
    input.definitionsHaveErrors ||
    input.failureRate >= FAILURE_RATE_THRESHOLD ||
    !input.selfTestOk
  ) {
    return 'degraded';
  }
  return 'ok';
}

/** Definition failures are evaluated live below; retain older operational
 * failures until a new self-test verifies those invariants. */
function operationalSelfTest(
  status: ReturnType<typeof getSelfTestStatus>,
): ReturnType<typeof getSelfTestStatus> {
  const violations = status.violations.filter(
    (item) => !item.startsWith(DEFINITION_VIOLATION_PREFIX),
  );
  if (violations.length === status.violations.length) return status;
  return { ...status, violations, ok: violations.length === 0 };
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

    const selfTest = deps.db
      ? operationalSelfTest(getSelfTestStatus(deps.db))
      : { lastRun: null, ok: true, violations: [] };
    const definitionDiagnostics = collectCurrentDefinitionDiagnostics([
      deps.projectRegistry,
      deps.capabilityLibrary,
      deps.templateRegistry,
    ]).concat(deps.getProjectRecoveryDiagnostics?.() ?? []);

    const overallStatus = overallHealthStatus({
      database: dbStatus,
      skills: skillsStatus,
      definitionsHaveErrors: definitionDiagnostics.some((item) => item.severity === 'error'),
      failureRate,
      selfTestOk: selfTest.ok,
    });

    return {
      status: overallStatus,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      knowledge: deps.knowledgeStore ? ('ok' as const) : ('unavailable' as const),
      selfTest,
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
        definitions: {
          status: definitionDiagnostics.some((item) => item.severity === 'error')
            ? ('error' as const)
            : ('ok' as const),
          diagnostics: definitionDiagnostics,
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
