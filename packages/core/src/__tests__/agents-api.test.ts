import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { ProjectRegistry } from '../project-registry/project-registry.ts';
import { createAgentYamlStore } from '../project-registry/agent-yaml-store.ts';
import {
  createYamlNamedAgentStore,
  type NamedAgentStore,
} from '../agent-registry/yaml-named-agent-store.ts';
import { registerAgentRoutes } from '../api/routes/agents.ts';

const RAVEN_YAML = `name: raven
displayName: Raven
description: Default assistant
isDefault: true
skills: []
model: sonnet
maxTurns: 20
`;

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
  let projectsDir: string;
  let app: FastifyInstance;
  let store: NamedAgentStore;

  beforeAll(async () => {
    projectsDir = mkdtempSync(join(tmpdir(), 'raven-agentsapi-'));
    writeFileSync(join(projectsDir, 'context.md'), '# Global\n');
    mkdirSync(join(projectsDir, 'agents', 'raven'), { recursive: true });
    writeFileSync(join(projectsDir, 'agents', 'raven', 'agent.yaml'), RAVEN_YAML);

    const projectRegistry = new ProjectRegistry();
    await projectRegistry.load(projectsDir);
    store = createYamlNamedAgentStore({
      projectRegistry,
      agentYamlStore: createAgentYamlStore(),
      projectsDir,
      eventBus: makeMockEventBus() as any,
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
    rmSync(projectsDir, { recursive: true, force: true });
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
      expect(body.id).toBe('api-test');
      expect(body.description).toBe('API test agent');
    });

    it('rejects duplicate agent names', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/agents',
        payload: { name: 'raven', suiteIds: [] },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error).toContain('already exists');
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
    it('returns agent by id (= name)', async () => {
      const created = await store.createAgent({ name: 'get-api-test', suiteIds: [], skills: [] });
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
      const created = await store.createAgent({ name: 'patch-test', suiteIds: [], skills: [] });
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
      const created = await store.createAgent({
        name: 'delete-api-test',
        suiteIds: [],
        skills: [],
      });
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
      const created = await store.createAgent({
        name: 'tasks-api-test',
        suiteIds: [],
        skills: [],
      });
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
