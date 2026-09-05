import type { FastifyInstance } from 'fastify';
import type { ScheduleEngine } from '../../scheduler/schedule-engine.ts';
import type { AgentManager } from '../../agent-manager/agent-manager.ts';
import type { PendingApprovals } from '../../permission-engine/pending-approvals.ts';
import type { DatabaseInterface } from '@raven/shared';
import type { LifeDashboardData } from '@raven/shared';
import type { ExecutionLogger } from '../../agent-manager/execution-logger.ts';

const INSIGHTS_LIMIT = 5;
const UPCOMING_LIMIT = 5;

interface DashboardDeps {
  scheduleEngine: ScheduleEngine;
  agentManager: AgentManager;
  pendingApprovals: PendingApprovals;
  executionLogger: ExecutionLogger;
  db?: DatabaseInterface;
}

interface InsightRow {
  id: string;
  pattern_key: string;
  title: string;
  body: string;
  created_at: string;
}

export function registerDashboardRoutes(app: FastifyInstance, deps: DashboardDeps): void {
  app.get('/api/dashboard/life', async (): Promise<LifeDashboardData> => {
    // Autonomous actions today
    const todayMidnight = new Date();
    todayMidnight.setHours(0, 0, 0, 0);
    const todayMs = todayMidnight.getTime();

    const autonomousActionsCount = deps.executionLogger.queryTasks({
      status: 'completed',
      completedSinceMs: todayMs,
      limit: null,
      offset: 0,
    }).length;

    // Active schedules
    const activeCount = deps.scheduleEngine.getActiveCount();

    // Pending approvals — query() already filters WHERE resolution IS NULL
    const pendingApprovalsCount = deps.pendingApprovals.query().length;

    // Latest insights
    let insights: LifeDashboardData['insights'] = [];
    if (deps.db) {
      const rows = deps.db.all<InsightRow>(
        'SELECT id, pattern_key, title, body, created_at FROM insights ORDER BY created_at DESC LIMIT ?',
        INSIGHTS_LIMIT,
      );

      insights = rows.map((r) => ({
        id: r.id,
        type: r.pattern_key,
        title: r.title,
        content: r.body,
      }));
    }

    // System health
    const systemHealth = {
      status: 'ok' as string,
      uptime: process.uptime(),
      agentsRunning: deps.agentManager.getRunningCount(),
      queueLength: deps.agentManager.getQueueLength(),
    };

    // Upcoming events from the schedule engine.
    // The engine yields `{name,scheduledAt,kind}`; the shared LifeDashboardData
    // wire contract expects `type`, so map kind→type to keep the web contract unchanged.
    const upcomingEvents = deps.scheduleEngine
      .getUpcoming(UPCOMING_LIMIT)
      .map((e) => ({ name: e.name, scheduledAt: e.scheduledAt, type: e.kind }));

    return {
      today: {
        autonomousActionsCount,
      },
      schedules: {
        activeCount,
      },
      pendingApprovalsCount,
      insights,
      systemHealth,
      upcomingEvents,
    };
  });
}
