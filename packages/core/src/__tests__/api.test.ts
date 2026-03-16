import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { EventBus } from '../event-bus/event-bus.ts';
import { SuiteRegistry } from '../suite-registry/suite-registry.ts';
import { SessionManager } from '../session-manager/session-manager.ts';
import { Scheduler } from '../scheduler/scheduler.ts';
import { initDatabase, getDb } from '../db/database.ts';
import { registerHealthRoute } from '../api/routes/health.ts';
import { registerProjectRoutes } from '../api/routes/projects.ts';
import { registerChatRoute } from '../api/routes/chat.ts';
import { registerSuiteRoutes } from '../api/routes/suites.ts';
import { registerScheduleRoutes } from '../api/routes/schedules.ts';
import { registerEventRoutes } from '../api/routes/events.ts';
import { registerAuditLogRoutes } from '../api/routes/audit-logs.ts';
import { registerPipelineRoutes } from '../api/routes/pipelines.ts';
import { registerAgentTaskRoutes } from '../api/routes/agent-tasks.ts';
import { createAuditLog } from '../permission-engine/audit-log.ts';
import { createPendingApprovals } from '../permission-engine/pending-approvals.ts';
import { createExecutionLogger } from '../agent-manager/execution-logger.ts';
import { createMessageStore } from '../session-manager/message-store.ts';
import { createPipelineStore } from '../pipeline-engine/pipeline-store.ts';
import { createDbInterface } from '../db/database.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RavenEvent } from '@raven/shared';

// Minimal mock for AgentManager
function makeMockAgentManager() {
  return {
    getQueueLength: () => 0,
    getRunningCount: () => 0,
  };
}

describe('API routes', () => {
  let tmpDir: string;
  let app: ReturnType<typeof Fastify>;
  let eventBus: EventBus;
  let suiteRegistry: SuiteRegistry;
  let scheduler: Scheduler;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-api-'));
    initDatabase(join(tmpDir, 'test.db'));

    eventBus = new EventBus();
    suiteRegistry = new SuiteRegistry();
    const sessionManager = new SessionManager();
    scheduler = new Scheduler(eventBus, 'UTC');
    await scheduler.initialize([]);

    app = Fastify({ logger: false });
    await app.register(cors, { origin: true });

    const auditLog = createAuditLog(getDb());
    auditLog.initialize();

    const pendingApprovals = createPendingApprovals(getDb());
    pendingApprovals.initialize();

    const executionLogger = createExecutionLogger({ db: getDb() });

    const deps = {
      eventBus,
      suiteRegistry,
      sessionManager,
      scheduler,
      agentManager: makeMockAgentManager() as any,
      auditLog,
      pendingApprovals,
      executionLogger,
      messageStore: createMessageStore({ basePath: join(tmpDir, 'sessions') }),
      pipelineEngine: {
        initialize: () => {},
        getPipeline: () => undefined,
        getAllPipelines: () => [],
        executePipeline: () => Promise.reject(new Error('Not available in test')),
        triggerPipeline: () => {
          throw new Error('Not available in test');
        },
        shutdown: () => {},
      },
      configuredSuiteCount: 0,
    } as any;

    registerHealthRoute(app, deps);
    registerProjectRoutes(app);
    registerChatRoute(app, deps);
    registerSuiteRoutes(app, deps);
    registerScheduleRoutes(app, deps);
    registerEventRoutes(app);
    registerAuditLogRoutes(app, auditLog);

    const dbInterface = createDbInterface();
    const pipelineStore = createPipelineStore({ db: dbInterface });
    const mockPipelineEngine = {
      initialize: () => {},
      getPipeline: (name: string) => {
        if (name === 'test-pipeline') {
          return {
            config: {
              name: 'test-pipeline',
              description: 'A test pipeline',
              version: 1,
              trigger: { type: 'cron', schedule: '0 6 * * *' },
              nodes: {},
              connections: [],
              enabled: true,
            },
            executionOrder: [],
            entryPoints: [],
            filePath: '/tmp/test.yaml',
            loadedAt: new Date().toISOString(),
          };
        }
        return undefined;
      },
      getAllPipelines: () => [
        {
          config: {
            name: 'test-pipeline',
            description: 'A test pipeline',
            version: 1,
            trigger: { type: 'cron', schedule: '0 6 * * *' },
            nodes: {},
            connections: [],
            enabled: true,
          },
          executionOrder: [],
          entryPoints: [],
          filePath: '/tmp/test.yaml',
          loadedAt: new Date().toISOString(),
        },
      ],
      triggerPipeline: () => ({ runId: 'run-1', execution: Promise.resolve() }),
      savePipeline: () => ({}),
      deletePipeline: () => true,
      shutdown: () => {},
    } as any;

    const mockScheduler = {
      getNextRun: (name: string) => (name === 'test-pipeline' ? '2026-03-17T06:00:00.000Z' : null),
      registerPipelines: () => {},
      shutdown: () => {},
    };

    registerPipelineRoutes(app, {
      pipelineEngine: mockPipelineEngine,
      pipelineStore,
      pipelineScheduler: mockScheduler,
    });

    const mockAgentManager = {
      ...makeMockAgentManager(),
      getActiveTasks: () => ({ running: [], queued: [] }),
      cancelTask: () => false,
    };

    registerAgentTaskRoutes(app, {
      executionLogger,
      agentManager: mockAgentManager as any,
    });

    await app.ready();
  });

  afterAll(async () => {
    scheduler.shutdown();
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
    it('returns empty array when no suites registered', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/skills' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual([]);
    });
  });

  describe('GET /api/suites', () => {
    it('returns empty array when no suites registered', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/suites' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual([]);
    });
  });

  describe('GET /api/schedules', () => {
    it('returns schedule list', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/schedules' });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(JSON.parse(res.payload))).toBe(true);
    });
  });

  describe('POST /api/schedules', () => {
    it('creates a new schedule', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/schedules',
        payload: {
          name: 'Test Schedule',
          cron: '0 9 * * *',
          taskType: 'test-task',
          skillName: 'test-skill',
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.id).toBeDefined();
      expect(body.name).toBe('Test Schedule');
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

  describe('GET /api/pipelines', () => {
    it('returns enriched pipeline list with lastRun and nextRun', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/pipelines' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(1);
      expect(body[0].config.name).toBe('test-pipeline');
      expect(body[0]).toHaveProperty('lastRun');
      expect(body[0]).toHaveProperty('nextRun');
      expect(body[0].nextRun).toBe('2026-03-17T06:00:00.000Z');
    });
  });

  describe('GET /api/pipelines/:name', () => {
    it('returns enriched single pipeline with lastRun and nextRun', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/pipelines/test-pipeline' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.config.name).toBe('test-pipeline');
      expect(body).toHaveProperty('lastRun');
      expect(body).toHaveProperty('nextRun');
      expect(body.nextRun).toBe('2026-03-17T06:00:00.000Z');
    });

    it('returns 404 for nonexistent pipeline', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/pipelines/no-such-pipeline' });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /api/pipelines/:name/runs', () => {
    it('returns run history for a pipeline', async () => {
      const db = getDb();
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO pipeline_runs (id, pipeline_name, trigger_type, status, started_at, completed_at, node_results, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run('run-test-1', 'test-pipeline', 'cron', 'completed', now, now, null, null);

      const res = await app.inject({
        method: 'GET',
        url: '/api/pipelines/test-pipeline/runs',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(1);
      expect(body[0].pipeline_name).toBe('test-pipeline');
      expect(body[0].status).toBe('completed');
    });
  });

  describe('GET /api/agent-tasks', () => {
    it('returns paginated task list', async () => {
      const db = getDb();
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO agent_tasks (id, skill_name, prompt, status, priority, blocked, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run('task-1', 'gmail', 'Check email', 'completed', 'normal', 0, now);
      db.prepare(
        'INSERT INTO agent_tasks (id, skill_name, prompt, status, priority, blocked, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run('task-2', 'ticktick', 'Create task', 'failed', 'high', 0, now);

      const res = await app.inject({ method: 'GET', url: '/api/agent-tasks' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(2);
    });

    it('filters by status', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/agent-tasks?status=completed' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(Array.isArray(body)).toBe(true);
      for (const task of body) {
        expect(task.status).toBe('completed');
      }
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
});
