import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, getDb, createDbInterface } from '../db/database.ts';
import { createKnowledgeStore } from '../knowledge-engine/knowledge-store.ts';
import { registerKnowledgeRoutes } from '../api/routes/knowledge.ts';
import { EventBus } from '../event-bus/event-bus.ts';
import type { RavenEvent } from '@raven/shared';

describe('Knowledge API routes', () => {
  let tmpDir: string;
  let app: ReturnType<typeof Fastify>;
  let eventBus: EventBus;
  const emittedEvents: RavenEvent[] = [];

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'knowledge-api-'));
    const knowledgeDir = join(tmpDir, 'knowledge');
    mkdirSync(knowledgeDir, { recursive: true });
    initDatabase(join(tmpDir, 'test.db'));

    eventBus = new EventBus();
    eventBus.on('*', (e) => emittedEvents.push(e));

    const store = createKnowledgeStore({ db: createDbInterface(), knowledgeDir });

    app = Fastify({ logger: false });
    await app.register(cors, { origin: true });
    registerKnowledgeRoutes(app, { eventBus, knowledgeStore: store });
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

  it('POST /api/knowledge creates a bubble and returns 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/knowledge',
      payload: {
        title: 'Test Bubble',
        content: 'Some knowledge content',
        tags: ['test'],
        source: 'manual',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeDefined();
    expect(body.title).toBe('Test Bubble');
    expect(body.filePath).toBe('test-bubble.md');
    expect(body.createdAt).toBeDefined();
  });

  it('POST /api/knowledge with invalid body returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/knowledge',
      payload: { content: 'no title' },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBeDefined();
  });

  it('GET /api/knowledge returns list of summaries', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/knowledge' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body[0].contentPreview).toBeDefined();
  });

  it('GET /api/knowledge?tag=test filters by tag', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/knowledge?tag=test' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body.every((b: any) => b.tags.includes('test'))).toBe(true);
  });

  it('GET /api/knowledge/:id returns full bubble', async () => {
    // Create one first
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/knowledge',
      payload: { title: 'Get By ID', content: 'Full content', tags: [] },
    });
    const created = createRes.json();

    const res = await app.inject({ method: 'GET', url: `/api/knowledge/${created.id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.content).toBe('Full content');
  });

  it('GET /api/knowledge/:id returns 404 for nonexistent', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/knowledge/nonexistent-id' });
    expect(res.statusCode).toBe(404);
  });

  it('PUT /api/knowledge/:id updates bubble', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/knowledge',
      payload: { title: 'To Update', content: 'Old content', tags: [] },
    });
    const created = createRes.json();

    const res = await app.inject({
      method: 'PUT',
      url: `/api/knowledge/${created.id}`,
      payload: { content: 'Updated content' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.content).toBe('Updated content');
  });

  it('PUT /api/knowledge/:id returns 404 for nonexistent', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/knowledge/nonexistent-id',
      payload: { content: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE /api/knowledge/:id removes bubble', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/knowledge',
      payload: { title: 'To Delete', content: '', tags: [] },
    });
    const created = createRes.json();

    const res = await app.inject({ method: 'DELETE', url: `/api/knowledge/${created.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);

    // Verify gone
    const getRes = await app.inject({ method: 'GET', url: `/api/knowledge/${created.id}` });
    expect(getRes.statusCode).toBe(404);
  });

  it('DELETE /api/knowledge/:id returns 404 for nonexistent', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/knowledge/nonexistent-id' });
    expect(res.statusCode).toBe(404);
  });

  it('GET /api/knowledge/tags returns tag counts', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/knowledge/tags' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it('POST /api/knowledge/reindex returns indexed count', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/knowledge/reindex' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.indexed).toBe('number');
    expect(Array.isArray(body.errors)).toBe(true);
  });

  it('GET /api/knowledge?q=content performs full-text search', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/knowledge',
      payload: { title: 'Search Target', content: 'unique searchable keyword xyzzy', tags: [] },
    });

    const res = await app.inject({ method: 'GET', url: '/api/knowledge?q=xyzzy' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body[0].title).toBe('Search Target');
  });

  it('emits knowledge events on CRUD operations', () => {
    const types = emittedEvents.map((e) => e.type);
    expect(types).toContain('knowledge:bubble:created');
  });
});
