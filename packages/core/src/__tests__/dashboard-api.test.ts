import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import { initDatabase, getDb, createDbInterface } from '../db/database.ts';
import { registerDashboardRoutes } from '../api/routes/dashboard.ts';
import type { ScheduleEngine } from '../scheduler/schedule-engine.ts';
import type { AgentManager } from '../agent-manager/agent-manager.ts';
import type { PendingApprovals } from '../permission-engine/pending-approvals.ts';
import type { ExecutionLogger, TaskRecord } from '../agent-manager/execution-logger.ts';

function createMockExecutionLogger(): ExecutionLogger {
  return {
    queryTasks: vi.fn(() => []),
  } as unknown as ExecutionLogger;
}

function createMockScheduleEngine(): ScheduleEngine {
  return {
    list: () => [],
    setEnabled: () => true,
    runNow: async () => true,
    start: () => {},
    stop: () => {},
    getActiveCount: () => 3,
    getUpcoming: (limit: number) =>
      [
        { name: 'morning-digest', scheduledAt: '2026-03-24T07:00:00.000Z', kind: 'template' },
        { name: 'email-check', scheduledAt: '2026-03-24T08:00:00.000Z', kind: 'job' },
      ].slice(0, limit),
    getHealth: () => [],
  } as unknown as ScheduleEngine;
}

function createMockAgentManager(): AgentManager {
  return {
    getRunningCount: () => 1,
    getQueueLength: () => 2,
  } as unknown as AgentManager;
}

function createMockPendingApprovals(): PendingApprovals {
  return {
    query: () => [{ id: '1', actionName: 'test', skillName: 'test', requestedAt: '2026-03-23' }],
    initialize: () => {},
  } as unknown as PendingApprovals;
}

describe('GET /api/dashboard/life', () => {
  let tmpDir: string;
  let app: ReturnType<typeof Fastify>;
  let executionLogger: ExecutionLogger;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dashboard-api-'));
    initDatabase(join(tmpDir, 'test.db'));
    executionLogger = createMockExecutionLogger();

    app = Fastify({ logger: false });

    registerDashboardRoutes(app, {
      scheduleEngine: createMockScheduleEngine(),
      agentManager: createMockAgentManager(),
      pendingApprovals: createMockPendingApprovals(),
      executionLogger,
      db: createDbInterface(),
    });

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    try {
      getDb().close();
    } catch {
      /* */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns correct dashboard data shape', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/dashboard/life',
    });

    expect(res.statusCode).toBe(200);
    const data = res.json();

    // Today section
    expect(data.today).toBeDefined();
    expect(typeof data.today.autonomousActionsCount).toBe('number');

    // Schedules
    expect(data.schedules).toBeDefined();
    expect(data.schedules.activeCount).toBe(3);

    // Approvals
    expect(data.pendingApprovalsCount).toBe(1);

    // Insights
    expect(Array.isArray(data.insights)).toBe(true);

    // System health
    expect(data.systemHealth).toBeDefined();
    expect(data.systemHealth.status).toBe('ok');
    expect(data.systemHealth.agentsRunning).toBe(1);
    expect(data.systemHealth.queueLength).toBe(2);

    // Upcoming events
    expect(Array.isArray(data.upcomingEvents)).toBe(true);
    expect(data.upcomingEvents).toHaveLength(2);
    expect(data.upcomingEvents[0].name).toBe('morning-digest');
  });

  it('returns zero counts when DB has no data', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/dashboard/life',
    });

    const data = res.json();
    expect(data.today.autonomousActionsCount).toBe(0);
    expect(data.insights).toHaveLength(0);
  });

  it('counts completed tasks from today', async () => {
    vi.mocked(executionLogger.queryTasks).mockReturnValue([{} as TaskRecord]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/dashboard/life',
    });

    const data = res.json();
    expect(data.today.autonomousActionsCount).toBe(1);
    expect(executionLogger.queryTasks).toHaveBeenCalledWith({
      status: 'completed',
      completedSinceMs: expect.any(Number),
      limit: null,
      offset: 0,
    });
  });

  it('returns latest insights from DB', async () => {
    const db = getDb();

    db.prepare(
      'INSERT INTO insights (id, pattern_key, title, body, confidence, status, service_sources, suppression_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'ins-1',
      'meeting-overload',
      'Meeting overload detected',
      'You have 8 meetings this week',
      0.9,
      'delivered',
      '["calendar"]',
      'hash1',
      '2026-03-23T10:00:00Z',
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/dashboard/life',
    });

    const data = res.json();
    expect(data.insights).toHaveLength(1);
    expect(data.insights[0].id).toBe('ins-1');
    expect(data.insights[0].type).toBe('meeting-overload');
    expect(data.insights[0].title).toBe('Meeting overload detected');
  });
});
