import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Neo4jContainer, type StartedNeo4jContainer } from '@testcontainers/neo4j';
import { createNeo4jClient } from '../knowledge-engine/neo4j-client.ts';
import { createKnowledgeStore } from '../knowledge-engine/knowledge-store.ts';
import { registerKnowledgeRoutes } from '../api/routes/knowledge.ts';
import { EventBus } from '../event-bus/event-bus.ts';
import type { RavenEvent } from '@raven/shared';
import type { Neo4jClient } from '../knowledge-engine/neo4j-client.ts';

describe('Knowledge API routes', () => {
  let container: StartedNeo4jContainer;
  let neo4j: Neo4jClient;
  let tmpDir: string;
  let app: ReturnType<typeof Fastify>;
  let eventBus: EventBus;
  const emittedEvents: RavenEvent[] = [];

  beforeAll(async () => {
    container = await new Neo4jContainer('neo4j:5-community').withApoc().start();
    neo4j = createNeo4jClient({
      uri: container.getBoltUri(),
      user: 'neo4j',
      password: container.getPassword(),
    });
    await neo4j.ensureSchema();

    tmpDir = mkdtempSync(join(tmpdir(), 'knowledge-api-'));
    const knowledgeDir = join(tmpDir, 'knowledge');
    mkdirSync(knowledgeDir, { recursive: true });

    eventBus = new EventBus();
    eventBus.on('*', (e) => emittedEvents.push(e));

    const store = createKnowledgeStore({ neo4j, knowledgeDir });

    app = Fastify({ logger: false });
    await app.register(cors, { origin: true });
    const mockIngestion = { ingest: async () => ({ taskId: 'mock' }), start: () => {} };
    const mockExecLogger = { getTaskById: () => undefined } as any;
    registerKnowledgeRoutes(app, {
      eventBus,
      knowledgeStore: store,
      ingestionProcessor: mockIngestion,
      executionLogger: mockExecLogger,
      neo4j,
    });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await neo4j.close();
    await container.stop();
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

    const getRes = await app.inject({ method: 'GET', url: `/api/knowledge/${created.id}` });
    expect(getRes.statusCode).toBe(404);
  });

  it('GET /api/knowledge/tags returns tag counts', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/knowledge/tags' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it('emits knowledge events on CRUD operations', () => {
    const types = emittedEvents.map((e) => e.type);
    expect(types).toContain('knowledge:bubble:created');
  });
});
