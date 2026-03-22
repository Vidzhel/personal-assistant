import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { initDatabase, getDb } from '../db/database.ts';
import { registerProjectRoutes } from '../api/routes/projects.ts';
import { EventBus } from '../event-bus/event-bus.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Projects API — system access fields', () => {
  let tmpDir: string;
  let app: ReturnType<typeof Fastify>;
  let eventBus: EventBus;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-proj-api-'));
    initDatabase(join(tmpDir, 'test.db'));
    eventBus = new EventBus();
    app = Fastify({ logger: false });
    registerProjectRoutes(app, { eventBus });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    getDb().close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /api/projects includes systemAccess and isMeta fields', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects' });
    const projects = JSON.parse(res.payload);
    const meta = projects.find((p: any) => p.id === 'meta');
    expect(meta).toBeDefined();
    expect(meta.systemAccess).toBe('read-write');
    expect(meta.isMeta).toBe(true);
  });

  it('POST /api/projects defaults systemAccess to none', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Test New' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.systemAccess).toBe('none');
    expect(body.isMeta).toBe(false);
  });

  it('POST /api/projects accepts custom systemAccess', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Read Only Project', systemAccess: 'read' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).systemAccess).toBe('read');
  });

  it('POST /api/projects rejects isMeta=true', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Fake Meta', isMeta: true },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toContain('meta-project');
  });

  it('POST /api/projects rejects invalid systemAccess value', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Bad Access', systemAccess: 'admin' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/projects rejects missing name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { description: 'No name' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PUT /api/projects/:id updates systemAccess', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Updatable' },
    });
    const { id } = JSON.parse(createRes.payload);

    const updateRes = await app.inject({
      method: 'PUT',
      url: `/api/projects/${id}`,
      payload: { systemAccess: 'read-write' },
    });
    expect(updateRes.statusCode).toBe(200);

    const getRes = await app.inject({ method: 'GET', url: `/api/projects/${id}` });
    expect(JSON.parse(getRes.payload).systemAccess).toBe('read-write');
  });

  it('PUT /api/projects/:id rejects isMeta changes', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'No Meta Change' },
    });
    const { id } = JSON.parse(createRes.payload);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${id}`,
      payload: { isMeta: true },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toContain('is_meta');
  });

  it('DELETE /api/projects/meta rejects with 400', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/projects/meta' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toContain('meta-project');
  });

  it('DELETE /api/projects/:id works for regular projects', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Deletable' },
    });
    const { id } = JSON.parse(createRes.payload);

    const res = await app.inject({ method: 'DELETE', url: `/api/projects/${id}` });
    expect(res.statusCode).toBe(200);
  });
});
