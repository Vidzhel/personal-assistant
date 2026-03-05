import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { EventBus } from '../event-bus/event-bus.ts';
import { SkillRegistry } from '../skill-registry/skill-registry.ts';
import { SessionManager } from '../session-manager/session-manager.ts';
import { Scheduler } from '../scheduler/scheduler.ts';
import { initDatabase, getDb } from '../db/database.ts';
import { registerHealthRoute } from '../api/routes/health.ts';
import { registerProjectRoutes } from '../api/routes/projects.ts';
import { registerChatRoute } from '../api/routes/chat.ts';
import { registerSkillRoutes } from '../api/routes/skills.ts';
import { registerScheduleRoutes } from '../api/routes/schedules.ts';
import { registerEventRoutes } from '../api/routes/events.ts';
import { registerAuditLogRoutes } from '../api/routes/audit-logs.ts';
import { createAuditLog } from '../permission-engine/audit-log.ts';
import { createPendingApprovals } from '../permission-engine/pending-approvals.ts';
import { createExecutionLogger } from '../agent-manager/execution-logger.ts';
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
  let skillRegistry: SkillRegistry;
  let scheduler: Scheduler;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-api-'));
    initDatabase(join(tmpDir, 'test.db'));

    eventBus = new EventBus();
    skillRegistry = new SkillRegistry();
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
      skillRegistry,
      sessionManager,
      scheduler,
      agentManager: makeMockAgentManager() as any,
      auditLog,
      pendingApprovals,
      executionLogger,
      configuredSkillCount: 0,
    };

    registerHealthRoute(app, deps);
    registerProjectRoutes(app);
    registerChatRoute(app, deps);
    registerSkillRoutes(app, deps);
    registerScheduleRoutes(app, deps);
    registerEventRoutes(app);
    registerAuditLogRoutes(app, auditLog);

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
    it('returns empty array when no skills registered', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/skills' });
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
});
