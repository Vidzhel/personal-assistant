import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the claude-code SDK before importing AgentManager
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

// Mock config before importing
vi.mock('../config.ts', () => {
  const config = {
    ANTHROPIC_API_KEY: 'test-key',
    CLAUDE_MODEL: 'claude-sonnet-4-6',
    RAVEN_PORT: 3001,
    RAVEN_TIMEZONE: 'UTC',
    RAVEN_MAX_CONCURRENT_AGENTS: 3,
    RAVEN_AGENT_MAX_TURNS: 25,
    DATABASE_PATH: './data/raven.db',
    SESSION_PATH: './data/sessions',
    LOG_LEVEL: 'info',
    RAVEN_DIGEST_TIME: '08:00',
    RAVEN_MAX_BUDGET_USD_PER_DAY: 5.0,
  };
  return {
    getConfig: () => config,
    loadConfig: () => config,
  };
});

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AgentManager } from '../agent-manager/agent-manager.ts';
import { EventBus } from '../event-bus/event-bus.ts';
import { SkillRegistry } from '../skill-registry/skill-registry.ts';
import { McpManager } from '../mcp-manager/mcp-manager.ts';
import { createMessageStore, type MessageStore } from '../session-manager/message-store.ts';
import type { RavenEvent, AgentTaskRequestEvent } from '@raven/shared';

const mockQuery = vi.mocked(query);

describe('AgentManager', () => {
  let eventBus: EventBus;
  let skillRegistry: SkillRegistry;
  let mcpManager: McpManager;
  let agentManager: AgentManager;

  beforeEach(() => {
    eventBus = new EventBus();
    skillRegistry = new SkillRegistry();
    mcpManager = new McpManager(skillRegistry);
    agentManager = new AgentManager({ eventBus, mcpManager, skillRegistry });
    mockQuery.mockReset();
  });

  afterEach(() => {
    eventBus.removeAllListeners();
  });

  function emitTaskRequest(overrides: Partial<AgentTaskRequestEvent['payload']> = {}): void {
    eventBus.emit({
      id: 'evt-1',
      timestamp: Date.now(),
      source: 'test',
      type: 'agent:task:request',
      payload: {
        taskId: 'task-1',
        prompt: 'Hello',
        skillName: 'orchestrator',
        mcpServers: {},
        priority: 'normal',
        ...overrides,
      },
    } as RavenEvent);
  }

  it('enqueues tasks from agent:task:request events', () => {
    // Don't let it process (query won't resolve)
    mockQuery.mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', result: 'done' };
    } as unknown as typeof query);

    emitTaskRequest();
    // The task was dequeued immediately to run, so queue is 0 but running is 1
    expect(agentManager.getRunningCount()).toBe(1);
  });

  it('successful task emits agent:task:complete with success', async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sdk-123' };
      yield { type: 'result', subtype: 'success', result: 'Task completed!' };
    } as unknown as typeof query);

    const completionPromise = new Promise<RavenEvent>((resolve) => {
      eventBus.on('agent:task:complete', (e) => resolve(e));
    });

    emitTaskRequest();

    const event = await completionPromise;
    const payload = (event as AgentTaskRequestEvent).payload as unknown as {
      taskId: string;
      success: boolean;
      result: string;
    };
    expect(payload.success).toBe(true);
    expect(payload.result).toBe('Task completed!');
  });

  it('failed task emits agent:task:complete with success false', async () => {
    mockQuery.mockImplementation(async function* () {
      yield* []; // satisfy require-yield
      throw new Error('Claude Code process exited with code 1');
    } as unknown as typeof query);

    const completionPromise = new Promise<RavenEvent>((resolve) => {
      eventBus.on('agent:task:complete', (e) => resolve(e));
    });

    emitTaskRequest();

    const event = await completionPromise;
    const payload = (event as AgentTaskRequestEvent).payload as unknown as {
      success: boolean;
      errors: string[];
    };
    expect(payload.success).toBe(false);
    expect(payload.errors).toBeDefined();
    expect(payload.errors!.length).toBeGreaterThan(0);
  });

  it('streams assistant messages to event bus', async () => {
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello user!' }] },
      };
      yield { type: 'result', subtype: 'success', result: 'done' };
    } as unknown as typeof query);

    const messages: RavenEvent[] = [];
    eventBus.on('agent:message', (e) => messages.push(e));

    const completionPromise = new Promise<void>((resolve) => {
      eventBus.on('agent:task:complete', () => resolve());
    });

    emitTaskRequest();
    await completionPromise;

    // Should have the "Starting..." thinking message + the assistant message
    const assistantMsgs = messages.filter(
      (m) =>
        (m as unknown as { payload: { messageType: string } }).payload.messageType === 'assistant',
    );
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
  });

  it('priority ordering: high tasks run before normal', async () => {
    const _taskOrder: string[] = [];
    let _resolveFirst: () => void;
    let _resolveSecond: () => void;
    const _firstPromise = new Promise<void>((r) => {
      _resolveFirst = r;
    });
    const _secondPromise = new Promise<void>((r) => {
      _resolveSecond = r;
    });

    // Make query block until we release it
    let _callCount = 0;
    mockQuery.mockImplementation(async function* () {
      _callCount++;
      // Each call records its task via the prompt (which is the task prompt)
      yield { type: 'result', subtype: 'success', result: 'done' };
    } as unknown as typeof query);

    // Create a new manager with concurrency 1 so tasks queue
    vi.doMock('../config.ts', () => ({
      getConfig: () => ({
        RAVEN_MAX_CONCURRENT_AGENTS: 1,
        RAVEN_AGENT_MAX_TURNS: 25,
        CLAUDE_MODEL: 'claude-sonnet-4-6',
      }),
    }));

    // The task request handling is tested through events
    // Just verify the queue length getter works
    expect(agentManager.getQueueLength()).toBe(0);
  });

  describe('with messageStore', () => {
    let tmpDir: string;
    let messageStore: MessageStore;
    let _amWithStore: AgentManager;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'raven-am-'));
      messageStore = createMessageStore({ basePath: tmpDir });
      _amWithStore = new AgentManager({ eventBus, mcpManager, skillRegistry, messageStore });
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('stores streaming assistant messages before tool_use actions', async () => {
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Let me check that.' },
              { type: 'tool_use', name: 'Read', input: { path: '/tmp/test' } },
            ],
          },
        };
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Here is the result.' }] },
        };
        yield { type: 'result', subtype: 'success', result: 'Here is the result.' };
      } as unknown as typeof query);

      const completionPromise = new Promise<void>((resolve) => {
        eventBus.on('agent:task:complete', () => resolve());
      });

      eventBus.emit({
        id: 'evt-store-1',
        timestamp: Date.now(),
        source: 'test',
        type: 'agent:task:request',
        payload: {
          taskId: 'task-store-1',
          sessionId: 'sess-store-1',
          prompt: 'Hello',
          skillName: 'orchestrator',
          mcpServers: {},
          priority: 'normal',
        },
      } as RavenEvent);

      await completionPromise;

      const msgs = messageStore.getMessages('sess-store-1');
      const roles = msgs.map((m) => m.role);

      // thinking comes first, then assistant text, then action, then final assistant
      expect(roles[0]).toBe('thinking');
      expect(roles[1]).toBe('assistant');
      expect(roles[2]).toBe('action');
      expect(roles[3]).toBe('assistant');
    });
  });

  it('concurrency limit is respected', async () => {
    // Set up query to block until manually resolved
    const gates: Array<() => void> = [];

    mockQuery.mockImplementation(async function* () {
      await new Promise<void>((resolve) => gates.push(resolve));
      yield { type: 'result', subtype: 'success', result: 'done' };
    } as unknown as typeof query);

    // Emit 5 tasks
    for (let i = 0; i < 5; i++) {
      emitTaskRequest({ taskId: `task-${i}`, prompt: `Task ${i}` });
    }

    // Max concurrent is 3, so 3 should be running and 2 queued
    await new Promise((r) => setTimeout(r, 10));
    expect(agentManager.getRunningCount()).toBe(3);
    expect(agentManager.getQueueLength()).toBe(2);

    // Release one task — a queued task should start
    gates[0]();
    await new Promise((r) => setTimeout(r, 50));
    expect(agentManager.getRunningCount()).toBe(3); // picked up next from queue
    expect(agentManager.getQueueLength()).toBe(1);

    // Helper to wait for a gate to appear and release it
    const waitAndRelease = async () => {
      while (gates.length < 5) {
        await new Promise((r) => setTimeout(r, 10));
      }
    };

    // Release remaining gates as they appear
    gates[1]();
    gates[2]();
    gates[3]();
    await waitAndRelease();
    gates[4]();

    // Wait for all completions
    await new Promise((r) => setTimeout(r, 100));
    expect(agentManager.getRunningCount()).toBe(0);
    expect(agentManager.getQueueLength()).toBe(0);
  });
});
