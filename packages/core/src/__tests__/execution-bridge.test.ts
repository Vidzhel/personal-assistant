import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

// Mock the claude-code SDK before importing AgentManager — only the S8a
// "queued-cancel emits completion" integration case below spins up a real
// AgentManager; every other test in this file uses a fake agent responder
// on a real EventBus instead of the SDK.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

vi.mock('../config.ts', () => {
  const config = {
    ANTHROPIC_API_KEY: 'test-key',
    CLAUDE_MODEL: 'claude-sonnet-4-6',
    RAVEN_PORT: 4001,
    RAVEN_TIMEZONE: 'UTC',
    RAVEN_MAX_CONCURRENT_AGENTS: 1,
    RAVEN_AGENT_MAX_TURNS: 25,
    DATABASE_PATH: './data/raven.db',
    SESSION_PATH: './data/sessions',
    LOG_LEVEL: 'info',
  };
  return {
    getConfig: () => config,
    loadConfig: () => config,
    projectRoot: '/test/root',
  };
});

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { generateId } from '@raven/shared';
import type {
  RavenEvent,
  RavenEventType,
  AgentTaskRequestEvent,
  EventBusInterface,
  TaskTreeNode,
} from '@raven/shared';
import { EventBus } from '../event-bus/event-bus.ts';
import { createExecutionBridge } from '../task-execution/execution-bridge.ts';
import { TaskExecutionEngine } from '../task-execution/task-execution-engine.ts';
import { AgentManager } from '../agent-manager/agent-manager.ts';
import { initDatabase, getDb } from '../db/database.ts';

const mockQuery = vi.mocked(query);

// ── Unit-test suite: mocked engine + collaborators ────────────────────────

function makeDeps() {
  const eventBus = new EventBus();
  const executionEngine = {
    getTree: vi.fn(),
    onTaskCompleted: vi.fn().mockResolvedValue(undefined),
    onTaskBlocked: vi.fn(),
    onTaskFailed: vi.fn(),
    onTaskCancelled: vi.fn(),
    setAgentTaskId: vi.fn(
      (_treeId: string, taskId: string, agentTaskId: string): boolean | Promise<boolean> => {
        executionEngine.getTree.mockReturnValue({
          status: 'running',
          tasks: new Map([[taskId, { status: 'in_progress', agentTaskId }]]),
        });
        return true;
      },
    ),
  };
  const gmailAgent = {
    id: 'agent-gmail',
    name: 'gmail',
    instructions: 'Read receipts only, never delete.',
    bash: {
      access: 'scoped',
      allowedCommands: [],
      deniedCommands: [],
      allowedPaths: [],
      deniedPaths: [],
    },
  };
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

/** Emits the run-agent event and returns the agentTaskId the bridge minted
 * for it (captured from the resulting agent:task:request payload). */
async function dispatchAndCaptureAgentTaskId(
  deps: ReturnType<typeof makeDeps>,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const requests: Array<{ payload: Record<string, unknown> }> = [];
  deps.eventBus.on('agent:task:request', (e) => requests.push(e as never));
  deps.eventBus.emit(runAgentEvent(overrides) as never);
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  return requests[0].payload.taskId as string;
}

describe('createExecutionBridge', () => {
  let deps: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    deps = makeDeps();
    createExecutionBridge(deps as never).start();
  });

  it('rejects an unknown explicit agent without using the default capabilities', async () => {
    const requests: unknown[] = [];
    deps.eventBus.on('agent:task:request', (event) => requests.push(event));
    deps.eventBus.emit(runAgentEvent({ agent: 'missing-agent' }) as never);
    expect(requests).toEqual([]);
    expect(deps.namedAgentStore.getDefaultAgent).not.toHaveBeenCalled();
    expect(deps.executionEngine.onTaskFailed).toHaveBeenCalledWith(
      't1',
      'task-1',
      expect.stringContaining('missing-agent'),
    );
  });

  it('does not dispatch an attempt the engine refused to bind', async () => {
    deps.executionEngine.setAgentTaskId.mockReturnValue(false);
    const requests: unknown[] = [];
    deps.eventBus.on('agent:task:request', (event) => requests.push(event));
    deps.eventBus.emit(runAgentEvent() as never);
    await Promise.resolve();
    expect(requests).toEqual([]);
  });

  it('owns one subscription and cancels exact pending attempts across repeated start and stop', async () => {
    const local = makeDeps();
    const cancelAgentTask = vi.fn().mockReturnValue(true);
    const bridge = createExecutionBridge({ ...local, cancelAgentTask } as never);
    const requests: AgentTaskRequestEvent[] = [];
    local.eventBus.on<AgentTaskRequestEvent>('agent:task:request', (event) => requests.push(event));
    bridge.start();
    bridge.start();
    local.eventBus.emit(runAgentEvent() as never);
    await Promise.resolve();
    expect(requests).toHaveLength(1);
    const agentTaskId = requests[0].payload.taskId;
    bridge.stop();
    bridge.stop();
    expect(cancelAgentTask).toHaveBeenCalledExactlyOnceWith(agentTaskId);
    local.executionEngine.getTree.mockReturnValue({
      tasks: new Map([['task-1', { status: 'in_progress', agentTaskId }]]),
    });
    local.eventBus.emit({
      id: 'late',
      timestamp: Date.now(),
      source: 'test',
      type: 'agent:task:complete',
      payload: { taskId: agentTaskId, result: 'late', durationMs: 1, success: true },
    });
    local.eventBus.emit(runAgentEvent() as never);
    await Promise.resolve();
    expect(requests).toHaveLength(1);
    expect(local.executionEngine.onTaskCompleted).not.toHaveBeenCalled();
  });

  it('does not dispatch a held attempt after bridge stop and restart', async () => {
    const local = makeDeps();
    let release!: (accepted: boolean) => void;
    local.executionEngine.setAgentTaskId.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        release = resolve;
      }),
    );
    const bridge = createExecutionBridge(local as never);
    const requests: unknown[] = [];
    local.eventBus.on('agent:task:request', (event) => requests.push(event));
    bridge.start();
    local.eventBus.emit(runAgentEvent() as never);
    const id = local.executionEngine.setAgentTaskId.mock.calls[0][2];
    local.executionEngine.getTree.mockReturnValue({
      status: 'running',
      tasks: new Map([['task-1', { status: 'in_progress', agentTaskId: id }]]),
    });
    bridge.stop();
    bridge.start();
    release(true);
    await Promise.resolve();
    expect(requests).toEqual([]);
    bridge.stop();
  });

  it('aborts remaining agent work when a tree fails outright', async () => {
    const local = makeDeps();
    const cancelAgentTask = vi.fn().mockReturnValue(true);
    const bridge = createExecutionBridge({ ...local, cancelAgentTask } as never);
    bridge.start();
    const agentTaskId = await dispatchAndCaptureAgentTaskId(local);
    local.eventBus.emit({
      id: 'failed-tree',
      timestamp: Date.now(),
      source: 'test',
      type: 'execution:tree:completed',
      payload: { treeId: 't1', status: 'failed' },
    });
    expect(cancelAgentTask).toHaveBeenCalledExactlyOnceWith(agentTaskId);
    bridge.stop();
  });

  it('honors the template agent field and resolves its capabilities', async () => {
    const requests: unknown[] = [];
    deps.eventBus.on('agent:task:request', (e) => requests.push(e));
    deps.eventBus.emit(runAgentEvent() as never);
    await Promise.resolve();
    expect(deps.namedAgentStore.getAgentByName).toHaveBeenCalledWith('gmail');
    const req = requests[0] as { payload: Record<string, unknown> };
    expect(req.payload.namedAgentId).toBe('agent-gmail');
    expect(req.payload.mcpServers).toHaveProperty('gmail');
    expect(req.payload.executionTaskId).toBe('task-1');
  });

  it('falls back to the default agent when no agent is named', async () => {
    const requests: unknown[] = [];
    deps.eventBus.on('agent:task:request', (e) => requests.push(e));
    deps.eventBus.emit(runAgentEvent({ agent: undefined }) as never);
    await Promise.resolve();
    const req = requests[0] as { payload: Record<string, unknown> };
    expect(req.payload.namedAgentId).toBe('agent-raven');
  });

  it('carries the resolved agent persona into the dispatch: instructions prepended to the prompt, bashAccess passed through (F4)', async () => {
    const requests: Array<{ payload: Record<string, unknown> }> = [];
    deps.eventBus.on('agent:task:request', (e) => requests.push(e as never));
    deps.eventBus.emit(runAgentEvent() as never);
    await Promise.resolve(); // default agent: 'gmail'

    const req = requests[0];
    expect(req.payload.prompt).toBe(
      '[Agent Instructions: Read receipts only, never delete.]\n\ndo it',
    );
    expect(req.payload.bashAccess).toEqual({
      access: 'scoped',
      allowedCommands: [],
      deniedCommands: [],
      allowedPaths: [],
      deniedPaths: [],
    });
  });

  it('mints a fresh agentTaskId per dispatch and persists it via setAgentTaskId', async () => {
    const requests: Array<{ payload: Record<string, unknown> }> = [];
    deps.eventBus.on('agent:task:request', (e) => requests.push(e as never));
    deps.eventBus.emit(runAgentEvent() as never);
    await Promise.resolve();

    const agentTaskId = requests[0].payload.taskId as string;
    expect(agentTaskId).not.toBe('task-1'); // the tree task id, kept separately
    expect(requests[0].payload.executionTaskId).toBe('task-1');
    expect(deps.executionEngine.setAgentTaskId).toHaveBeenCalledWith('t1', 'task-1', agentTaskId);
  });

  it('advances the tree when a tracked agent task completes', async () => {
    const agentTaskId = await dispatchAndCaptureAgentTaskId(deps);

    deps.executionEngine.getTree.mockReturnValue({
      tasks: new Map([['task-1', { status: 'in_progress', agentTaskId }]]),
    });
    deps.eventBus.emit({
      id: 'e2',
      timestamp: Date.now(),
      source: 'agent-manager',
      type: 'agent:task:complete',
      payload: { taskId: agentTaskId, result: 'summary text', durationMs: 5, success: true },
    } as never);

    expect(deps.executionEngine.onTaskCompleted).toHaveBeenCalledWith({
      treeId: 't1',
      taskId: 'task-1',
      agentTaskId,
      summary: 'summary text',
      artifacts: [],
    });
  });

  it('routes an approval-blocked failure to onTaskBlocked (resumable, not retried)', async () => {
    const agentTaskId = await dispatchAndCaptureAgentTaskId(deps);

    deps.executionEngine.getTree.mockReturnValue({
      tasks: new Map([['task-1', { status: 'in_progress', agentTaskId }]]),
    });
    deps.eventBus.emit({
      id: 'e3',
      timestamp: Date.now(),
      source: 'agent-manager',
      type: 'agent:task:complete',
      payload: {
        taskId: agentTaskId,
        result: '',
        durationMs: 5,
        success: false,
        blocked: true,
        errors: ['queued-for-approval'],
      },
    } as never);

    expect(deps.executionEngine.onTaskBlocked).toHaveBeenCalledWith('t1', 'task-1', {
      reason: 'queued-for-approval',
      agentTaskId,
    });
    expect(deps.executionEngine.onTaskFailed).not.toHaveBeenCalled();
  });

  it('routes a hard failure (not blocked) to onTaskFailed so it enters the retry ladder', async () => {
    const agentTaskId = await dispatchAndCaptureAgentTaskId(deps);

    deps.executionEngine.getTree.mockReturnValue({
      tasks: new Map([['task-1', { status: 'in_progress', agentTaskId }]]),
    });
    deps.eventBus.emit({
      id: 'e3b',
      timestamp: Date.now(),
      source: 'agent-manager',
      type: 'agent:task:complete',
      payload: { taskId: agentTaskId, result: '', durationMs: 5, success: false, errors: ['boom'] },
    } as never);

    expect(deps.executionEngine.onTaskFailed).toHaveBeenCalledWith('t1', 'task-1', {
      reason: 'boom',
      agentTaskId,
    });
    expect(deps.executionEngine.onTaskBlocked).not.toHaveBeenCalled();
  });

  it('routes a cancelled completion to onTaskCancelled — terminal, never retried or treated as blocked (F1)', async () => {
    const agentTaskId = await dispatchAndCaptureAgentTaskId(deps);

    deps.executionEngine.getTree.mockReturnValue({
      tasks: new Map([['task-1', { status: 'in_progress', agentTaskId }]]),
    });
    deps.eventBus.emit({
      id: 'e3c',
      timestamp: Date.now(),
      source: 'agent-manager',
      type: 'agent:task:complete',
      payload: {
        taskId: agentTaskId,
        result: 'Task cancelled',
        durationMs: 5,
        success: false,
        errors: ['cancelled'],
        cancelled: true,
      },
    } as never);

    expect(deps.executionEngine.onTaskCancelled).toHaveBeenCalledWith('t1', 'task-1', agentTaskId);
    expect(deps.executionEngine.onTaskFailed).not.toHaveBeenCalled();
    expect(deps.executionEngine.onTaskBlocked).not.toHaveBeenCalled();
  });

  it('ignores completions for untracked tasks and non-running tree tasks', async () => {
    deps.executionEngine.getTree.mockReturnValue({
      tasks: new Map([['task-1', { status: 'completed', agentTaskId: 'whatever' }]]),
    });
    deps.eventBus.emit({
      id: 'e4',
      timestamp: Date.now(),
      source: 'agent-manager',
      type: 'agent:task:complete',
      payload: { taskId: 'untracked', result: 'x', durationMs: 1, success: true },
    } as never);

    const agentTaskId = await dispatchAndCaptureAgentTaskId(deps);
    deps.executionEngine.getTree.mockReturnValue({
      tasks: new Map([['task-1', { status: 'completed', agentTaskId }]]),
    });
    deps.eventBus.emit({
      id: 'e5',
      timestamp: Date.now(),
      source: 'agent-manager',
      type: 'agent:task:complete',
      payload: { taskId: agentTaskId, result: 'x', durationMs: 1, success: true },
    } as never);
    expect(deps.executionEngine.onTaskCompleted).not.toHaveBeenCalled();
  });

  it('ignores a completion whose agentTaskId no longer matches the task current attempt', async () => {
    const agentTaskId = await dispatchAndCaptureAgentTaskId(deps);

    // Simulate a superseded attempt: the tree task's *current* agentTaskId
    // has already moved on to a newer dispatch, even though this (stale)
    // agentTaskId is the one carried by the completion event arriving now.
    deps.executionEngine.getTree.mockReturnValue({
      tasks: new Map([['task-1', { status: 'in_progress', agentTaskId: 'some-newer-id' }]]),
    });
    deps.eventBus.emit({
      id: 'e6',
      timestamp: Date.now(),
      source: 'agent-manager',
      type: 'agent:task:complete',
      payload: { taskId: agentTaskId, result: 'stale', durationMs: 1, success: true },
    } as never);

    expect(deps.executionEngine.onTaskCompleted).not.toHaveBeenCalled();
  });

  it('clears pending entries for a cancelled tree even when cancelAgentTask is not wired (F7)', async () => {
    // `deps` (from the shared beforeEach) has no cancelAgentTask — this must
    // not stop the pending entry from being dropped.
    const agentTaskId = await dispatchAndCaptureAgentTaskId(deps);

    deps.eventBus.emit({
      id: 'e-f7',
      timestamp: Date.now(),
      source: 'task-execution-engine',
      type: 'execution:tree:cancelled',
      payload: { treeId: 't1' },
    } as never);

    // The entry was removed despite the missing cancelAgentTask — a later
    // completion for it is now a no-op instead of advancing the tree.
    deps.executionEngine.getTree.mockReturnValue({
      tasks: new Map([['task-1', { status: 'in_progress', agentTaskId }]]),
    });
    deps.eventBus.emit({
      id: 'e-f7b',
      timestamp: Date.now(),
      source: 'agent-manager',
      type: 'agent:task:complete',
      payload: { taskId: agentTaskId, result: 'late', durationMs: 1, success: true },
    } as never);
    expect(deps.executionEngine.onTaskCompleted).not.toHaveBeenCalled();
  });

  it('routes to onTaskFailed instead of dispatching when agent resolution throws (S9)', async () => {
    deps.namedAgentStore.getAgentByName.mockReturnValue(undefined);
    deps.namedAgentStore.getDefaultAgent.mockImplementation(() => {
      throw new Error('No default agent configured');
    });

    const requests: unknown[] = [];
    deps.eventBus.on('agent:task:request', (e) => requests.push(e));

    deps.eventBus.emit(runAgentEvent({ agent: undefined }) as never);
    await Promise.resolve();

    expect(requests).toHaveLength(0);
    expect(deps.executionEngine.setAgentTaskId).not.toHaveBeenCalled();
    expect(deps.executionEngine.onTaskFailed).toHaveBeenCalledWith(
      't1',
      'task-1',
      expect.stringContaining('No default agent configured'),
    );
  });

  it('cancels pending agent tasks for a tree on execution:tree:cancelled', async () => {
    // Independent deps/bus so this extra bridge instance (with
    // cancelAgentTask wired) doesn't double-listen on the shared beforeEach
    // bus alongside the bridge already started there.
    const localDeps = makeDeps();
    const cancelAgentTask = vi.fn().mockReturnValue(true);
    createExecutionBridge({ ...localDeps, cancelAgentTask } as never).start();

    const agentTaskId = await dispatchAndCaptureAgentTaskId(localDeps);

    localDeps.eventBus.emit({
      id: 'e7',
      timestamp: Date.now(),
      source: 'task-execution-engine',
      type: 'execution:tree:cancelled',
      payload: { treeId: 't1' },
    } as never);

    expect(cancelAgentTask).toHaveBeenCalledWith(agentTaskId);

    // The entry was removed — a later completion for it is now a no-op.
    localDeps.eventBus.emit({
      id: 'e8',
      timestamp: Date.now(),
      source: 'agent-manager',
      type: 'agent:task:complete',
      payload: { taskId: agentTaskId, result: 'late', durationMs: 1, success: true },
    } as never);
    expect(localDeps.executionEngine.onTaskCompleted).not.toHaveBeenCalled();
  });
});

// ── Integration suite: REAL TaskExecutionEngine + real EventBus ──────────

/** Wraps a real EventBus as the plain EventBusInterface shape the engine
 * expects — mirrors how index.ts's baseContext.eventBus wraps it. */
function toEventBusInterface(bus: EventBus): EventBusInterface {
  return {
    emit: (event: unknown) => bus.emit(event as RavenEvent),
    on: (type: string, handler: (event: unknown) => void) =>
      bus.on(type as RavenEventType, handler),
    off: (type: string, handler: (event: unknown) => void) =>
      bus.off(type as RavenEventType, handler),
  };
}

let idCounter = 0;
function uid(base: string): string {
  idCounter++;
  return `${base}-${String(idCounter)}`;
}

function agentNode(id: string, overrides: Record<string, unknown> = {}): TaskTreeNode {
  return {
    type: 'agent',
    id,
    title: `Task ${id}`,
    prompt: `Do ${id}`,
    blockedBy: [],
    ...overrides,
  } as TaskTreeNode;
}

function makeBridgeCollaborators() {
  const defaultAgent = { id: 'agent-default', name: 'default-agent', instructions: '' };
  const namedAgentStore = {
    getAgentByName: vi.fn(() => undefined),
    getAgent: vi.fn(() => undefined),
    getDefaultAgent: vi.fn(() => defaultAgent),
  };
  const agentResolver = {
    resolveAgentCapabilities: vi.fn(() => ({ mcpServers: {}, agentDefinitions: {}, plugins: [] })),
  };
  return { namedAgentStore, agentResolver };
}

type FakeAgentOutcome = { success: boolean; result?: string; blocked?: boolean; errors?: string[] };

/** Fakes the agent-manager side of the loop: replies to every
 * agent:task:request with an agent:task:complete, asynchronously (via a
 * macrotask) so the bridge's pending-map bookkeeping is genuinely exercised. */
function installFakeAgent(eventBus: EventBus, respond: () => FakeAgentOutcome): void {
  eventBus.on<AgentTaskRequestEvent>('agent:task:request', (event) => {
    const outcome = respond();
    setTimeout(() => {
      eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: 'agent-manager',
        type: 'agent:task:complete',
        payload: {
          taskId: event.payload.taskId,
          result: outcome.result ?? '',
          durationMs: 5,
          success: outcome.success,
          ...(outcome.blocked !== undefined && { blocked: outcome.blocked }),
          ...(outcome.errors !== undefined && { errors: outcome.errors }),
        },
      } as RavenEvent);
    }, 0);
  });
}

describe('execution flow integration (real engine + real event bus)', () => {
  let tmpDir: string;
  function recordDeps() {
    const projectsDir = mkdtempSync(join(tmpDir, 'projects-'));
    mkdirSync(join(projectsDir, 'system'));
    return { projectsDir, projects: () => [{ id: 'system', fsPath: 'system' }] };
  }

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-exec-bridge-integ-'));
    initDatabase(join(tmpDir, 'test.db'));
  });

  afterAll(() => {
    try {
      getDb().close();
    } catch {
      /* already closed */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('(1) happy path: tree completes when the fake agent always succeeds', async () => {
    const eventBus = new EventBus();
    const executionEngine = new TaskExecutionEngine({
      ...recordDeps(),
      eventBus: toEventBusInterface(eventBus),
    });
    const { namedAgentStore, agentResolver } = makeBridgeCollaborators();
    const bridge = createExecutionBridge({
      eventBus,
      executionEngine,
      namedAgentStore: namedAgentStore as never,
      agentResolver: agentResolver as never,
    });
    bridge.start();
    installFakeAgent(eventBus, () => ({ success: true, result: 'done' }));

    const treeId = uid('tree');
    const t1 = uid('t');
    const t2 = uid('t');
    executionEngine.createTree({
      id: treeId,
      tasks: [agentNode(t1), agentNode(t2, { blockedBy: [t1] })],
    });
    await executionEngine.startTree(treeId);

    await vi.waitFor(() => expect(executionEngine.getTree(treeId)!.status).toBe('completed'));
    bridge.stop();
  });

  it('(2) agent failure retries up to maxRetries then the tree reaches failed', async () => {
    const eventBus = new EventBus();
    const executionEngine = new TaskExecutionEngine({
      ...recordDeps(),
      eventBus: toEventBusInterface(eventBus),
    });
    const { namedAgentStore, agentResolver } = makeBridgeCollaborators();
    const bridge = createExecutionBridge({
      eventBus,
      executionEngine,
      namedAgentStore: namedAgentStore as never,
      agentResolver: agentResolver as never,
    });
    bridge.start();

    let attempts = 0;
    installFakeAgent(eventBus, () => {
      attempts++;
      return { success: false, errors: ['synthetic failure'] };
    });

    const treeId = uid('tree');
    const taskId = uid('t');
    executionEngine.createTree({ id: treeId, tasks: [agentNode(taskId)] });
    await executionEngine.startTree(treeId);

    await vi.waitFor(() => expect(executionEngine.getTree(treeId)!.status).toBe('failed'));

    const tree = executionEngine.getTree(treeId)!;
    const task = tree.tasks.get(taskId)!;
    expect(task.status).toBe('failed');
    expect(task.retryCount).toBe(2); // no validation config -> default maxRetries
    expect(tree.status).toBe('failed');
    expect(attempts).toBe(3); // initial attempt + 2 retries
    bridge.stop();
  });

  it('(3) validation-failure re-dispatch mints a new agentTaskId; a stale completion from the first attempt is ignored', async () => {
    const eventBus = new EventBus();
    let evaluatorCallCount = 0;
    const executionEngine = new TaskExecutionEngine({
      ...recordDeps(),
      eventBus: toEventBusInterface(eventBus),
      validationDeps: {
        runEvaluator: async () => {
          evaluatorCallCount++;
          return evaluatorCallCount === 1
            ? { passed: false, reason: 'not detailed enough' }
            : { passed: true, reason: 'good' };
        },
        runQualityReviewer: async () => ({ passed: true, score: 5, feedback: '' }),
      },
    });
    const { namedAgentStore, agentResolver } = makeBridgeCollaborators();
    const bridge = createExecutionBridge({
      eventBus,
      executionEngine,
      namedAgentStore: namedAgentStore as never,
      agentResolver: agentResolver as never,
    });
    bridge.start();

    const dispatchedAgentTaskIds: string[] = [];
    eventBus.on<AgentTaskRequestEvent>('agent:task:request', (event) => {
      dispatchedAgentTaskIds.push(event.payload.taskId);
    });
    installFakeAgent(eventBus, () => ({ success: true, result: 'a summary with enough detail' }));

    const treeId = uid('tree');
    const taskId = uid('t');
    executionEngine.createTree({
      id: treeId,
      tasks: [
        {
          type: 'agent',
          id: taskId,
          title: 'Validated task',
          prompt: 'Write a summary',
          blockedBy: [],
          validation: {
            requireArtifacts: false,
            evaluator: true,
            evaluatorModel: 'haiku',
            qualityReview: false,
            qualityModel: 'sonnet',
            qualityThreshold: 3,
            maxRetries: 1,
            retryBackoffMs: 0,
            onMaxRetriesFailed: 'escalate',
          },
        } as TaskTreeNode,
      ],
    });
    await executionEngine.startTree(treeId);

    // Let the first attempt complete, validation reject it, and the retry
    // (second attempt) get dispatched.
    await vi.waitFor(() => expect(dispatchedAgentTaskIds.length).toBeGreaterThanOrEqual(2));
    const firstAgentTaskId = dispatchedAgentTaskIds[0];

    const midTree = executionEngine.getTree(treeId)!;
    const midTask = midTree.tasks.get(taskId)!;
    expect(midTask.agentTaskId).not.toBe(firstAgentTaskId); // superseded by the retry

    // A late/duplicate completion carrying the FIRST attempt's agentTaskId
    // must not be able to advance the tree.
    const onTaskCompletedSpy = vi.spyOn(executionEngine, 'onTaskCompleted');
    eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'agent-manager',
      type: 'agent:task:complete',
      payload: { taskId: firstAgentTaskId, result: 'stale', durationMs: 1, success: true },
    } as RavenEvent);

    await new Promise((r) => setTimeout(r, 30));
    expect(
      onTaskCompletedSpy.mock.calls.some(([options]) => options.agentTaskId === firstAgentTaskId),
    ).toBe(false);

    // The tree still reaches completion via the second (real) attempt.
    await vi.waitFor(() => expect(executionEngine.getTree(treeId)!.status).toBe('completed'));
    bridge.stop();
  });

  it('(4) cancelTree aborts in-flight agent runs via cancelAgentTask', async () => {
    const eventBus = new EventBus();
    const executionEngine = new TaskExecutionEngine({
      ...recordDeps(),
      eventBus: toEventBusInterface(eventBus),
    });
    const { namedAgentStore, agentResolver } = makeBridgeCollaborators();
    const cancelAgentTask = vi.fn().mockReturnValue(true);
    const bridge = createExecutionBridge({
      eventBus,
      executionEngine,
      namedAgentStore: namedAgentStore as never,
      agentResolver: agentResolver as never,
      cancelAgentTask,
    });
    bridge.start();

    // No fake agent installed — the dispatched task never completes,
    // simulating a genuinely in-flight agent run.
    const dispatched: string[] = [];
    eventBus.on<AgentTaskRequestEvent>('agent:task:request', (event) => {
      dispatched.push(event.payload.taskId);
    });

    const treeId = uid('tree');
    const taskId = uid('t');
    executionEngine.createTree({ id: treeId, tasks: [agentNode(taskId)] });
    await executionEngine.startTree(treeId);

    await new Promise((r) => setTimeout(r, 20));
    expect(dispatched).toHaveLength(1);

    executionEngine.cancelTree(treeId);

    await new Promise((r) => setTimeout(r, 20));
    expect(cancelAgentTask).toHaveBeenCalledWith(dispatched[0]);
    expect(executionEngine.getTree(treeId)!.status).toBe('cancelled');
    bridge.stop();
  });

  it('(5) AgentManager.cancelTask on a queued task emits agent:task:complete with success:false (S8a)', async () => {
    const eventBus = new EventBus();

    // Gate the SDK query so the first dispatched task never resolves,
    // forcing the second (maxConcurrent=1) to sit in the queue.
    mockQuery.mockImplementation(async function* () {
      yield* []; // satisfy require-yield; the await below never returns
      await new Promise(() => {
        /* never resolves — task stays "running" for the test's duration */
      });
    } as unknown as typeof query);

    const agentManager = new AgentManager({ eventBus });

    const completions: RavenEvent[] = [];
    eventBus.on('agent:task:complete', (e) => completions.push(e));

    function emitRequest(taskId: string): void {
      eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: 'test',
        type: 'agent:task:request',
        payload: {
          taskId,
          prompt: 'x',
          skillName: 'orchestrator',
          mcpServers: {},
          priority: 'normal',
        },
      } as RavenEvent);
    }

    emitRequest('running-task');
    emitRequest('queued-task');

    await new Promise((r) => setTimeout(r, 10));
    expect(agentManager.getRunningCount()).toBe(1);
    expect(agentManager.getQueueLength()).toBe(1);

    const cancelled = agentManager.cancelTask('queued-task');
    expect(cancelled).toBe(true);

    const complete = completions.find(
      (e) => (e as unknown as { payload: { taskId: string } }).payload.taskId === 'queued-task',
    ) as unknown as
      { payload: { success: boolean; errors?: string[]; cancelled?: boolean } } | undefined;
    expect(complete).toBeDefined();
    expect(complete!.payload.success).toBe(false);
    expect(complete!.payload.errors).toEqual(['cancelled']);
    expect(complete!.payload.cancelled).toBe(true);
    await agentManager.stop();
  });

  it('(6) cancelling an in-flight tree task marks it cancelled with no retry/re-dispatch, and the tree reaches a terminal state (F1)', async () => {
    const eventBus = new EventBus();
    const executionEngine = new TaskExecutionEngine({
      ...recordDeps(),
      eventBus: toEventBusInterface(eventBus),
    });
    const { namedAgentStore, agentResolver } = makeBridgeCollaborators();
    const bridge = createExecutionBridge({
      eventBus,
      executionEngine,
      namedAgentStore: namedAgentStore as never,
      agentResolver: agentResolver as never,
    });
    bridge.start();

    const dispatched: string[] = [];
    eventBus.on<AgentTaskRequestEvent>('agent:task:request', (event) => {
      dispatched.push(event.payload.taskId);
    });

    const treeId = uid('tree');
    const taskId = uid('t');
    executionEngine.createTree({ id: treeId, tasks: [agentNode(taskId)] });
    await executionEngine.startTree(treeId);

    await new Promise((r) => setTimeout(r, 20));
    expect(dispatched).toHaveLength(1);

    // Simulate the agent-manager's cancellation completion (mirrors
    // runTask's isCancelled branch: success:false, errors:['cancelled'],
    // cancelled:true) for the in-flight dispatch — as opposed to
    // executionEngine.cancelTree, which cancels tasks directly without
    // going through this completion path.
    eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'agent-manager',
      type: 'agent:task:complete',
      payload: {
        taskId: dispatched[0],
        result: 'Task cancelled',
        durationMs: 5,
        success: false,
        errors: ['cancelled'],
        cancelled: true,
      },
    } as RavenEvent);

    await new Promise((r) => setTimeout(r, 20));

    const tree = executionEngine.getTree(treeId)!;
    const task = tree.tasks.get(taskId)!;
    expect(task.status).toBe('cancelled');
    expect(dispatched).toHaveLength(1); // no retry re-dispatch
    expect(tree.status).toBe('cancelled');
    bridge.stop();
  });
});
