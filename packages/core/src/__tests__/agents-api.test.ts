import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { initDatabase, getDb } from '../db/database.ts';
import { createNamedAgentStore } from '../agent-registry/named-agent-store.ts';
import { registerAgentRoutes } from '../api/routes/agents.ts';

function makeMockEventBus() {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  };
}

function makeMockAgentManager() {
  return {
    getActiveTasks: vi.fn(() => ({ running: [], queued: [] })),
  } as any;
}

function makeMockSuiteRegistry() {
  return {
    getSuite: vi.fn(() => null),
    getAllSuites: vi.fn(() => []),
    getEnabledSuiteNames: vi.fn(() => []),
    collectMcpServers: vi.fn(() => ({})),
    collectAgentDefinitions: vi.fn(() => ({})),
  } as any;
}

describe('Agents API', () => {
  let tmpDir: string;
  let app: FastifyInstance;
  let store: ReturnType<typeof createNamedAgentStore>;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-agentsapi-'));
    initDatabase(join(tmpDir, 'test.db'));

    store = createNamedAgentStore({
      db: {
        run: (sql: string, ...params: unknown[]) =>
          getDb()
            .prepare(sql)
            .run(...params),
        get: <T>(sql: string, ...params: unknown[]) =>
          getDb()
            .prepare(sql)
            .get(...params) as T | undefined,
        all: <T>(sql: string, ...params: unknown[]) =>
          getDb()
            .prepare(sql)
            .all(...params) as T[],
      },
      eventBus: makeMockEventBus(),
      configDir: tmpDir,
    });

    app = Fastify({ logger: false });
    registerAgentRoutes(app, {
      namedAgentStore: store,
      agentManager: makeMockAgentManager(),
      suiteRegistry: makeMockSuiteRegistry(),
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

  describe('GET /api/agents', () => {
    it('returns list of agents', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/agents' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(1);
      expect(body[0]).toHaveProperty('name');
      expect(body[0]).toHaveProperty('isActive');
      expect(body[0]).toHaveProperty('taskCounts');
    });
  });

  describe('POST /api/agents', () => {
    it('creates a new agent', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/agents',
        payload: { name: 'api-test', description: 'API test agent', suiteIds: [] },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.name).toBe('api-test');
      expect(body.description).toBe('API test agent');
    });

    it('validates kebab-case name', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/agents',
        payload: { name: 'Invalid Name', suiteIds: [] },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects missing name', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/agents',
        payload: { suiteIds: [] },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/agents/:id', () => {
    it('returns agent by id', async () => {
      const created = store.createAgent({ name: 'get-api-test', suiteIds: [] });
      const res = await app.inject({ method: 'GET', url: `/api/agents/${created.id}` });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.name).toBe('get-api-test');
    });

    it('returns 404 for nonexistent', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/agents/nonexistent' });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('PATCH /api/agents/:id', () => {
    it('updates agent fields', async () => {
      const created = store.createAgent({ name: 'patch-test', suiteIds: [] });
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/agents/${created.id}`,
        payload: { description: 'Updated via API' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.description).toBe('Updated via API');
    });

    it('returns 404 for nonexistent agent', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/agents/nonexistent',
        payload: { description: 'x' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('DELETE /api/agents/:id', () => {
    it('deletes a non-default agent', async () => {
      const created = store.createAgent({ name: 'delete-api-test', suiteIds: [] });
      const res = await app.inject({ method: 'DELETE', url: `/api/agents/${created.id}` });
      expect(res.statusCode).toBe(200);
      expect(store.getAgent(created.id)).toBeUndefined();
    });

    it('returns 400 when trying to delete default agent', async () => {
      const defaultAgent = store.getDefaultAgent();
      const res = await app.inject({ method: 'DELETE', url: `/api/agents/${defaultAgent.id}` });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/agents/:id/tasks', () => {
    it('returns empty array when no task store', async () => {
      const created = store.createAgent({ name: 'tasks-api-test', suiteIds: [] });
      const res = await app.inject({
        method: 'GET',
        url: `/api/agents/${created.id}/tasks`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(Array.isArray(body)).toBe(true);
    });

    it('returns 404 for nonexistent agent', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/agents/nonexistent/tasks' });
      expect(res.statusCode).toBe(404);
    });
  });
});
