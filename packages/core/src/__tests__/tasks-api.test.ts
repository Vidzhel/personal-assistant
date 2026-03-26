import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, getDb } from '../db/database.ts';
import { createTaskStore } from '../task-manager/task-store.ts';
import { createTemplateLoader } from '../task-manager/template-loader.ts';
import { registerTaskRoutes } from '../api/routes/tasks.ts';

function makeMockEventBus() {
  return { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
}

function makeDbInterface(db: ReturnType<typeof getDb>) {
  return {
    run: (sql: string, ...p: unknown[]) => db.prepare(sql).run(...p),
    get: <T>(sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as T | undefined,
    all: <T>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as T[],
  };
}

describe('Tasks API', () => {
  let tmpDir: string;
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-tasks-api-'));

    // Create templates
    const templatesDir = join(tmpDir, 'templates');
    mkdirSync(templatesDir);
    writeFileSync(
      join(templatesDir, 'research.yaml'),
      `
name: research
title: Research Topic
description: Research a topic
prompt: Research thoroughly
defaultAgentId: orchestrator
`,
    );

    const db = initDatabase(join(tmpDir, 'test.db'));
    const dbIface = makeDbInterface(db);
    const eventBus = makeMockEventBus();
    const taskStore = createTaskStore({ db: dbIface, eventBus });
    const templateLoader = createTemplateLoader({ templatesDir, taskStore });

    // Seed tasks
    taskStore.createTask({ title: 'Task A', projectId: 'proj-1', source: 'manual' });
    taskStore.createTask({
      title: 'Task B',
      projectId: 'proj-1',
      source: 'agent',
      assignedAgentId: 'agent-1',
    });
    taskStore.createTask({
      title: 'Task C',
      projectId: 'proj-2',
      source: 'ticktick',
      externalId: 'tt-1',
    });
    const completed = taskStore.createTask({ title: 'Task D', status: 'in_progress' });
    taskStore.completeTask(completed.id, ['output.txt']);

    app = Fastify({ logger: false });
    await app.register(cors, { origin: true });
    registerTaskRoutes(app, { taskStore, templateLoader });
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

  describe('GET /api/tasks', () => {
    it('returns all non-archived tasks', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/tasks' });
      expect(res.statusCode).toBe(200);
      const tasks = JSON.parse(res.payload);
      expect(tasks.length).toBeGreaterThanOrEqual(4);
    });

    it('filters by status', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/tasks?status=completed' });
      const tasks = JSON.parse(res.payload);
      expect(tasks.length).toBeGreaterThanOrEqual(1);
      for (const t of tasks) expect(t.status).toBe('completed');
    });

    it('filters by projectId', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/tasks?projectId=proj-1' });
      const tasks = JSON.parse(res.payload);
      expect(tasks.length).toBe(2);
    });

    it('filters by source', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/tasks?source=ticktick' });
      const tasks = JSON.parse(res.payload);
      expect(tasks.length).toBe(1);
      expect(tasks[0].source).toBe('ticktick');
    });

    it('supports search', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/tasks?search=Task%20A' });
      const tasks = JSON.parse(res.payload);
      expect(tasks.length).toBeGreaterThanOrEqual(1);
      expect(tasks[0].title).toContain('Task A');
    });

    it('supports pagination', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/tasks?limit=2&offset=0' });
      const tasks = JSON.parse(res.payload);
      expect(tasks.length).toBe(2);
    });
  });

  describe('GET /api/tasks/counts', () => {
    it('returns counts by status', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/tasks/counts' });
      expect(res.statusCode).toBe(200);
      const counts = JSON.parse(res.payload);
      expect(typeof counts.todo).toBe('number');
      expect(typeof counts.completed).toBe('number');
    });

    it('filters by projectId', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/tasks/counts?projectId=proj-1' });
      const counts = JSON.parse(res.payload);
      expect(counts.todo).toBeGreaterThanOrEqual(1);
    });
  });

  describe('GET /api/tasks/:id', () => {
    it('returns task with subtasks', async () => {
      // Create parent + child
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: { title: 'Parent Task' },
      });
      const parent = JSON.parse(createRes.payload);

      await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: { title: 'Child Task', parentTaskId: parent.id },
      });

      const res = await app.inject({ method: 'GET', url: `/api/tasks/${parent.id}` });
      expect(res.statusCode).toBe(200);
      const detail = JSON.parse(res.payload);
      expect(detail.title).toBe('Parent Task');
      expect(detail.subtasks).toHaveLength(1);
      expect(detail.subtasks[0].title).toBe('Child Task');
    });

    it('returns 404 for unknown id', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/tasks/nonexistent' });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/tasks', () => {
    it('creates a task', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: { title: 'New Task', description: 'Test desc' },
      });
      expect(res.statusCode).toBe(201);
      const task = JSON.parse(res.payload);
      expect(task.title).toBe('New Task');
      expect(task.source).toBe('manual');
    });

    it('creates from template', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: { title: 'Custom Research', templateName: 'research' },
      });
      expect(res.statusCode).toBe(201);
      const task = JSON.parse(res.payload);
      expect(task.title).toBe('Custom Research');
      expect(task.source).toBe('template');
    });

    it('returns 400 for invalid input', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: { title: '' }, // min length 1
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('PATCH /api/tasks/:id', () => {
    it('updates task fields', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: { title: 'To Update' },
      });
      const created = JSON.parse(createRes.payload);

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/tasks/${created.id}`,
        payload: { title: 'Updated', status: 'in_progress' },
      });
      expect(res.statusCode).toBe(200);
      const updated = JSON.parse(res.payload);
      expect(updated.title).toBe('Updated');
      expect(updated.status).toBe('in_progress');
    });

    it('returns 404 for unknown id', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/tasks/nonexistent',
        payload: { title: 'x' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/tasks/:id/complete', () => {
    it('completes a task with artifacts', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: { title: 'To Complete' },
      });
      const created = JSON.parse(createRes.payload);

      const res = await app.inject({
        method: 'POST',
        url: `/api/tasks/${created.id}/complete`,
        payload: { artifacts: ['result.md'] },
      });
      expect(res.statusCode).toBe(200);
      const completed = JSON.parse(res.payload);
      expect(completed.status).toBe('completed');
      expect(completed.artifacts).toContain('result.md');
    });
  });

  describe('GET /api/task-templates', () => {
    it('returns available templates', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/task-templates' });
      expect(res.statusCode).toBe(200);
      const templates = JSON.parse(res.payload);
      expect(templates.length).toBeGreaterThanOrEqual(1);
      expect(templates[0].name).toBe('research');
    });
  });
});
