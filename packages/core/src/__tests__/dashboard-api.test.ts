import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import { initDatabase, getDb, createDbInterface } from '../db/database.ts';
import { registerDashboardRoutes } from '../api/routes/dashboard.ts';
import type { Scheduler } from '../scheduler/scheduler.ts';
import type { AgentManager } from '../agent-manager/agent-manager.ts';
import type { PendingApprovals } from '../permission-engine/pending-approvals.ts';

function createMockScheduler(): Scheduler {
  return {
    getActiveJobCount: () => 3,
    getUpcomingRuns: (limit: number) =>
      [
        {
          name: 'morning-digest',
          scheduledAt: '2026-03-24T07:00:00.000Z',
          type: 'digest',
        },
        {
          name: 'email-check',
          scheduledAt: '2026-03-24T08:00:00.000Z',
          type: 'email',
        },
      ].slice(0, limit),
  } as unknown as Scheduler;
}

function createMockAgentManager(): AgentManager {
  return {
    getRunningCount: () => 1,
    getQueueLength: () => 2,
  } as unknown as AgentManager;
}

function createMockPendingApprovals(): PendingApprovals {
  return {
    query: () => [
      { id: '1', actionName: 'test', skillName: 'test', requestedAt: '2026-03-23' },
    ],
    initialize: () => {},
  } as unknown as PendingApprovals;
}

describe('GET /api/dashboard/life', () => {
  let tmpDir: string;
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dashboard-api-'));
    initDatabase(join(tmpDir, 'test.db'));

    app = Fastify({ logger: false });

    registerDashboardRoutes(app, {
      scheduler: createMockScheduler(),
      agentManager: createMockAgentManager(),
      pendingApprovals: createMockPendingApprovals(),
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
    expect(typeof data.today.pipelinesCompleted).toBe('number');

    // Pipelines
    expect(data.pipelines).toBeDefined();
    expect(data.pipelines.activeCount).toBe(3);

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
    const db = getDb();
    const now = Date.now();

    // Insert a completed task from today
    db.prepare(
      "INSERT INTO agent_tasks (id, session_id, skill_name, prompt, status, created_at, completed_at) VALUES (?, ?, ?, ?, 'completed', ?, ?)",
    ).run('task-1', 'sess-1', 'test-skill', 'test prompt', now, now);

    // Insert a task from yesterday (should not count)
    const yesterday = now - 86400000;
    db.prepare(
      "INSERT INTO agent_tasks (id, session_id, skill_name, prompt, status, created_at, completed_at) VALUES (?, ?, ?, ?, 'completed', ?, ?)",
    ).run('task-2', 'sess-1', 'test-skill', 'test prompt', yesterday, yesterday);

    const res = await app.inject({
      method: 'GET',
      url: '/api/dashboard/life',
    });

    const data = res.json();
    expect(data.today.autonomousActionsCount).toBe(1);
  });

  it('returns latest insights from DB', async () => {
    const db = getDb();

    db.prepare(
      "INSERT INTO insights (id, pattern_key, title, body, confidence, status, service_sources, suppression_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
