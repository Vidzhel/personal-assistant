import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { EventBus } from '../event-bus/event-bus.ts';
import { SessionManager } from '../session-manager/session-manager.ts';
import type { ScheduleEngine } from '../scheduler/schedule-engine.ts';
import { initDatabase, getDb, createDbInterface } from '../db/database.ts';
import { registerHealthRoute } from '../api/routes/health.ts';
import { formatDefinitionDiagnostic } from '../diagnostics/current-definition-diagnostics.ts';
import type { DefinitionDiagnostic } from '../diagnostics/definition-diagnostics.ts';
import { registerProjectRoutes } from '../api/routes/projects.ts';
import { registerChatRoute } from '../api/routes/chat.ts';
import { registerSuiteRoutes } from '../api/routes/suites.ts';
import { registerScheduleRoutes } from '../api/routes/schedules.ts';
import { registerEventRoutes } from '../api/routes/events.ts';
import { registerAuditLogRoutes } from '../api/routes/audit-logs.ts';
import { registerAgentTaskRoutes } from '../api/routes/agent-tasks.ts';
import { registerMetricsRoute } from '../api/routes/metrics.ts';
import { createAuditLog } from '../permission-engine/audit-log.ts';
import { createPendingApprovals } from '../permission-engine/pending-approvals.ts';
import { createExecutionLogger } from '../agent-manager/execution-logger.ts';
import { createMessageStore } from '../session-manager/message-store.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { META_PROJECT_ID, type AgentTask, type RavenEvent } from '@raven/shared';
import { createRavenTestFixture } from './fixtures/raven-fixture.ts';
import { ProjectRegistry } from '../project-registry/project-registry.ts';
import { createScaffoldingApi } from '../scaffolding/scaffolding-api.ts';
import { createAgentYamlStore } from '../project-registry/agent-yaml-store.ts';
import { runProjectSync, syncProjectCache } from '../project-manager/project-sync.ts';

// Minimal mock for AgentManager
function makeMockAgentManager() {
  return {
    getQueueLength: () => 0,
    getRunningCount: () => 0,
  };
}

function makeAgentTask(overrides: Partial<AgentTask> = {}): AgentTask {
  const now = Date.now();
  return {
    id: `api-task-${Math.random().toString(36).slice(2, 8)}`,
    skillName: 'test-skill',
    prompt: 'test prompt',
    status: 'completed',
    priority: 'normal',
    mcpServers: {},
    agentDefinitions: {},
    createdAt: now,
    startedAt: now,
    completedAt: now,
    ...overrides,
  };
}

async function recordAgentTask(
  logger: ReturnType<typeof createExecutionLogger>,
  overrides: Partial<AgentTask>,
): Promise<void> {
  const task = makeAgentTask({ ...overrides, status: 'running', completedAt: undefined });
  await logger.logTaskStart(task);
  await logger.logTaskComplete(
    makeAgentTask({
      ...task,
      ...overrides,
      status: overrides.status ?? 'completed',
      completedAt: overrides.completedAt ?? Date.now(),
    }),
  );
}

describe('API routes', () => {
  let tmpDir: string;
  let app: ReturnType<typeof Fastify>;
  let eventBus: EventBus;
  let scheduleEngine: ScheduleEngine;
  let executionLogger: ReturnType<typeof createExecutionLogger>;
  let healthDeps: { capabilityLibrary?: Record<string, unknown> };

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-api-'));
    initDatabase(join(tmpDir, 'test.db'));

    eventBus = new EventBus();
    const sessionManager = new SessionManager();
    scheduleEngine = {
      list: () => [],
      setEnabled: () => true,
      runNow: async () => true,
      start: () => {},
      stop: () => {},
      getActiveCount: () => 0,
      getUpcoming: () => [],
      getHealth: () => [],
    } as unknown as ScheduleEngine;

    app = Fastify({ logger: false });
    await app.register(cors, { origin: true });

    const auditLog = createAuditLog(getDb());
    auditLog.initialize();

    const pendingApprovals = createPendingApprovals(getDb());
    pendingApprovals.initialize();

    const deps = {
      eventBus,
      db: createDbInterface(),
      sessionManager,
      scheduleEngine,
      agentManager: makeMockAgentManager() as any,
      auditLog,
      pendingApprovals,
      messageStore: createMessageStore({ basePath: join(tmpDir, 'sessions') }),
      serviceRunner: { getRunningCount: () => 0 },
      configuredServiceCount: 0,
    } as any;

    const { projectsDir } = createRavenTestFixture(tmpDir);
    const projectRegistry = new ProjectRegistry();
    await projectRegistry.load(projectsDir);
    const scaffoldingApi = createScaffoldingApi({
      projectsDir,
      projectRegistry,
      agentYamlStore: createAgentYamlStore(),
      syncProjects: () => {
        syncProjectCache({ db: getDb(), projectRegistry });
      },
    });
    await runProjectSync({ db: getDb(), projectsDir, projectRegistry, scaffoldingApi });

    executionLogger = createExecutionLogger({
      projectsDir,
      projects: () =>
        projectRegistry.listProjects().map((node) => ({
          id: node.isMeta ? META_PROJECT_ID : (node.metadata?.id ?? node.id),
          fsPath: node.id,
        })),
    });
    deps.executionLogger = executionLogger;
    healthDeps = deps;

    registerHealthRoute(app, deps);
    registerProjectRoutes(app, { eventBus, projectsDir, projectRegistry, scaffoldingApi });
    registerChatRoute(app, deps);
    registerSuiteRoutes(app, deps);
    registerScheduleRoutes(app, deps);
    registerEventRoutes(app);
    registerAuditLogRoutes(app, auditLog);

    const mockAgentManager = {
      ...makeMockAgentManager(),
      getActiveTasks: () => ({ running: [], queued: [] }),
      cancelTask: () => false,
    };

    registerAgentTaskRoutes(app, {
      executionLogger,
      agentManager: mockAgentManager as any,
    });

    registerMetricsRoute(app, {
      executionLogger,
    });

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    try {
      getDb().close();
    } catch {
      /* */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('GET /api/health', () => {
    it('returns 200 with enhanced health response', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.status).toBeDefined();
      expect(body).toHaveProperty('uptime');
      expect(body).toHaveProperty('timestamp');
      expect(body).toHaveProperty('subsystems');
      expect(body.subsystems).toHaveProperty('database');
      expect(body.subsystems).toHaveProperty('eventBus');
      expect(body.subsystems).toHaveProperty('skills');
      expect(body.subsystems).toHaveProperty('scheduler');
      expect(body.subsystems).toHaveProperty('agentManager');
      expect(body).toHaveProperty('taskStats');
      expect(body).toHaveProperty('memory');
      expect(body.knowledge).toBe('unavailable');
      expect(body.services).toEqual({ loaded: 0, configured: 0 });
    });

    it('clears recorded definition failures on reload while retaining other historical failures', async () => {
      const diagnostic: DefinitionDiagnostic = {
        source: 'schedule',
        path: 'schedules/broken.yaml',
        code: 'invalid-timing',
        message: 'Invalid cron pattern',
        severity: 'error',
      };
      const diagnostics = [diagnostic];
      healthDeps.capabilityLibrary = {
        getSkillNames: () => [],
        getDefinitionDiagnostics: () => diagnostics,
      };
      const definitionViolation = formatDefinitionDiagnostic(diagnostic);
      const insert = getDb().prepare(
        'INSERT INTO self_test_results (id, ran_at, ok, violations_json) VALUES (?, ?, ?, ?)',
      );
      insert.run(
        'definition-history',
        Date.now(),
        0,
        JSON.stringify([definitionViolation, 'Database integrity failed']),
      );
      try {
        expect((await app.inject({ method: 'GET', url: '/api/health' })).json().status).toBe(
          'degraded',
        );
        diagnostics.length = 0;
        const stillFailed = (await app.inject({ method: 'GET', url: '/api/health' })).json();
        expect(stillFailed.status).toBe('degraded');
        expect(stillFailed.selfTest.violations).toEqual(['Database integrity failed']);
        getDb()
          .prepare('UPDATE self_test_results SET violations_json = ? WHERE id = ?')
          .run(JSON.stringify([definitionViolation]), 'definition-history');
        const repaired = (await app.inject({ method: 'GET', url: '/api/health' })).json();
        expect(repaired.status).toBe('ok');
        expect(repaired.selfTest).toMatchObject({ ok: true, violations: [] });
        expect(
          getDb()
            .prepare('SELECT ok FROM self_test_results WHERE id = ?')
            .get('definition-history'),
        ).toEqual({ ok: 0 });
      } finally {
        getDb().prepare('DELETE FROM self_test_results WHERE id = ?').run('definition-history');
        healthDeps.capabilityLibrary = undefined;
      }
    });

    it('surfaces current definition diagnostics and clears them after correction', async () => {
      const diagnostics = [
        {
          source: 'project',
          path: 'projects/broken/context.md',
          code: 'invalid-yaml',
          message: 'Project metadata is invalid',
          severity: 'error',
        },
      ];
      healthDeps.capabilityLibrary = {
        getSkillNames: () => [],
        getDefinitionDiagnostics: () => diagnostics,
      };

      const degraded = await app.inject({ method: 'GET', url: '/api/health' });
      const degradedBody = JSON.parse(degraded.payload);
      expect(degradedBody.status).toBe('degraded');
      expect(degradedBody.subsystems.definitions.status).toBe('error');
      expect(degradedBody.subsystems.definitions.diagnostics).toEqual(diagnostics);

      diagnostics.length = 0;
      const healthy = await app.inject({ method: 'GET', url: '/api/health' });
      const healthyBody = JSON.parse(healthy.payload);
      expect(healthyBody.status).toBe('ok');
      expect(healthyBody.subsystems.definitions).toEqual({ status: 'ok', diagnostics: [] });
      healthDeps.capabilityLibrary = undefined;
    });
  });

  describe('POST /api/projects', () => {
    it('creates a project and returns ID', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'Test Project', description: 'A test project' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.id).toBeDefined();
      expect(body.name).toBe('Test Project');
    });
  });

  describe('GET /api/projects', () => {
    it('lists projects', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/projects' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThan(0);
    });
  });

  describe('GET /api/projects/:id', () => {
    it('returns 404 for nonexistent', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/projects/nonexistent' });
      expect(res.statusCode).toBe(404);
    });

    it('returns project by ID', async () => {
      // First create one
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'Findme' },
      });
      const { id } = JSON.parse(createRes.payload);

      const res = await app.inject({ method: 'GET', url: `/api/projects/${id}` });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).name).toBe('Findme');
    });
  });

  describe('POST /api/projects/:id/chat', () => {
    it('emits event and returns queued status', async () => {
      // Create a project first
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'Chat Project' },
      });
      const { id } = JSON.parse(createRes.payload);

      const events: RavenEvent[] = [];
      eventBus.on('user:chat:message', (e) => events.push(e));

      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${id}/chat`,
        payload: { message: 'Hello Raven!' },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ status: 'queued' });
      expect(events).toHaveLength(1);
      expect((events[0] as any).payload.message).toBe('Hello Raven!');
    });
  });

  describe('GET /api/skills', () => {
    it('returns empty array when no capability library is provided', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/skills' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual([]);
    });
  });

  describe('GET /api/suites', () => {
    it('returns 410 Gone — suites were retired in favor of /api/skills', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/suites' });
      expect(res.statusCode).toBe(410);
    });
  });

  describe('GET /api/schedules', () => {
    it('returns schedule list', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/schedules' });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(JSON.parse(res.payload))).toBe(true);
    });
  });

  describe('GET /api/audit-logs', () => {
    it('returns audit log entries through integrated route', async () => {
      // Insert via the auditLog instance used by the server
      const auditLog = createAuditLog(getDb());
      auditLog.insert({
        skillName: 'gmail',
        actionName: 'gmail:send-email',
        permissionTier: 'red',
        outcome: 'denied',
      });

      const res = await app.inject({ method: 'GET', url: '/api/audit-logs' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(1);
      expect(body[0]).toHaveProperty('skillName');
      expect(body[0]).not.toHaveProperty('skill_name');
    });
  });

  describe('GET /api/events', () => {
    it('filters events by source query param', async () => {
      const db = getDb();
      const now = Date.now();
      db.prepare(
        'INSERT INTO events (id, type, source, project_id, payload, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('ev-gmail-1', 'email:new', 'gmail', null, '{"from":"a@b.com"}', now);
      db.prepare(
        'INSERT INTO events (id, type, source, project_id, payload, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        'ev-tick-1',
        'task-management:autonomous:completed',
        'ticktick',
        null,
        '{"action":"done"}',
        now - 1000,
      );

      const res = await app.inject({ method: 'GET', url: '/api/events?source=gmail' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.length).toBe(1);
      expect(body[0].source).toBe('gmail');
    });
  });

  describe('GET /api/events/sources', () => {
    it('returns distinct source values', async () => {
      const db = getDb();
      const now = Date.now();
      db.prepare(
        'INSERT INTO events (id, type, source, project_id, payload, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('ev-src-1', 'email:new', 'gmail', null, '{}', now);
      db.prepare(
        'INSERT INTO events (id, type, source, project_id, payload, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('ev-src-2', 'pipeline:complete', 'scheduler', null, '{}', now - 1000);

      const res = await app.inject({ method: 'GET', url: '/api/events/sources' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(Array.isArray(body)).toBe(true);
      expect(body).toContain('gmail');
      expect(body).toContain('scheduler');
    });
  });

  describe('GET /api/events/types', () => {
    it('returns distinct event type values', async () => {
      const db = getDb();
      const now = Date.now();
      db.prepare(
        'INSERT INTO events (id, type, source, project_id, payload, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('ev-type-1', 'email:new', 'gmail', null, '{}', now);
      db.prepare(
        'INSERT INTO events (id, type, source, project_id, payload, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('ev-type-2', 'pipeline:complete', 'scheduler', null, '{}', now - 1000);

      const res = await app.inject({ method: 'GET', url: '/api/events/types' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(Array.isArray(body)).toBe(true);
      expect(body).toContain('email:new');
      expect(body).toContain('pipeline:complete');
    });
  });

  describe('DELETE /api/projects/:id', () => {
    it('deletes a project', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'To Delete' },
      });
      const { id } = JSON.parse(createRes.payload);

      const res = await app.inject({ method: 'DELETE', url: `/api/projects/${id}` });
      expect(res.statusCode).toBe(200);

      const getRes = await app.inject({ method: 'GET', url: `/api/projects/${id}` });
      expect(getRes.statusCode).toBe(404);
    });
  });

  describe('GET /api/agent-tasks', () => {
    it('returns paginated task list', async () => {
      await recordAgentTask(executionLogger, {
        id: 'task-1',
        skillName: 'gmail',
        prompt: 'Check email',
        status: 'completed',
      });
      await recordAgentTask(executionLogger, {
        id: 'task-2',
        skillName: 'ticktick',
        prompt: 'Create task',
        status: 'failed',
        priority: 'high',
      });

      const res = await app.inject({ method: 'GET', url: '/api/agent-tasks' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(2);
    });

    it('filters by status and bounded project/date parameters', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/agent-tasks?status=completed' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(Array.isArray(body)).toBe(true);
      for (const task of body) {
        expect(task.status).toBe('completed');
      }
      const filtered = await app.inject({
        method: 'GET',
        url: '/api/agent-tasks?createdSinceMs=0&completedSinceMs=0&limit=1',
      });
      expect(filtered.statusCode).toBe(200);
      expect(JSON.parse(filtered.payload)).toHaveLength(1);
      const invalid = await app.inject({
        method: 'GET',
        url: '/api/agent-tasks?createdSinceMs=not-a-number',
      });
      expect(invalid.statusCode).toBe(400);
    });
  });

  describe('GET /api/agent-tasks/:id', () => {
    it('returns single task', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/agent-tasks/task-1' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.id).toBe('task-1');
      expect(body.skillName).toBeDefined();
    });

    it('returns 404 for nonexistent task', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/agent-tasks/no-such-task' });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /api/metrics', () => {
    it('returns correct shape with default period', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/metrics' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.period).toBe('24h');
      expect(body.tasks).toHaveProperty('total');
      expect(body.tasks).toHaveProperty('succeeded');
      expect(body.tasks).toHaveProperty('failed');
      expect(body.tasks).toHaveProperty('successRate');
      expect(body.tasks).toHaveProperty('avgDurationMs');
      expect(Array.isArray(body.perSkill)).toBe(true);
    });

    it('respects period query param', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/metrics?period=1h' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.period).toBe('1h');
    });

    it('returns 400 for invalid period', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/metrics?period=99z' });
      expect(res.statusCode).toBe(400);
    });

    it('reflects inserted test data accurately', async () => {
      const now = new Date();

      await recordAgentTask(executionLogger, {
        id: 'metrics-task-1',
        skillName: 'gmail',
        prompt: 'Check email',
        status: 'completed',
        durationMs: 1500,
        createdAt: now.getTime(),
        completedAt: now.getTime(),
      });
      await recordAgentTask(executionLogger, {
        id: 'metrics-task-2',
        skillName: 'gmail',
        prompt: 'Send reply',
        status: 'failed',
        durationMs: 3000,
        createdAt: now.getTime(),
        completedAt: now.getTime(),
      });
      await recordAgentTask(executionLogger, {
        id: 'metrics-task-3',
        skillName: 'ticktick',
        prompt: 'Create task',
        status: 'completed',
        durationMs: 800,
        createdAt: now.getTime(),
        completedAt: now.getTime(),
      });

      const res = await app.inject({ method: 'GET', url: '/api/metrics?period=1h' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);

      // Task stats should include our inserted tasks (and possibly tasks from other tests)
      expect(body.tasks.total).toBeGreaterThanOrEqual(3);
      expect(body.tasks.succeeded).toBeGreaterThanOrEqual(2);
      expect(body.tasks.failed).toBeGreaterThanOrEqual(1);

      // Per-skill breakdown
      expect(body.perSkill.length).toBeGreaterThanOrEqual(2);
      const gmailSkill = body.perSkill.find((s: any) => s.skillName === 'gmail');
      expect(gmailSkill).toBeDefined();
      expect(gmailSkill.total).toBeGreaterThanOrEqual(2);
    });
  });
});
