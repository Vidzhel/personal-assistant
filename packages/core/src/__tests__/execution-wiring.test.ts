/**
 * Tests for the agent:task:complete → executionEngine.onTaskCompleted() wiring
 * introduced in index.ts. We replicate the handler logic directly so we can
 * test it without booting the full server.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateId } from '@raven/shared';
import { initDatabase, getDb } from '../db/database.ts';
import { EventBus } from '../event-bus/event-bus.ts';
import { TaskExecutionEngine } from '../task-execution/task-execution-engine.ts';
import { createValidationDeps } from '../task-execution/create-validation-deps.ts';
import type { RavenEvent, TaskTreeNode } from '@raven/shared';

// ── helpers ──────────────────────────────────────────────────────────────

function makeDbInterface(db: any) {
  return {
    run: (sql: string, ...params: unknown[]) => db.prepare(sql).run(...params),
    get: <T>(sql: string, ...params: unknown[]) => db.prepare(sql).get(...params) as T | undefined,
    all: <T>(sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as T[],
  };
}

function agentNode(id: string): TaskTreeNode {
  return {
    type: 'agent',
    id,
    title: `Task ${id}`,
    prompt: `Do ${id}`,
    blockedBy: [],
  } as TaskTreeNode;
}

function emitAgentComplete(
  eventBus: EventBus,
  taskId: string,
  success: boolean,
  result = 'done',
  errors?: string[],
): void {
  eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: 'agent-manager',
    type: 'agent:task:complete',
    payload: { taskId, result, success, ...(errors ? { errors } : {}) },
  } as RavenEvent);
}

// ── wiring factory ────────────────────────────────────────────────────────
// Replicates the handler installed in index.ts so we can test it in isolation.

function installWiring(eventBus: EventBus, executionEngine: TaskExecutionEngine) {
  const executionTaskToTree = new Map<string, string>();

  // Simulate what execution:task:run-agent handler does — registers the mapping
  function registerTask(taskId: string, treeId: string): void {
    executionTaskToTree.set(taskId, treeId);
  }

  // The agent:task:complete handler from index.ts
  eventBus.on('agent:task:complete', (event: unknown) => {
    const payload = (event as RavenEvent & { payload: Record<string, unknown> }).payload as {
      taskId: string;
      result: string;
      success: boolean;
      errors?: string[];
    };
    const treeId = executionTaskToTree.get(payload.taskId);
    if (!treeId) return;

    executionTaskToTree.delete(payload.taskId);

    if (payload.success) {
      executionEngine
        .onTaskCompleted({
          treeId,
          taskId: payload.taskId,
          summary: payload.result,
          artifacts: [],
        })
        .catch(() => {
          /* swallowed in test */
        });
    } else {
      executionEngine.onTaskBlocked(
        treeId,
        payload.taskId,
        payload.errors?.join(', ') ?? 'Agent task failed',
      );
    }
  });

  return { registerTask };
}

// ── suite ─────────────────────────────────────────────────────────────────

describe('execution-wiring: agent:task:complete handler', () => {
  let tmpDir: string;
  let rawDb: any;
  let dbInterface: ReturnType<typeof makeDbInterface>;
  let eventBus: EventBus;
  let engine: TaskExecutionEngine;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-exec-wiring-'));
    rawDb = initDatabase(join(tmpDir, 'test.db'));
    dbInterface = makeDbInterface(rawDb);
  });

  afterAll(() => {
    try {
      getDb().close();
    } catch {
      /* */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    eventBus = new EventBus();
    engine = new TaskExecutionEngine({ db: dbInterface, eventBus });
  });

  it('success=true causes the tree task to complete', async () => {
    const treeId = generateId();
    const taskId = generateId();

    engine.createTree({ id: treeId, tasks: [agentNode(taskId)] });
    engine.startTree(treeId);

    const { registerTask } = installWiring(eventBus, engine);
    registerTask(taskId, treeId);

    const spy = vi.spyOn(engine, 'onTaskCompleted');

    emitAgentComplete(eventBus, taskId, true, 'task result');

    // onTaskCompleted is async; give the microtask queue a tick
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith({
      treeId,
      taskId,
      summary: 'task result',
      artifacts: [],
    });

    const tree = engine.getTree(treeId);
    const task = tree?.tasks.get(taskId);
    expect(task?.status).toBe('completed');
  });

  it('success=false causes the tree task to be blocked', () => {
    const treeId = generateId();
    const taskId = generateId();

    engine.createTree({ id: treeId, tasks: [agentNode(taskId)] });
    engine.startTree(treeId);

    const { registerTask } = installWiring(eventBus, engine);
    registerTask(taskId, treeId);

    const spy = vi.spyOn(engine, 'onTaskBlocked');

    emitAgentComplete(eventBus, taskId, false, '', ['something went wrong']);

    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith(treeId, taskId, 'something went wrong');

    const tree = engine.getTree(treeId);
    const task = tree?.tasks.get(taskId);
    expect(task?.status).toBe('blocked');
  });

  it('uses default error message when errors array is absent', () => {
    const treeId = generateId();
    const taskId = generateId();

    engine.createTree({ id: treeId, tasks: [agentNode(taskId)] });
    engine.startTree(treeId);

    const { registerTask } = installWiring(eventBus, engine);
    registerTask(taskId, treeId);

    const spy = vi.spyOn(engine, 'onTaskBlocked');

    emitAgentComplete(eventBus, taskId, false);

    expect(spy).toHaveBeenCalledWith(treeId, taskId, 'Agent task failed');
  });

  it('agent:task:complete for non-execution tasks (no treeId mapping) is ignored', () => {
    // Create engine but do NOT register any mapping
    installWiring(eventBus, engine);

    const completedSpy = vi.spyOn(engine, 'onTaskCompleted');
    const blockedSpy = vi.spyOn(engine, 'onTaskBlocked');

    emitAgentComplete(eventBus, generateId(), true, 'irrelevant');

    expect(completedSpy).not.toHaveBeenCalled();
    expect(blockedSpy).not.toHaveBeenCalled();
  });

  it('mapping is cleaned up after completion so duplicate events are ignored', async () => {
    const treeId = generateId();
    const taskId = generateId();

    engine.createTree({ id: treeId, tasks: [agentNode(taskId)] });
    engine.startTree(treeId);

    const { registerTask } = installWiring(eventBus, engine);
    registerTask(taskId, treeId);

    const spy = vi.spyOn(engine, 'onTaskCompleted');

    emitAgentComplete(eventBus, taskId, true, 'first');
    emitAgentComplete(eventBus, taskId, true, 'duplicate');

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Only the first emission should have been processed
    expect(spy).toHaveBeenCalledOnce();
  });
});

// ── Helpers for validation deps tests ─────────────────────────────────────

function emitAgentCompleteForTask(
  bus: EventBus,
  taskId: string,
  result: string,
  success: boolean,
): void {
  bus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: 'agent-manager',
    type: 'agent:task:complete',
    payload: { taskId, result, durationMs: 100, success },
  } as RavenEvent);
}

function installAgentResponder(bus: EventBus, result: string, success: boolean): void {
  bus.on('agent:task:request', (event: unknown) => {
    const payload = (event as { payload: { taskId: string } }).payload;
    setTimeout(() => {
      emitAgentCompleteForTask(bus, payload.taskId, result, success);
    }, 10);
  });
}

// ── createValidationDeps ──────────────────────────────────────────────────

describe('createValidationDeps', () => {
  it('runEvaluator returns passed=true when agent responds with JSON passed:true', async () => {
    const bus = new EventBus();
    installAgentResponder(bus, JSON.stringify({ passed: true, reason: 'Looks good' }), true);

    const deps = createValidationDeps(bus);
    const result = await deps.runEvaluator('test prompt', 'test result');

    expect(result.passed).toBe(true);
    expect(result.reason).toBe('Looks good');
  });

  it('runEvaluator returns passed=false when agent responds with JSON passed:false', async () => {
    const bus = new EventBus();
    installAgentResponder(bus, JSON.stringify({ passed: false, reason: 'Missing artifacts' }), true);

    const deps = createValidationDeps(bus);
    const result = await deps.runEvaluator('test prompt', 'test result');

    expect(result.passed).toBe(false);
    expect(result.reason).toBe('Missing artifacts');
  });

  it('runQualityReviewer returns score and pass/fail based on threshold', async () => {
    const bus = new EventBus();
    installAgentResponder(bus, JSON.stringify({ score: 4, feedback: 'Decent quality', pass: true }), true);

    const deps = createValidationDeps(bus);
    const passResult = await deps.runQualityReviewer('test prompt', 'test result', 3);

    expect(passResult.passed).toBe(true);
    expect(passResult.score).toBe(4);
    expect(passResult.feedback).toBe('Decent quality');
  });

  it('runQualityReviewer fails when score below threshold', async () => {
    const bus = new EventBus();
    installAgentResponder(bus, JSON.stringify({ score: 2, feedback: 'Needs work', pass: false }), true);

    const deps = createValidationDeps(bus);
    const result = await deps.runQualityReviewer('test prompt', 'test result', 3);

    expect(result.passed).toBe(false);
    expect(result.score).toBe(2);
  });

  it('runEvaluator auto-passes when agent task fails', async () => {
    const bus = new EventBus();
    installAgentResponder(bus, '', false);

    const deps = createValidationDeps(bus);
    const result = await deps.runEvaluator('test prompt', 'test result');

    expect(result.passed).toBe(false);
    expect(result.reason).toBe('Evaluator agent failed');
  });
});
