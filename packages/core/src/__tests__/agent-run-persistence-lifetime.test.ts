import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTaskCompleteEvent } from '@raven/shared';
import { AgentManager } from '../agent-manager/agent-manager.ts';
import { runAgentTask } from '../agent-manager/agent-session.ts';
import type { ExecutionLogger } from '../agent-manager/execution-logger.ts';
import { EventBus } from '../event-bus/event-bus.ts';

vi.mock('../config.ts', () => ({ getConfig: () => ({ RAVEN_MAX_CONCURRENT_AGENTS: 1 }) }));
vi.mock('../agent-manager/agent-session.ts', () => ({ runAgentTask: vi.fn() }));

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('agent run persistence lifetime', () => {
  const managers: AgentManager[] = [];
  const gates: ReturnType<typeof deferred>[] = [];
  beforeEach(() => {
    vi.mocked(runAgentTask).mockReset().mockResolvedValue({
      taskId: 'work',
      success: true,
      result: 'Actual result',
      errors: [],
      durationMs: 12,
    });
  });
  afterEach(async () => {
    for (const gate of gates) gate.release();
    for (const manager of managers) await manager.stop();
    gates.length = 0;
    managers.length = 0;
  });
  function gate() {
    const value = deferred();
    gates.push(value);
    return value;
  }
  function fixture(overrides: Partial<ExecutionLogger> = {}) {
    const eventBus = new EventBus();
    const executionLogger: ExecutionLogger = {
      logTaskStart: vi.fn(async () => undefined),
      logTaskComplete: vi.fn(async () => undefined),
      queryTasks: () => [],
      getTaskById: () => undefined,
      getTaskStats: () => ({
        total1h: 0,
        succeeded1h: 0,
        failed1h: 0,
        avgDurationMs: null,
        lastTaskAt: null,
      }),
      getPerSkillStats: () => [],
      ...overrides,
    };
    const manager = new AgentManager({ eventBus, executionLogger });
    managers.push(manager);
    const completions: AgentTaskCompleteEvent[] = [];
    eventBus.on<AgentTaskCompleteEvent>('agent:task:complete', (event) => completions.push(event));
    const request = (taskId: string) =>
      eventBus.emit({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        source: 'test',
        type: 'agent:task:request',
        payload: {
          taskId,
          projectId: 'meta',
          skillName: 'orchestrator',
          prompt: taskId,
          priority: 'normal',
          mcpServers: {},
        },
      });
    return { eventBus, executionLogger, manager, completions, request };
  }

  it('waits for start persistence and cancels without dispatch if stop arrives while held', async () => {
    const start = gate();
    const data = fixture({ logTaskStart: vi.fn(async () => start.promise) });
    const messages = vi.fn();
    data.eventBus.on('agent:message', messages);
    data.request('held-start');
    expect(runAgentTask).not.toHaveBeenCalled();
    let stopped = false;
    const stopping = data.manager.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    expect(data.completions).toHaveLength(0);
    start.release();
    await stopping;
    expect(runAgentTask).not.toHaveBeenCalled();
    expect(messages).not.toHaveBeenCalled();
    expect(data.executionLogger.logTaskComplete).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'cancelled' }),
    );
    expect(data.completions).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ taskId: 'held-start', cancelled: true, success: false }),
      }),
    ]);
  });

  it('holds terminal events and the concurrency slot until completion persistence settles', async () => {
    const terminal = gate();
    const entered = gate();
    const data = fixture({
      logTaskComplete: vi.fn(async (task) => {
        if (task.id === 'first') {
          entered.release();
          await terminal.promise;
        }
      }),
    });
    data.request('first');
    await entered.promise;
    data.request('second');
    expect(runAgentTask).toHaveBeenCalledTimes(1);
    expect(data.completions).toHaveLength(0);
    expect(data.manager.getQueueLength()).toBe(1);
    expect(data.manager.getActiveTasks().running).toEqual([
      expect.objectContaining({ taskId: 'first', status: 'finalizing' }),
    ]);
    expect(data.manager.cancelTask('first')).toBe(false);
    terminal.release();
    await vi.waitFor(() => expect(data.completions).toHaveLength(2));
    expect(data.completions.map((event) => event.payload.taskId)).toEqual(['first', 'second']);
  });

  it('drains a held queued cancellation as well as running work before stopping', async () => {
    const active = gate();
    const queued = gate();
    const entered = gate();
    vi.mocked(runAgentTask).mockImplementation(async () => {
      await active.promise;
      return {
        taskId: 'running',
        success: false,
        result: '',
        durationMs: 0,
        errors: ['cancelled'],
      };
    });
    const data = fixture({
      logTaskComplete: vi.fn(async (task) => {
        if (task.id === 'queued') {
          entered.release();
          await queued.promise;
        }
      }),
    });
    data.request('running');
    await vi.waitFor(() => expect(runAgentTask).toHaveBeenCalledTimes(1));
    data.request('queued');
    let stopped = false;
    const stopping = data.manager.stop().then(() => {
      stopped = true;
    });
    await entered.promise;
    active.release();
    await vi.waitFor(() => expect(data.completions).toHaveLength(1));
    expect(stopped).toBe(false);
    queued.release();
    await stopping;
    expect(data.completions.map((event) => event.payload.taskId).sort()).toEqual([
      'queued',
      'running',
    ]);
    expect(runAgentTask).toHaveBeenCalledTimes(1);
  });

  it('reports a blocked outcome without dispatch when start persistence fails', async () => {
    const data = fixture({
      logTaskStart: vi.fn(async () => {
        throw new Error('Record changed on disk');
      }),
    });
    const alerts = vi.fn();
    data.eventBus.on('system:health:alert', alerts);
    data.request('conflict');
    await vi.waitFor(() => expect(data.completions).toHaveLength(1));
    expect(runAgentTask).not.toHaveBeenCalled();
    expect(data.completions[0].payload).toMatchObject({ success: false, blocked: true });
    expect(data.completions[0].payload.errors?.join(' ')).toContain('Record changed on disk');
    expect(alerts).toHaveBeenCalledTimes(1);
  });

  it('preserves the actual result but never emits success when its record cannot commit', async () => {
    const data = fixture({
      logTaskComplete: vi.fn(async () => {
        throw new Error('History write failed');
      }),
    });
    data.request('finished-work');
    await vi.waitFor(() => expect(data.completions).toHaveLength(1));
    expect(data.completions[0].payload).toMatchObject({
      result: 'Actual result',
      success: false,
      blocked: true,
    });
    expect(data.completions[0].payload.errors?.join(' ')).toContain('History write failed');
    expect(runAgentTask).toHaveBeenCalledTimes(1);
  });
});
