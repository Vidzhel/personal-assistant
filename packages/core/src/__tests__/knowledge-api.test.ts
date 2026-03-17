import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Neo4jContainer, type StartedNeo4jContainer } from '@testcontainers/neo4j';
import { createNeo4jClient } from '../knowledge-engine/neo4j-client.ts';
import { createKnowledgeStore } from '../knowledge-engine/knowledge-store.ts';
import { createEmbeddingEngine } from '../knowledge-engine/embeddings.ts';
import { createClusteringEngine } from '../knowledge-engine/clustering.ts';
import { registerKnowledgeRoutes } from '../api/routes/knowledge.ts';
import { EventBus } from '../event-bus/event-bus.ts';
import type { RavenEvent, KnowledgeDomain } from '@raven/shared';
import type { Neo4jClient } from '../knowledge-engine/neo4j-client.ts';

// Mock HuggingFace transformers
vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn().mockResolvedValue(
    vi.fn().mockImplementation(async (text: string) => {
      const data = new Float32Array(384);
      let hash = 0;
      for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
      }
      for (let i = 0; i < 384; i++) data[i] = Math.sin(hash + i) * 0.5;
      let norm = 0;
      for (let i = 0; i < 384; i++) norm += data[i] * data[i];
      norm = Math.sqrt(norm);
      for (let i = 0; i < 384; i++) data[i] /= norm;
      return { data };
    }),
  ),
}));

const testDomains: KnowledgeDomain[] = [
  {
    name: 'health',
    description: 'Health',
    rules: {
      tags: ['health', 'fitness', 'nutrition'],
      keywords: ['doctor', 'workout', 'calories'],
    },
  },
  {
    name: 'work',
    description: 'Work',
    rules: {
      tags: ['work', 'project', 'meeting'],
      keywords: ['sprint', 'deploy', 'review'],
    },
  },
];

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
    const embeddingEngine = createEmbeddingEngine({ neo4j, eventBus, knowledgeStore: store });
    const clusteringEngine = createClusteringEngine({
      neo4j,
      eventBus,
      embeddingEngine,
      knowledgeStore: store,
      domainConfig: testDomains,
    });
    await clusteringEngine.start();

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
      embeddingEngine,
      clusteringEngine,
    });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    if (neo4j) await neo4j.close();
    if (container) await container.stop();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- Existing CRUD routes ---

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

  // --- Story 6.3: New endpoint tests ---

  it('GET /api/knowledge/tags?tree=true returns hierarchical tree', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/knowledge/tags?tree=true' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    // Domain roots should exist from clusteringEngine.start()
    const healthNode = body.find((n: any) => n.tag === 'health');
    expect(healthNode).toBeDefined();
    expect(healthNode.level).toBe(0);
  });

  it('GET /api/knowledge/domains returns configured domains', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/knowledge/domains' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(2);
    const names = body.map((d: any) => d.name);
    expect(names).toContain('health');
    expect(names).toContain('work');
  });

  it('POST /api/knowledge/tags/rebalance returns merge stats', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/knowledge/tags/rebalance' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('merged');
    expect(body).toHaveProperty('restructured');
  });

  it('POST /api/knowledge/cluster returns 202 with taskId', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/knowledge/cluster' });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.taskId).toBeDefined();
  });

  it('GET /api/knowledge/clusters returns array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/knowledge/clusters' });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  it('GET /api/knowledge/clusters/:id returns 404 for nonexistent', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/knowledge/clusters/nonexistent' });
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/knowledge/detect-merges returns merge count', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/knowledge/detect-merges' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('mergeCount');
  });

  it('GET /api/knowledge/merges returns array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/knowledge/merges' });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  it('POST /api/knowledge/merges/:id/resolve returns 404 for nonexistent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/knowledge/merges/nonexistent/resolve',
      payload: { action: 'dismiss' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/knowledge/detect-hubs returns array', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/knowledge/detect-hubs' });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  it('POST /api/knowledge/:id/split-hub returns 202', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/knowledge',
      payload: { title: 'Hub Test', content: 'hub content', tags: [] },
    });
    const bubble = createRes.json();

    const res = await app.inject({
      method: 'POST',
      url: `/api/knowledge/${bubble.id}/split-hub`,
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.taskId).toBeDefined();
    expect(body.status).toBe('splitting');
  });

  it('GET /api/knowledge/:id/links returns array', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/knowledge',
      payload: { title: 'Links Test', content: '', tags: [] },
    });
    const bubble = createRes.json();

    const res = await app.inject({
      method: 'GET',
      url: `/api/knowledge/${bubble.id}/links`,
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  it('POST /api/knowledge/links creates a link and returns 201', async () => {
    const b1Res = await app.inject({
      method: 'POST',
      url: '/api/knowledge',
      payload: { title: 'Link Source', content: '', tags: [] },
    });
    const b2Res = await app.inject({
      method: 'POST',
      url: '/api/knowledge',
      payload: { title: 'Link Target', content: '', tags: [] },
    });
    const b1 = b1Res.json();
    const b2 = b2Res.json();

    const res = await app.inject({
      method: 'POST',
      url: '/api/knowledge/links',
      payload: {
        sourceBubbleId: b1.id,
        targetBubbleId: b2.id,
        relationshipType: 'related',
      },
    });

    expect(res.statusCode).toBe(201);
    const link = res.json();
    expect(link.id).toBeDefined();
    expect(link.sourceBubbleId).toBe(b1.id);
    expect(link.targetBubbleId).toBe(b2.id);
    expect(link.status).toBe('accepted');
  });

  it('POST /api/knowledge/links with invalid relationship_type returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/knowledge/links',
      payload: {
        sourceBubbleId: 'a',
        targetBubbleId: 'b',
        relationshipType: 'invalid-type',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/knowledge/links/:id/resolve returns 404 for nonexistent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/knowledge/links/nonexistent/resolve',
      payload: { action: 'accept' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('PATCH /api/knowledge/:id/permanence updates permanence level', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/knowledge',
      payload: { title: 'Permanence Test', content: '', tags: [] },
    });
    const bubble = createRes.json();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/knowledge/${bubble.id}/permanence`,
      payload: { permanence: 'robust' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(bubble.id);
    expect(body.permanence).toBe('robust');
  });

  it('PATCH /api/knowledge/:id/permanence rejects invalid level', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/knowledge',
      payload: { title: 'Bad Perm', content: '', tags: [] },
    });
    const bubble = createRes.json();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/knowledge/${bubble.id}/permanence`,
      payload: { permanence: 'invalid' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PATCH /api/knowledge/:id/permanence returns 404 for nonexistent', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/knowledge/nonexistent/permanence',
      payload: { permanence: 'normal' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /api/knowledge?permanence=temporary filters by permanence', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/knowledge',
      payload: { title: 'Temp Bubble', content: '', tags: [], permanence: 'temporary' },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/knowledge?permanence=temporary',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body.every((b: any) => b.permanence === 'temporary')).toBe(true);
  });

  it('GET /api/knowledge?domain=health filters by domain', async () => {
    // Create a health-tagged bubble and assign domain
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/knowledge',
      payload: { title: 'Health Note', content: 'doctor visit', tags: ['health'] },
    });
    const bubble = createRes.json();

    // Manually assign domain for test (event chain won't run without embedding)
    await neo4j.run(
      `MERGE (d:Domain {name: 'health'})
       WITH d MATCH (b:Bubble {id: $id})
       CREATE (b)-[:IN_DOMAIN]->(d)`,
      { id: bubble.id },
    );

    const res = await app.inject({ method: 'GET', url: '/api/knowledge?domain=health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.length).toBeGreaterThanOrEqual(1);
  });
});
