import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../server.ts';

const ONE_HOUR_MS = 3_600_000;
const FAILURE_RATE_THRESHOLD = 0.2;

export function registerHealthRoute(app: FastifyInstance, deps: ApiDeps): void {
  app.get('/api/health', async () => {
    const suiteNames = deps.suiteRegistry.getEnabledSuiteNames();
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

    const configuredCount = deps.configuredSuiteCount;
    const suitesDegraded = configuredCount > 0 && suiteNames.length < configuredCount;
    const overallStatus: 'ok' | 'degraded' | 'error' =
      dbStatus === 'error'
        ? 'error'
        : suitesDegraded || failureRate >= FAILURE_RATE_THRESHOLD
          ? 'degraded'
          : 'ok';

    return {
      status: overallStatus,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      subsystems: {
        database: { status: dbStatus, latencyMs: dbLatencyMs },
        eventBus: { status: 'ok', listenerCount: deps.eventBus.listenerCount() },
        skills: {
          status: suitesDegraded ? 'degraded' : 'ok',
          loaded: suiteNames.length,
          configured: configuredCount,
          names: suiteNames,
        },
        scheduler: { status: 'ok', activeJobs: deps.scheduler.getActiveJobCount() },
        agentManager: {
          status: 'ok',
          queueLength: deps.agentManager.getQueueLength(),
          runningCount: deps.agentManager.getRunningCount(),
        },
      },
      taskStats,
      memory: {
        heapUsedMB: Math.round(mem.heapUsed / 1_048_576),
        heapTotalMB: Math.round(mem.heapTotal / 1_048_576),
        rssMB: Math.round(mem.rss / 1_048_576),
      },
    };
  });
}
