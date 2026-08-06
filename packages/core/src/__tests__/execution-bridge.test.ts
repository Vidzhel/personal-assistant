import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus } from '../event-bus/event-bus.ts';
import { createExecutionBridge } from '../task-execution/execution-bridge.ts';

function makeDeps() {
  const eventBus = new EventBus();
  const executionEngine = {
    getTree: vi.fn(),
    onTaskCompleted: vi.fn().mockResolvedValue(undefined),
    onTaskBlocked: vi.fn(),
  };
  const gmailAgent = { id: 'agent-gmail', name: 'gmail', instructions: '' };
  const defaultAgent = { id: 'agent-raven', name: 'raven', instructions: '' };
  const namedAgentStore = {
    getAgentByName: vi.fn((n: string) => (n === 'gmail' ? gmailAgent : undefined)),
    getAgent: vi.fn(() => undefined),
    getDefaultAgent: vi.fn(() => defaultAgent),
  };
  const agentResolver = {
    resolveAgentCapabilities: vi.fn(() => ({
      mcpServers: { gmail: { command: 'x' } },
      agentDefinitions: { 'gmail-reader': { description: 'd', prompt: 'p' } },
      plugins: [],
    })),
  };
  return { eventBus, executionEngine, namedAgentStore, agentResolver };
}

function runAgentEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'e1',
    timestamp: Date.now(),
    source: 'test',
    type: 'execution:task:run-agent' as const,
    payload: {
      treeId: 't1',
      taskId: 'task-1',
      agent: 'gmail',
      prompt: 'do it',
      parentTaskId: 'root',
      ...overrides,
    },
  };
}

describe('createExecutionBridge', () => {
  let deps: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    deps = makeDeps();
    createExecutionBridge(deps as never).start();
  });

  it('honors the template agent field and resolves its capabilities', () => {
    const requests: unknown[] = [];
    deps.eventBus.on('agent:task:request', (e) => requests.push(e));
    deps.eventBus.emit(runAgentEvent() as never);
    expect(deps.namedAgentStore.getAgentByName).toHaveBeenCalledWith('gmail');
    const req = requests[0] as { payload: Record<string, unknown> };
    expect(req.payload.namedAgentId).toBe('agent-gmail');
    expect(req.payload.mcpServers).toHaveProperty('gmail');
    expect(req.payload.executionTaskId).toBe('task-1');
  });

  it('falls back to the default agent when no agent is named', () => {
    const requests: unknown[] = [];
    deps.eventBus.on('agent:task:request', (e) => requests.push(e));
    deps.eventBus.emit(runAgentEvent({ agent: undefined }) as never);
    const req = requests[0] as { payload: Record<string, unknown> };
    expect(req.payload.namedAgentId).toBe('agent-raven');
  });

  it('advances the tree when a tracked agent task completes', () => {
    deps.executionEngine.getTree.mockReturnValue({
      tasks: new Map([['task-1', { status: 'in_progress' }]]),
    });
    deps.eventBus.emit(runAgentEvent() as never);
    deps.eventBus.emit({
      id: 'e2',
      timestamp: Date.now(),
      source: 'agent-manager',
      type: 'agent:task:complete',
      payload: { taskId: 'task-1', result: 'summary text', durationMs: 5, success: true },
    } as never);
    expect(deps.executionEngine.onTaskCompleted).toHaveBeenCalledWith({
      treeId: 't1',
      taskId: 'task-1',
      summary: 'summary text',
      artifacts: [],
    });
  });

  it('blocks the tree task on failure', () => {
    deps.executionEngine.getTree.mockReturnValue({
      tasks: new Map([['task-1', { status: 'in_progress' }]]),
    });
    deps.eventBus.emit(runAgentEvent() as never);
    deps.eventBus.emit({
      id: 'e3',
      timestamp: Date.now(),
      source: 'agent-manager',
      type: 'agent:task:complete',
      payload: { taskId: 'task-1', result: '', durationMs: 5, success: false, errors: ['boom'] },
    } as never);
    expect(deps.executionEngine.onTaskBlocked).toHaveBeenCalledWith('t1', 'task-1', 'boom');
  });

  it('ignores completions for untracked tasks and non-running tree tasks', () => {
    deps.executionEngine.getTree.mockReturnValue({
      tasks: new Map([['task-1', { status: 'completed' }]]),
    });
    deps.eventBus.emit({
      id: 'e4',
      timestamp: Date.now(),
      source: 'agent-manager',
      type: 'agent:task:complete',
      payload: { taskId: 'untracked', result: 'x', durationMs: 1, success: true },
    } as never);
    deps.eventBus.emit(runAgentEvent() as never);
    deps.eventBus.emit({
      id: 'e5',
      timestamp: Date.now(),
      source: 'agent-manager',
      type: 'agent:task:complete',
      payload: { taskId: 'task-1', result: 'x', durationMs: 1, success: true },
    } as never);
    expect(deps.executionEngine.onTaskCompleted).not.toHaveBeenCalled();
  });
});
