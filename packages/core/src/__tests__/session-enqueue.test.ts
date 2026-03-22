import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, getDb } from '../db/database.ts';
import { createMessageStore } from '../session-manager/message-store.ts';
import { SessionManager } from '../session-manager/session-manager.ts';
import { registerSessionRoutes } from '../api/routes/sessions.ts';

describe('Session Enqueue API', () => {
  let tmpDir: string;
  let app: ReturnType<typeof Fastify>;
  let sessionManager: SessionManager;
  let activeSessionId: string | null = null;

  // Mock agent manager that considers a session "active" only if activeSessionId matches
  const mockAgentManager = {
    getActiveTasks: () => ({
      running: activeSessionId
        ? [{ taskId: 'at-1', skillName: 'test', sessionId: activeSessionId, status: 'running', priority: 'normal', createdAt: Date.now() }]
        : [],
      queued: [],
    }),
  };

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-enqueue-'));
    initDatabase(join(tmpDir, 'test.db'));

    sessionManager = new SessionManager();
    const messageStore = createMessageStore({ basePath: join(tmpDir, 'sessions') });

    // Create a test project and session
    const db = getDb();
    db.prepare(
      'INSERT OR IGNORE INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('test-proj', 'Test Project', Date.now(), Date.now());

    sessionManager.getOrCreateSession('test-proj');

    app = Fastify({ logger: false });
    await app.register(cors, { origin: true });

    // Mock minimal ApiDeps for registerSessionRoutes
    registerSessionRoutes(app, {
      sessionManager,
      messageStore,
      auditLog: { query: () => [] } as any,
      executionLogger: { queryTasks: () => [] } as any,
      agentManager: mockAgentManager as any,
    } as any);

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

  it('queues a message to a session with an active agent', async () => {
    const sessions = sessionManager.getProjectSessions('test-proj');
    const sessionId = sessions[0].id;
    activeSessionId = sessionId; // simulate running agent

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/enqueue`,
      payload: { message: 'Hello from enqueue' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.status).toBe('queued');
    expect(body.sessionId).toBe(sessionId);
  });

  it('returns 400 when no active agent on session', async () => {
    const sessions = sessionManager.getProjectSessions('test-proj');
    const sessionId = sessions[0].id;
    activeSessionId = null; // no running agent

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/enqueue`,
      payload: { message: 'Should be rejected' },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.error).toContain('No active agent');
  });

  it('returns 400 for nonexistent session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/nonexistent/enqueue',
      payload: { message: 'test' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for empty message', async () => {
    const sessions = sessionManager.getProjectSessions('test-proj');
    const sessionId = sessions[0].id;
    activeSessionId = sessionId;

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/enqueue`,
      payload: { message: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for missing message field', async () => {
    const sessions = sessionManager.getProjectSessions('test-proj');
    const sessionId = sessions[0].id;
    activeSessionId = sessionId;

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/enqueue`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});
