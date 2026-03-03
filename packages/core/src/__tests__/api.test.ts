import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { EventBus } from '../event-bus/event-bus.js';
import { SkillRegistry } from '../skill-registry/skill-registry.js';
import { SessionManager } from '../session-manager/session-manager.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { initDatabase, getDb } from '../db/database.js';
import { registerHealthRoute } from '../api/routes/health.js';
import { registerProjectRoutes } from '../api/routes/projects.js';
import { registerChatRoute } from '../api/routes/chat.js';
import { registerSkillRoutes } from '../api/routes/skills.js';
import { registerScheduleRoutes } from '../api/routes/schedules.js';
import { registerEventRoutes } from '../api/routes/events.js';
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

    const deps = {
      eventBus,
      skillRegistry,
      sessionManager,
      scheduler,
      agentManager: makeMockAgentManager() as any,
    };

    registerHealthRoute(app, deps);
    registerProjectRoutes(app);
    registerChatRoute(app, deps);
    registerSkillRoutes(app, deps);
    registerScheduleRoutes(app, deps);
    registerEventRoutes(app);

    await app.ready();
  });

  afterAll(async () => {
    scheduler.shutdown();
    await app.close();
    try { getDb().close(); } catch { /* */ }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('GET /api/health', () => {
    it('returns 200 with status ok', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.status).toBe('ok');
      expect(body).toHaveProperty('uptime');
      expect(body).toHaveProperty('skills');
      expect(body).toHaveProperty('agentQueue');
      expect(body).toHaveProperty('agentsRunning');
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
