import type { FastifyInstance } from 'fastify';
import type { Scheduler } from '../../scheduler/scheduler.ts';
import type { AgentManager } from '../../agent-manager/agent-manager.ts';
import type { PendingApprovals } from '../../permission-engine/pending-approvals.ts';
import type { PipelineStore } from '../../pipeline-engine/pipeline-store.ts';
import type { DatabaseInterface } from '@raven/shared';
import type { LifeDashboardData } from '@raven/shared';

const INSIGHTS_LIMIT = 5;
const UPCOMING_LIMIT = 5;

interface DashboardDeps {
  scheduler: Scheduler;
  agentManager: AgentManager;
  pendingApprovals: PendingApprovals;
  pipelineStore?: PipelineStore;
  db?: DatabaseInterface;
}

interface InsightRow {
  id: string;
  pattern_key: string;
  title: string;
  body: string;
  created_at: string;
}

interface CountRow {
  count: number;
}

// eslint-disable-next-line max-lines-per-function -- contains one large route handler aggregating multiple data sources
export function registerDashboardRoutes(app: FastifyInstance, deps: DashboardDeps): void {
  // eslint-disable-next-line max-lines-per-function, complexity -- aggregates data from multiple sources with conditional guards
  app.get('/api/dashboard/life', async (): Promise<LifeDashboardData> => {
    // Autonomous actions today
    const todayMidnight = new Date();
    todayMidnight.setHours(0, 0, 0, 0);
    const todayMs = todayMidnight.getTime();

    let autonomousActionsCount = 0;
    let pipelinesCompleted = 0;

    if (deps.db) {
      const taskRow = deps.db.get<CountRow>(
        "SELECT COUNT(*) as count FROM agent_tasks WHERE completed_at >= ? AND status = 'completed'",
        todayMs,
      );
      autonomousActionsCount = taskRow?.count ?? 0;

      const pipelineRow = deps.db.get<CountRow>(
        "SELECT COUNT(*) as count FROM pipeline_runs WHERE status = 'completed' AND completed_at >= ?",
        new Date(todayMs).toISOString(),
      );
      pipelinesCompleted = pipelineRow?.count ?? 0;
    }

    // Active pipelines
    const globalStats = deps.pipelineStore?.getGlobalStats(todayMs);
    const activeCount = deps.scheduler.getActiveJobCount();

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

    // Upcoming events from scheduler
    const upcomingEvents = deps.scheduler.getUpcomingRuns(UPCOMING_LIMIT);

    return {
      today: {
        autonomousActionsCount,
        pipelinesCompleted: pipelinesCompleted || (globalStats?.succeeded ?? 0),
      },
      pipelines: {
        activeCount,
      },
      pendingApprovalsCount,
      insights,
      systemHealth,
      upcomingEvents,
    };
  });
}
