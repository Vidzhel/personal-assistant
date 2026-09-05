import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket, RawData } from 'ws';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSession, AgentTaskRequestEvent, UserChatRejectedEvent } from '@raven/shared';
import { initDatabase, getDb } from '../db/database.ts';
import { EventBus } from '../event-bus/event-bus.ts';
import { SessionManager } from '../session-manager/session-manager.ts';
import { createMessageStore, type MessageStore } from '../session-manager/message-store.ts';
import { createReference, getAllReferences } from '../session-manager/session-references.ts';
import { createDataSource, getDataSource } from '../project-manager/project-data-sources.ts';
import { registerProjectKnowledgeRoutes } from '../api/routes/project-knowledge.ts';
import { registerChatRoute } from '../api/routes/chat.ts';
import { registerSessionRoutes } from '../api/routes/sessions.ts';
import { registerWebSocketHandler } from '../api/ws/handler.ts';
import type { ApiDeps } from '../api/server.ts';
import { Orchestrator } from '../orchestrator/orchestrator.ts';

describe('Project ownership across APIs and chat dispatch', () => {
  let dir: string;
  let app: ReturnType<typeof Fastify>;
  let eventBus: EventBus;
  let sessions: SessionManager;
  let messages: MessageStore;
  let sessionA: AgentSession;
  let historicalSession: AgentSession;
  let requests: AgentTaskRequestEvent[];
  let rejections: UserChatRejectedEvent[];
  let sockets: WebSocket[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'raven-project-ownership-'));
    initDatabase(join(dir, 'test.db'));
    for (const id of ['project-a', 'project-b', 'project-c']) {
      getDb()
        .prepare(
          'INSERT INTO projects (id, name, skills, fs_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(id, id, '[]', id, Date.now(), Date.now());
    }
    getDb()
      .prepare(
        'INSERT INTO projects (id, name, skills, fs_path, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)',
      )
      .run('historical-project', 'Historical Project', '[]', Date.now(), Date.now());
    eventBus = new EventBus();
    sessions = new SessionManager();
    messages = createMessageStore({ basePath: join(dir, 'sessions') });
    sessionA = sessions.createSession('project-a');
    sessions.linkSdkSession(sessionA.id, 'fake-sdk-session-a');
    messages.appendMessage(sessionA.id, { role: 'user', content: 'Existing project A context' });
    historicalSession = sessions.createSession('historical-project');
    messages.appendMessage(historicalSession.id, { role: 'user', content: 'Historical context' });
    requests = [];
    rejections = [];
    sockets = [];
    eventBus.on<AgentTaskRequestEvent>('agent:task:request', (event) => requests.push(event));
    eventBus.on<UserChatRejectedEvent>('user:chat:rejected', (event) => rejections.push(event));
    // Stop at model dispatch: no AgentManager, credentials, live services, or definition reads.
    new Orchestrator({
      eventBus,
      sessionManager: sessions,
      messageStore: messages,
      projectsDir: join(dir, 'projects'),
      port: 0,
    });
    app = Fastify();
    await app.register(websocket);
    const deps = { eventBus, sessionManager: sessions, messageStore: messages };
    registerProjectKnowledgeRoutes(app, {});
    registerChatRoute(app, deps);
    registerSessionRoutes(app, deps as ApiDeps);
    registerWebSocketHandler(app, deps);
    await app.ready();
  });

  afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    await app.close();
    eventBus.removeAllListeners();
    getDb().close();
    rmSync(dir, { recursive: true, force: true });
  });

  function chatState() {
    return {
      projects: getDb().prepare('SELECT * FROM projects ORDER BY id').all(),
      sessions: getDb().prepare('SELECT * FROM sessions ORDER BY id').all(),
      messagesA: messages.getMessages(sessionA.id),
      tasks: getDb().prepare('SELECT * FROM agent_tasks ORDER BY id').all(),
    };
  }

  function sendEvent(projectId: string, sessionId?: string) {
    eventBus.emit({
      id: 'test-chat-request',
      timestamp: Date.now(),
      source: 'test',
      type: 'user:chat:message',
      payload: { projectId, sessionId, message: 'New message' },
    });
  }

  function makeSource() {
    return createDataSource('project-a', {
      label: 'Notes',
      uri: join(dir, 'notes.md'),
      sourceType: 'file',
    });
  }

  it.each(['PUT', 'DELETE'] as const)(
    '%s cannot mutate a source through another project',
    async (method) => {
      const source = makeSource();
      const res = await app.inject({
        method,
        url: `/api/projects/project-b/data-sources/${source.id}`,
        ...(method === 'PUT' ? { payload: { label: 'Wrong project' } } : {}),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Data source not found' });
      expect(getDataSource(source.id)).toEqual(source);
    },
  );

  it.each(['GET', 'POST', 'PUT', 'DELETE'] as const)(
    '%s sources rejects a missing parent',
    async (method) => {
      const source = makeSource();
      const suffix = method === 'PUT' || method === 'DELETE' ? `/${source.id}` : '';
      const res = await app.inject({
        method,
        url: `/api/projects/missing/data-sources${suffix}`,
        ...(['POST', 'PUT'].includes(method)
          ? { payload: { label: 'New', uri: '/fake', sourceType: 'file' } }
          : {}),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Project not found' });
      expect(getDataSource(source.id)).toEqual(source);
      expect(getDb().prepare('SELECT COUNT(*) AS count FROM project_data_sources').get()).toEqual({
        count: 1,
      });
    },
  );

  it.each(['PUT', 'DELETE'] as const)('%s rejects an unknown source', async (method) => {
    const res = await app.inject({
      method,
      url: '/api/projects/project-a/data-sources/missing',
      ...(method === 'PUT' ? { payload: { label: 'Missing' } } : {}),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Data source not found' });
  });

  it('preserves valid source create/list/edit/delete and input validation', async () => {
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/projects/project-a/data-sources',
      payload: { label: 'Incomplete' },
    });
    expect(invalid.statusCode).toBe(400);
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects/project-a/data-sources',
      payload: { label: 'Notes', uri: join(dir, 'notes.md'), sourceType: 'file' },
    });
    expect(created.statusCode).toBe(201);
    const source = created.json();
    expect(source.projectId).toBe('project-a');
    const listed = await app.inject({ method: 'GET', url: '/api/projects/project-a/data-sources' });
    expect(listed.json()).toEqual([source]);
    const other = await app.inject({ method: 'GET', url: '/api/projects/project-b/data-sources' });
    expect(other.json()).toEqual([]);
    const updated = await app.inject({
      method: 'PUT',
      url: `/api/projects/project-a/data-sources/${source.id}`,
      payload: { label: 'Updated', description: 'New description' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      id: source.id,
      projectId: 'project-a',
      label: 'Updated',
    });
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/projects/project-a/data-sources/${source.id}`,
    });
    expect(deleted.statusCode).toBe(204);
    expect(deleted.body).toBe('');
    expect(getDataSource(source.id)).toBeUndefined();
  });

  it.each(['foreign', 'missing', 'unknown-parent'] as const)(
    'HTTP rejects %s chat targets without mutations',
    async (kind) => {
      const before = chatState();
      const submitted: unknown[] = [];
      eventBus.on('user:chat:message', (event) => submitted.push(event));
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${kind === 'unknown-parent' ? 'missing' : 'project-b'}/chat`,
        payload: {
          message: 'Wrong context',
          sessionId: kind === 'missing' ? 'missing-session' : sessionA.id,
        },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toMatch(/not found/i);
      expect(submitted).toEqual([]);
      expect(requests).toEqual([]);
      expect(chatState()).toEqual(before);
    },
  );

  it.each([{ message: 'Empty ID', sessionId: '' }, { message: 42 }, {}])(
    'HTTP validates malformed chat input %j',
    async (payload) => {
      const before = chatState();
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects/project-a/chat',
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(requests).toEqual([]);
      expect(chatState()).toEqual(before);
    },
  );

  it.each(['foreign', 'missing', 'unknown-parent'] as const)(
    'direct events reject %s sessions before any writes or dispatch',
    async (kind) => {
      const before = chatState();
      const projectId = kind === 'unknown-parent' ? 'missing' : 'project-b';
      const sessionId = kind === 'missing' ? 'missing-session' : sessionA.id;
      sendEvent(projectId, sessionId);
      await vi.waitFor(() => expect(rejections).toHaveLength(1));
      expect(rejections[0]).toMatchObject({
        type: 'user:chat:rejected',
        projectId,
        payload: {
          requestId: 'test-chat-request',
          projectId,
          sessionId,
          error: expect.stringContaining('not found'),
        },
      });
      expect(requests).toEqual([]);
      expect(chatState()).toEqual(before);
    },
  );

  it('valid HTTP chat resumes the specified session and preserves its SDK ID', async () => {
    // A newer active session exists, but the explicitly selected archived session must resume.
    sessions.createSession('project-a');
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/project-a/chat',
      payload: { message: 'Continue this discussion', sessionId: sessionA.id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'queued' });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].payload).toMatchObject({
      projectId: 'project-a',
      sessionId: sessionA.id,
      prompt: 'Continue this discussion',
    });
    expect(sessions.getSession(sessionA.id)).toMatchObject({
      status: 'running',
      sdkSessionId: 'fake-sdk-session-a',
    });
    expect(messages.getMessages(sessionA.id).map((message) => message.content)).toEqual([
      'Existing project A context',
      'Continue this discussion',
    ]);
    expect(sessions.getProjectSessions('project-a')).toHaveLength(2);
  });

  it('a chat without a session creates a session in its own project', async () => {
    const original = sessions.getSession(sessionA.id);
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/project-b/chat',
      payload: { message: 'Start here' },
    });
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const [session] = sessions.getProjectSessions('project-b');
    expect(requests[0].payload.sessionId).toBe(session.id);
    expect(messages.getMessages(session.id)[0].content).toBe('Start here');
    expect(sessions.getSession(sessionA.id)).toEqual(original);
  });

  it('keeps historical sessions readable while rejecting inactive project mutations', async () => {
    const history = await app.inject({
      method: 'GET',
      url: '/api/projects/historical-project/sessions',
    });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toEqual([expect.objectContaining({ id: historicalSession.id })]);

    const newSession = await app.inject({
      method: 'POST',
      url: '/api/projects/historical-project/sessions',
    });
    expect(newSession.statusCode).toBe(404);

    const chat = await app.inject({
      method: 'POST',
      url: '/api/projects/historical-project/chat',
      payload: { message: 'Do not append this' },
    });
    expect(chat.statusCode).toBe(404);

    const source = await app.inject({
      method: 'POST',
      url: '/api/projects/historical-project/data-sources',
      payload: { label: 'New', uri: '/fake', sourceType: 'file' },
    });
    expect(source.statusCode).toBe(404);
    expect(sessions.getProjectSessions('historical-project')).toEqual([
      expect.objectContaining({ id: historicalSession.id, projectId: 'historical-project' }),
    ]);
    expect(messages.getMessages(historicalSession.id)).toHaveLength(1);
  });

  it('internal chat rejects a missing project without auto-recreating it', async () => {
    sendEvent('new-topic');
    await vi.waitFor(() => expect(rejections).toHaveLength(1));
    expect(requests).toEqual([]);
    expect(sessions.getProjectSessions('new-topic')).toHaveLength(0);
    expect(getDb().prepare('SELECT 1 FROM projects WHERE id = ?').get('new-topic')).toBeUndefined();
  });

  it.each(['foreign', 'missing', 'unknown-parent'] as const)(
    'WebSocket reports %s chat rejection to an unsubscribed caller',
    async (kind) => {
      const before = chatState();
      const socket = await app.injectWS('/ws');
      sockets.push(socket);
      const received: any[] = [];
      socket.on('message', (raw: RawData) => received.push(JSON.parse(raw.toString())));
      const projectId = kind === 'unknown-parent' ? 'missing' : 'project-b';
      const sessionId = kind === 'missing' ? 'missing-session' : sessionA.id;
      socket.send(
        JSON.stringify({
          type: 'chat:send',
          requestId: 'client-1',
          projectId,
          sessionId,
          message: 'Wrong context',
        }),
      );
      await vi.waitFor(() => expect(received).toHaveLength(1));
      expect(received[0]).toMatchObject({
        type: 'chat:error',
        data: {
          requestId: 'client-1',
          projectId,
          sessionId,
          error: expect.stringContaining('not found'),
        },
      });
      expect(requests).toEqual([]);
      expect(chatState()).toEqual(before);
    },
  );

  it('WebSocket correlates malformed message rejection without mutating chat state', async () => {
    const before = chatState();
    const socket = await app.injectWS('/ws');
    sockets.push(socket);
    const received: any[] = [];
    socket.on('message', (raw: RawData) => received.push(JSON.parse(raw.toString())));
    socket.send(
      JSON.stringify({
        type: 'chat:send',
        requestId: 'invalid-message-request',
        projectId: 'project-a',
        sessionId: sessionA.id,
        message: '',
      }),
    );
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toEqual({
      type: 'chat:error',
      data: { requestId: 'invalid-message-request', error: 'Invalid chat message' },
    });
    expect(requests).toEqual([]);
    expect(chatState()).toEqual(before);
  });

  it('WebSocket preserves valid resume and accepts null while the dashboard initializes', async () => {
    const socket = await app.injectWS('/ws');
    sockets.push(socket);
    socket.send(
      JSON.stringify({
        type: 'chat:send',
        projectId: 'project-a',
        sessionId: sessionA.id,
        message: 'Continue on socket',
      }),
    );
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].payload.sessionId).toBe(sessionA.id);
    socket.send(
      JSON.stringify({
        type: 'chat:send',
        projectId: 'project-b',
        sessionId: null,
        message: 'New socket conversation',
      }),
    );
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(sessions.getProjectSessions('project-b')).toHaveLength(1);
    expect(rejections).toEqual([]);
  });

  it.each([
    ['GET', '/sessions'],
    ['POST', '/sessions'],
    ['POST', '/sessions/new'],
  ] as const)(
    '%s %s rejects a missing project without session mutations',
    async (method, suffix) => {
      const before = chatState();
      const res = await app.inject({ method, url: `/api/projects/missing${suffix}` });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Project not found' });
      expect(chatState()).toEqual(before);
    },
  );

  it('cross-reference deletion requires one of its actual session parents', async () => {
    const sessionB = sessions.createSession('project-b');
    const sessionC = sessions.createSession('project-c');
    const reference = createReference(sessionA.id, sessionB.id, 'Shared finding');
    for (const id of [sessionC.id, 'missing-session']) {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/sessions/${id}/cross-references/${reference.id}`,
      });
      expect(res.statusCode).toBe(404);
      expect(getAllReferences(sessionA.id).from).toEqual([reference]);
    }
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${sessionB.id}/cross-references/${reference.id}`,
    });
    expect(removed.statusCode).toBe(204);
    expect(getAllReferences(sessionA.id).from).toEqual([]);
  });
});
