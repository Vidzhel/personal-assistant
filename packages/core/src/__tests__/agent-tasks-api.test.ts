import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, getDb } from '../db/database.ts';
import { createExecutionLogger } from '../agent-manager/execution-logger.ts';
import { registerAgentTaskRoutes } from '../api/routes/agent-tasks.ts';
import type { AgentTask } from '@raven/shared';

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: `task-${Math.random().toString(36).slice(2, 8)}`,
    skillName: 'test-skill',
    prompt: 'do something',
    status: 'running',
    priority: 'normal',
    mcpServers: {},
    agentDefinitions: {},
    createdAt: Date.now(),
    startedAt: Date.now(),
    ...overrides,
  };
}

describe('Agent Tasks API', () => {
  let tmpDir: string;
  let app: ReturnType<typeof Fastify>;
  let executionLogger: ReturnType<typeof createExecutionLogger>;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-tasks-api-'));
    initDatabase(join(tmpDir, 'test.db'));
    executionLogger = createExecutionLogger({ db: getDb() });

    // Seed some tasks
    const t1 = makeTask({ id: 'api-task-1', skillName: 'gmail' });
    executionLogger.logTaskStart(t1);
    t1.status = 'completed';
    t1.result = 'sent email';
    t1.durationMs = 200;
    t1.completedAt = Date.now();
    executionLogger.logTaskComplete(t1);

    const t2 = makeTask({ id: 'api-task-2', skillName: 'ticktick' });
    executionLogger.logTaskStart(t2);
    t2.status = 'failed';
    t2.errors = ['timeout'];
    t2.completedAt = Date.now();
    executionLogger.logTaskComplete(t2);

    const t3 = makeTask({ id: 'api-task-3', skillName: 'gmail', actionName: 'gmail:read' });
    executionLogger.logTaskStart(t3);

    app = Fastify({ logger: false });
    await app.register(cors, { origin: true });
    const mockAgentManager = {
      cancelTask: () => false,
      getActiveTasks: () => ({ running: [], queued: [] }),
    };
    registerAgentTaskRoutes(app, {
      executionLogger,
      agentManager: mockAgentManager as never,
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

  describe('GET /api/agent-tasks', () => {
    it('returns all tasks', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/agent-tasks' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(3);
    });

    it('filters by skillName', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/agent-tasks?skillName=gmail',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.length).toBe(2);
      for (const task of body) {
        expect(task.skillName).toBe('gmail');
      }
    });

    it('filters by status', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/agent-tasks?status=failed',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.length).toBe(1);
      expect(body[0].status).toBe('failed');
    });

    it('respects limit and offset', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/agent-tasks?limit=1&offset=0',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.length).toBe(1);
    });

    it('rejects invalid status', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/agent-tasks?status=invalid',
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error).toBe('Invalid query parameters');
    });
  });

  describe('GET /api/agent-tasks/:id', () => {
    it('returns task by ID', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/agent-tasks/api-task-1',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.id).toBe('api-task-1');
      expect(body.skillName).toBe('gmail');
      expect(body.status).toBe('completed');
      expect(body.result).toBe('sent email');
      expect(body.durationMs).toBe(200);
      expect(body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('returns 404 for nonexistent task', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/agent-tasks/nonexistent',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.payload);
      expect(body.error).toBe('Task not found');
      expect(body.code).toBe('NOT_FOUND');
    });
  });
});
