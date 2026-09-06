import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../event-bus/event-bus.ts';
import { runAgentTask, setActiveBackend } from '../agent-manager/agent-session.ts';
import type { AgentBackend, BackendOptions } from '../agent-manager/agent-backend.ts';
import type { AgentTask, McpServerConfig } from '@raven/shared';
import type { MemoryStore, MemoryWriteResult } from '../agent-memory/memory-store.ts';
import type { RavenMcpDeps } from '../mcp-server/types.ts';
import type { NamedAgentStore } from '../agent-registry/yaml-named-agent-store.ts';
import type { MessageStore } from '../session-manager/message-store.ts';
import type { SessionManager } from '../session-manager/session-manager.ts';
import { setConfig } from '../config.ts';
import { buildTestConfig } from './fixtures/raven-fixture.ts';

type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
type RegisteredTool = { handler: ToolHandler };
type SdkServer = { instance?: { _registeredTools?: Record<string, RegisteredTool> } };

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: 'task-lifetime-test',
    skillName: 'orchestrator',
    namedAgentId: 'test-agent',
    prompt: 'test prompt',
    status: 'running',
    priority: 'normal',
    mcpServers: {},
    agentDefinitions: {},
    createdAt: Date.now(),
    ...overrides,
  };
}

function eventBus(): EventBus {
  return new EventBus();
}

function memoryStore(overrides: Partial<MemoryStore> = {}): MemoryStore {
  return {
    getDirectory: vi.fn(() => '/tmp/unused-memory-fixture'),
    withDirectory: vi.fn(async (_projectId, operation) => operation('/tmp/unused-memory-fixture')),
    apply: vi.fn(async (): Promise<MemoryWriteResult> => ({ ok: true })),
    read: vi.fn(async () => ''),
    readIndex: vi.fn(async () => null),
    write: vi.fn(async (): Promise<MemoryWriteResult> => ({ ok: true })),
    update: vi.fn(async (): Promise<MemoryWriteResult> => ({ ok: true })),
    remove: vi.fn(async (): Promise<MemoryWriteResult> => ({ ok: true })),
    list: vi.fn(async () => []),
    usage: vi.fn(async () => ({
      files: 0,
      totalBytes: 0,
      maxFiles: 30,
      maxTotalBytes: 64 * 1024,
    })),
    ...overrides,
  };
}

function messageStore(): MessageStore {
  return {
    appendMessage: vi.fn(() => 'message-id'),
    getMessages: vi.fn(() => []),
    appendRawMessage: vi.fn(),
    getRawMessages: vi.fn(() => []),
  };
}

function sessionManager(): SessionManager {
  return {
    getSdkSessionId: vi.fn(() => undefined),
    getSdkResumeState: vi.fn(() => ({ status: 'missing' })),
    linkSdkSession: vi.fn(),
  } as unknown as SessionManager;
}

function registeredTool(
  options: BackendOptions,
  serverName: string,
  toolName: string,
): ToolHandler {
  const server = options.mcpServers[serverName] as SdkServer | undefined;
  const registered = server?.instance?._registeredTools?.[toolName];
  if (!registered) throw new Error(`registered tool not found: ${serverName}/${toolName}`);
  return registered.handler;
}

function baseOptions(
  event: EventBus,
  backend: AgentBackend,
  options: {
    memoryStore: MemoryStore;
    ravenMcpDeps?: RavenMcpDeps;
    signal?: AbortSignal;
    task?: Partial<AgentTask>;
    messageStore?: MessageStore;
    sessionManager?: SessionManager;
    mcpServers?: Record<string, McpServerConfig>;
  },
): Promise<Awaited<ReturnType<typeof runAgentTask>>> {
  setActiveBackend(backend);
  return runAgentTask({
    task: task(options.task),
    eventBus: event,
    mcpServers: options.mcpServers ?? {},
    agentDefinitions: {},
    memoryStore: options.memoryStore,
    ravenMcpDeps: options.ravenMcpDeps,
    signal: options.signal,
    messageStore: options.messageStore,
    sessionManager: options.sessionManager,
  });
}

function nextImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  delete process.env['TEST_AGENT_SESSION_MCP_TOKEN'];
  vi.restoreAllMocks();
});

beforeEach(() => {
  setConfig(buildTestConfig());
});

describe('runAgentTask MCP call lifetime', () => {
  it('materializes HTTP authorization only for the backend', async () => {
    process.env['TEST_AGENT_SESSION_MCP_TOKEN'] = 'fake-http-secret';
    const template = {
      type: 'http' as const,
      url: 'https://mcp.example.com',
      headers: { Authorization: 'Bearer ${TEST_AGENT_SESSION_MCP_TOKEN}' },
    };
    const backend: AgentBackend = async (options) => {
      expect(options.mcpServers.remote).toEqual({
        type: 'http',
        url: 'https://mcp.example.com',
        headers: { Authorization: 'Bearer fake-http-secret' },
        alwaysLoad: true,
      });
      return { result: 'done', success: true, errors: [] };
    };

    const result = await baseOptions(eventBus(), backend, {
      memoryStore: memoryStore(),
      mcpServers: { remote: template },
      task: { mcpServers: { remote: template } },
    });

    expect(result).toMatchObject({ success: true, result: 'done' });
    expect(JSON.stringify(template)).not.toContain('fake-http-secret');
  });

  it('redacts a materialized MCP secret from backend failures and stderr', async () => {
    process.env['TEST_AGENT_SESSION_MCP_TOKEN'] = 'fake-http-secret';
    const backend: AgentBackend = async (options) => {
      options.onStderr('authorization failed for fake-http-');
      options.onStderr('secret');
      throw new Error('provider rejected fake-http-secret');
    };
    const result = await baseOptions(eventBus(), backend, {
      memoryStore: memoryStore(),
      mcpServers: {
        remote: {
          type: 'http',
          url: 'https://mcp.example.com',
          headers: { Authorization: 'Bearer ${TEST_AGENT_SESSION_MCP_TOKEN}' },
        },
      },
    });

    expect(JSON.stringify(result)).not.toContain('fake-http-secret');
    expect(result.errors).toEqual([
      'provider rejected [redacted]',
      'stderr: authorization failed for [redacted]',
    ]);
  });

  it('redacts a materialized MCP secret from a returned failure result', async () => {
    process.env['TEST_AGENT_SESSION_MCP_TOKEN'] = 'fake-http-secret';
    const backend: AgentBackend = async () => ({
      result: 'authentication failed for fake-http-secret',
      success: false,
      errors: ['remote rejected fake-http-secret'],
    });
    const result = await baseOptions(eventBus(), backend, {
      memoryStore: memoryStore(),
      mcpServers: {
        remote: {
          type: 'http',
          url: 'https://mcp.example.com',
          headers: { Authorization: 'Bearer ${TEST_AGENT_SESSION_MCP_TOKEN}' },
        },
      },
    });

    expect(result).toMatchObject({
      success: false,
      result: 'authentication failed for [redacted]',
      errors: ['remote rejected [redacted]'],
    });
    expect(JSON.stringify(result)).not.toContain('fake-http-secret');
  });

  it('does not save a cold SDK lineage observed before cancellation', async () => {
    const controller = new AbortController();
    const sessions = sessionManager();
    const backend: AgentBackend = async (options) => {
      options.onSessionId?.('uncertain-cold-session');
      controller.abort();
      return { result: '', success: false, errors: ['cancelled'] };
    };
    const result = await baseOptions(eventBus(), backend, {
      memoryStore: memoryStore(),
      sessionManager: sessions,
      signal: controller.signal,
      task: { sessionId: 'session-1', modelConfig: { model: 'claude-sonnet-5' } },
    });
    expect(result.success).toBe(false);
    expect(sessions.linkSdkSession).not.toHaveBeenCalled();
  });

  it('drains held Raven and memory handlers after normal backend completion', async () => {
    const events = eventBus();
    const memoryRelease = deferred<MemoryWriteResult>();
    const agentRelease = deferred<{ id: string }>();
    const backendReturned = deferred<boolean>();
    const memory = memoryStore({ write: vi.fn(async () => memoryRelease.promise) });
    const createAgent = vi.fn(async () => agentRelease.promise);
    const backend: AgentBackend = async (options) => {
      const ravenCreate = registeredTool(options, 'raven', 'create_agent');
      const memoryWrite = registeredTool(options, 'memory', 'memory_write');
      void ravenCreate({ name: 'held-agent' }, {}).catch(() => undefined);
      void memoryWrite({ path: 'held.md', content: 'held' }, {}).catch(() => undefined);
      await vi.waitFor(() => {
        expect(createAgent).toHaveBeenCalledOnce();
        expect(memory.write).toHaveBeenCalledOnce();
      });
      backendReturned.resolve(true);
      return { result: 'done', success: true, errors: [] };
    };

    const running = baseOptions(events, backend, {
      memoryStore: memory,
      ravenMcpDeps: {
        eventBus: events,
        namedAgentStore: { createAgent } as unknown as NamedAgentStore,
      },
    });
    await vi.waitFor(() => {
      expect(createAgent).toHaveBeenCalledOnce();
      expect(memory.write).toHaveBeenCalledOnce();
    });

    try {
      // Flush completion continuations after the backend reaches its return.
      await backendReturned.promise;
      let finished = false;
      void running.then(() => {
        finished = true;
      });
      await nextImmediate();
      expect(finished).toBe(false);

      memoryRelease.resolve({ ok: true });
      await nextImmediate();
      expect(finished).toBe(false);
      agentRelease.resolve({ id: 'held-agent' });
      await expect(running).resolves.toMatchObject({ success: true, result: 'done' });
    } finally {
      memoryRelease.resolve({ ok: true });
      agentRelease.resolve({ id: 'held-agent' });
      await running.catch(() => undefined);
    }
  });

  it('closes admission on abort and waits for the admitted handler to settle', async () => {
    const events = eventBus();
    const controller = new AbortController();
    const release = deferred<MemoryWriteResult>();
    const backendRelease = deferred<boolean>();
    const backendReturned = deferred<boolean>();
    const memory = memoryStore({ write: vi.fn(async () => release.promise) });
    let heldWrite: Promise<unknown> | undefined;
    let backendOptions: BackendOptions | undefined;
    const backend: AgentBackend = async (options) => {
      backendOptions = options;
      const write = registeredTool(options, 'memory', 'memory_write');
      heldWrite = write({ path: 'abort.md', content: 'held' }, {});
      await vi.waitFor(() => expect(memory.write).toHaveBeenCalledOnce());
      await backendRelease.promise;
      backendReturned.resolve(true);
      return { result: 'ignored', success: true, errors: [] };
    };

    const running = baseOptions(events, backend, {
      memoryStore: memory,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(memory.write).toHaveBeenCalledOnce());
    try {
      controller.abort();
      backendRelease.resolve(true);

      await backendReturned.promise;
      let finished = false;
      void running.then(() => {
        finished = true;
      });
      await nextImmediate();
      expect(finished).toBe(false);

      release.resolve({ ok: true });
      await heldWrite;
      await expect(running).resolves.toMatchObject({ success: false, errors: ['cancelled'] });
      const late = registeredTool(backendOptions!, 'memory', 'memory_write');
      await expect(late({ path: 'late.md', content: 'must not write' }, {})).resolves.toMatchObject(
        {
          isError: true,
        },
      );
      expect(memory.write).toHaveBeenCalledOnce();
    } finally {
      release.resolve({ ok: true });
      backendRelease.resolve(true);
      await heldWrite?.catch(() => undefined);
      await running.catch(() => undefined);
    }
  });

  it('rejects late tools and callbacks after normal return, and handler errors release', async () => {
    const events = eventBus();
    const emitted: unknown[] = [];
    events.on('*', (event) => emitted.push(event));
    const write = vi.fn(async () => {
      throw new Error('write failed');
    });
    const memory = memoryStore({ write });
    const messages = messageStore();
    const sessions = sessionManager();
    let optionsAfterRun: BackendOptions | undefined;
    const backend: AgentBackend = async (options) => {
      optionsAfterRun = options;
      const handler = registeredTool(options, 'memory', 'memory_write');
      await expect(handler({ path: 'failed.md', content: 'x' }, {})).resolves.toMatchObject({
        isError: true,
      });
      return { result: 'done', success: true, errors: [] };
    };

    await expect(
      baseOptions(events, backend, {
        memoryStore: memory,
        task: { sessionId: 'session-1' },
        messageStore: messages,
        sessionManager: sessions,
      }),
    ).resolves.toMatchObject({ success: true });
    const eventCount = emitted.length;
    const lateWrite = registeredTool(optionsAfterRun!, 'memory', 'memory_write');
    const lateResult = await lateWrite({ path: 'late.md', content: 'must not write' }, {});
    expect(lateResult).toMatchObject({ isError: true });
    expect(write).toHaveBeenCalledOnce();

    optionsAfterRun!.onAssistantMessage('late assistant message');
    optionsAfterRun!.onToolUse?.('late_tool', '{}');
    optionsAfterRun!.onToolResult?.({
      toolUseId: 'late',
      output: 'late result',
      isError: false,
    });
    optionsAfterRun!.onRawMessage?.('{"late":true}');
    optionsAfterRun!.onSessionId?.('late-session');
    optionsAfterRun!.onStderr('late stderr');
    expect(emitted).toHaveLength(eventCount);
    expect(messages.appendMessage).not.toHaveBeenCalled();
    expect(messages.appendRawMessage).not.toHaveBeenCalled();
    expect(sessions.linkSdkSession).not.toHaveBeenCalled();
  });

  it('returns after the cancellation grace while an uncooperative backend remains pending', async () => {
    const events = eventBus();
    const controller = new AbortController();
    const backendStarted = deferred<boolean>();
    const backendRelease = deferred<boolean>();
    const backendSettled = deferred<boolean>();
    let backendCompleted = false;
    const memory = memoryStore();
    const messages = messageStore();
    const sessions = sessionManager();
    let backendOptions: BackendOptions | undefined;
    const backend: AgentBackend = async (options) => {
      backendOptions = options;
      backendStarted.resolve(true);
      try {
        await backendRelease.promise;
        return { result: 'late', success: true, errors: [] };
      } finally {
        backendCompleted = true;
        backendSettled.resolve(true);
      }
    };

    const running = baseOptions(events, backend, {
      memoryStore: memory,
      signal: controller.signal,
      task: { sessionId: 'session-1' },
      messageStore: messages,
      sessionManager: sessions,
    });
    try {
      await backendStarted.promise;
      controller.abort();
      const result = await running;
      expect(backendCompleted).toBe(false);
      expect(result).toMatchObject({ success: false, errors: ['cancelled'] });

      const lateWrite = registeredTool(backendOptions!, 'memory', 'memory_write');
      await expect(
        lateWrite({ path: 'late.md', content: 'must not write' }, {}),
      ).resolves.toMatchObject({
        isError: true,
      });
      expect(memory.write).not.toHaveBeenCalled();

      // These callbacks were captured from this run; invoke the same sinks
      // after its normal cancellation return to prove every persistence path
      // is lifetime-gated, including session-id linking.
      const lateOptions = backendOptions!;
      lateOptions.onAssistantMessage('late assistant', undefined);
      lateOptions.onToolUse?.('late_tool', '{}');
      lateOptions.onToolResult?.({
        toolUseId: 'late-tool-use',
        output: 'late result',
        isError: false,
      });
      lateOptions.onRawMessage?.('{"late":true}');
      lateOptions.onSessionId?.('late-sdk-session');
      expect(messages.appendMessage).not.toHaveBeenCalled();
      expect(messages.appendRawMessage).not.toHaveBeenCalled();
      expect(sessions.linkSdkSession).not.toHaveBeenCalled();
    } finally {
      backendRelease.resolve(true);
      await backendSettled.promise;
      await running.catch(() => undefined);
    }
  });
});
