import type { FastifyInstance } from 'fastify';
import { HTTP_STATUS } from '@raven/shared';
import type { ExecutionLogger } from '../../agent-manager/execution-logger.ts';

const PERIOD_MS: Record<string, number> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 604_800_000,
  '30d': 2_592_000_000,
};

const DEFAULT_PERIOD = '24h';
const PERCENT = 100;

export function registerMetricsRoute(
  app: FastifyInstance,
  deps: {
    executionLogger: ExecutionLogger;
  },
): void {
  app.get<{ Querystring: { period?: string } }>('/api/metrics', async (req, reply) => {
    const period = req.query.period ?? DEFAULT_PERIOD;
    const sinceMs = PERIOD_MS[period];

    if (!sinceMs) {
      return reply
        .status(HTTP_STATUS.BAD_REQUEST)
        .send({ error: `Invalid period. Valid values: ${Object.keys(PERIOD_MS).join(', ')}` });
    }

    const taskStats = deps.executionLogger.getTaskStats(sinceMs);
    const perSkill = deps.executionLogger.getPerSkillStats(sinceMs);

    return {
      period,
      tasks: {
        total: taskStats.total1h,
        succeeded: taskStats.succeeded1h,
        failed: taskStats.failed1h,
        successRate:
          taskStats.total1h > 0
            ? Math.round((taskStats.succeeded1h / taskStats.total1h) * PERCENT)
            : 0,
        avgDurationMs: taskStats.avgDurationMs,
      },
      perSkill,
    };
  });
}
