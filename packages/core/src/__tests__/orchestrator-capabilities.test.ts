import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { NamedAgent, AgentTaskRequestEvent, UserChatRejectedEvent } from '@raven/shared';
import { Orchestrator, type OrchestratorDeps } from '../orchestrator/orchestrator.ts';
import { EventBus } from '../event-bus/event-bus.ts';
import { SessionManager } from '../session-manager/session-manager.ts';
import { createMessageStore } from '../session-manager/message-store.ts';
import { closeDatabase, getDb, initDatabase } from '../db/database.ts';
import type { NamedAgentStore } from '../agent-registry/yaml-named-agent-store.ts';
import type { CapabilityLibrary } from '../capability-library/capability-library.ts';

const agent: NamedAgent = {
  id: 'raven',
  name: 'raven',
  description: null,
  instructions: 'Fixture persona',
  skills: [],
  model: null,
  maxTurns: null,
  isDefault: true,
  createdAt: '',
  updatedAt: '',
};

describe('chat capability preflight', () => {
  let root: string;
  let deps: OrchestratorDeps;
  const requests = vi.fn<(event: AgentTaskRequestEvent) => void>();
  const rejected = vi.fn<(event: UserChatRejectedEvent) => void>();
  const accepted = vi.fn();
  const collectMcpServers = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    root = mkdtempSync(join(tmpdir(), 'raven-chat-capabilities-'));
    initDatabase(join(root, 'test.db'));
    const eventBus = new EventBus();
    eventBus.on('agent:task:request', requests);
    eventBus.on('user:chat:rejected', rejected);
    eventBus.on('user:chat:accepted', accepted);
    deps = {
      eventBus,
      sessionManager: new SessionManager(),
      messageStore: createMessageStore({ basePath: join(root, 'sessions') }),
      port: 0,
      capabilityLibrary: { collectMcpServers } as unknown as CapabilityLibrary,
    };
  });

  afterEach(() => {
    deps.eventBus.removeAllListeners();
    closeDatabase();
    rmSync(root, { recursive: true, force: true });
  });

  function send(sessionId?: string, projectId = 'meta') {
    deps.eventBus.emit({
      id: 'request-1',
      timestamp: Date.now(),
      source: 'test',
      type: 'user:chat:message',
      payload: { requestId: 'client-request', projectId, sessionId, message: 'Hello' },
    });
  }

  it.each(['store', 'resolver'])(
    'preserves active session/transcript on %s failure, then accepts a valid turn',
    async (failure) => {
      const getDefaultAgent = vi.fn(() => agent);
      const resolveAgentCapabilities = vi.fn(() => ({
        mcpServers: {},
        agentDefinitions: {},
        plugins: [],
      }));
      const error = () => {
        throw new Error('invalid agent binding');
      };
      if (failure === 'store') getDefaultAgent.mockImplementationOnce(error);
      else resolveAgentCapabilities.mockImplementationOnce(error);
      new Orchestrator({
        ...deps,
        namedAgentStore: { getDefaultAgent } as unknown as NamedAgentStore,
        agentResolver: { resolveAgentCapabilities },
      });
      const session = deps.sessionManager.getOrCreateSession('meta');
      deps.sessionManager.linkSdkSession(session.id, 'existing-sdk-session');
      deps.messageStore.appendMessage(session.id, {
        role: 'assistant',
        content: 'Existing answer',
      });
      const before = deps.sessionManager.getSession(session.id);
      const messages = deps.messageStore.getMessages(session.id);
      send(session.id);
      await vi.waitFor(() => expect(rejected).toHaveBeenCalledOnce());
      expect(rejected.mock.calls[0][0].payload).toMatchObject({
        requestId: 'client-request',
        sessionId: session.id,
        error: expect.stringContaining('invalid agent binding'),
      });
      expect(deps.sessionManager.getSession(session.id)).toEqual(before);
      expect(deps.messageStore.getMessages(session.id)).toEqual(messages);
      expect(deps.sessionManager.getSdkSessionId(session.id)).toBe('existing-sdk-session');
      expect(requests).not.toHaveBeenCalled();
      expect(accepted).not.toHaveBeenCalled();
      expect(collectMcpServers).not.toHaveBeenCalled();

      send(session.id);
      await vi.waitFor(() => expect(requests).toHaveBeenCalledOnce());
      expect(requests.mock.calls[0][0].payload).toMatchObject({
        sessionId: session.id,
        namedAgentId: 'raven',
        namedAgentInstructions: 'Fixture persona',
        mcpServers: {},
        agentDefinitions: {},
        plugins: [],
      });
      expect(deps.messageStore.getMessages(session.id)).toHaveLength(messages.length + 1);
      expect(accepted).toHaveBeenCalledOnce();
      const stored = deps.messageStore.getMessages(session.id).at(-1)!;
      expect(accepted.mock.calls[0][0]).toMatchObject({
        type: 'user:chat:accepted',
        payload: {
          requestId: 'client-request',
          projectId: 'meta',
          sessionId: session.id,
          messageId: stored.id,
        },
      });
      expect(accepted.mock.calls[0][0].id).not.toBe('client-request');
    },
  );

  it.each(['store', 'resolver'])(
    'rejects a partial %s configuration before creating a project/session',
    async (configured) => {
      new Orchestrator({
        ...deps,
        namedAgentStore: configured === 'store' ? ({} as NamedAgentStore) : undefined,
        agentResolver:
          configured === 'resolver' ? { resolveAgentCapabilities: vi.fn() } : undefined,
      });
      send(undefined, 'not-created');
      await vi.waitFor(() => expect(rejected).toHaveBeenCalledOnce());
      expect(rejected.mock.calls[0][0].payload.error).toContain('requires both');
      expect(
        getDb().prepare('SELECT id FROM projects WHERE id = ?').get('not-created'),
      ).toBeUndefined();
      expect(requests).not.toHaveBeenCalled();
      expect(collectMcpServers).not.toHaveBeenCalled();
    },
  );

  it('allows absent optional agent dependencies with empty bindings despite a populated library', async () => {
    new Orchestrator(deps);
    send();
    await vi.waitFor(() => expect(requests).toHaveBeenCalledOnce());
    expect(requests.mock.calls[0][0].payload).toMatchObject({
      mcpServers: {},
      agentDefinitions: {},
      plugins: [],
    });
    expect(collectMcpServers).not.toHaveBeenCalled();
  });

  it('rejects a failed transcript write without claiming acceptance or dispatching work', async () => {
    new Orchestrator(deps);
    const session = deps.sessionManager.getOrCreateSession('meta');
    vi.spyOn(deps.messageStore, 'appendMessage').mockReturnValueOnce(undefined);
    send(session.id);
    await vi.waitFor(() => expect(rejected).toHaveBeenCalledOnce());
    expect(rejected.mock.calls[0][0].payload.requestId).toBe('client-request');
    expect(rejected.mock.calls[0][0].payload.error).toContain('save your message');
    expect(accepted).not.toHaveBeenCalled();
    expect(requests).not.toHaveBeenCalled();
    expect(deps.sessionManager.getSession(session.id)?.status).toBe('idle');
    expect(deps.messageStore.getMessages(session.id)).toEqual([]);
  });

  it('drains an admitted preflight during stop without saving or dispatching the turn', async () => {
    const orchestrator = new Orchestrator(deps);
    send();
    await orchestrator.stop();
    expect(rejected).toHaveBeenCalledOnce();
    expect(rejected.mock.calls[0][0].payload.error).toContain('stopping');
    expect(accepted).not.toHaveBeenCalled();
    expect(requests).not.toHaveBeenCalled();
    expect(deps.sessionManager.getProjectSessions('meta')).toEqual([]);
    send();
    await orchestrator.stop();
    expect(rejected).toHaveBeenCalledOnce();
    expect(requests).not.toHaveBeenCalled();
  });
});
