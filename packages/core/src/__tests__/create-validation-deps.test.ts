/**
 * Tests for createValidationDeps — the real event-bus-driven evaluator /
 * quality-reviewer dispatch used by the task execution engine's validation
 * pipeline (see validation-pipeline.ts).
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { generateId } from '@raven/shared';
import { EventBus } from '../event-bus/event-bus.ts';
import { createValidationDeps } from '../task-execution/create-validation-deps.ts';
import type { RavenEvent } from '@raven/shared';

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

describe('createValidationDeps', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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
    installAgentResponder(
      bus,
      JSON.stringify({ passed: false, reason: 'Missing artifacts' }),
      true,
    );

    const deps = createValidationDeps(bus);
    const result = await deps.runEvaluator('test prompt', 'test result');

    expect(result.passed).toBe(false);
    expect(result.reason).toBe('Missing artifacts');
  });

  it('runQualityReviewer returns score and pass/fail based on threshold', async () => {
    const bus = new EventBus();
    installAgentResponder(
      bus,
      JSON.stringify({ score: 4, feedback: 'Decent quality', pass: true }),
      true,
    );

    const deps = createValidationDeps(bus);
    const passResult = await deps.runQualityReviewer('test prompt', 'test result', {
      threshold: 3,
    });

    expect(passResult.passed).toBe(true);
    expect(passResult.score).toBe(4);
    expect(passResult.feedback).toBe('Decent quality');
  });

  it('runQualityReviewer fails when score below threshold', async () => {
    const bus = new EventBus();
    installAgentResponder(
      bus,
      JSON.stringify({ score: 2, feedback: 'Needs work', pass: false }),
      true,
    );

    const deps = createValidationDeps(bus);
    const result = await deps.runQualityReviewer('test prompt', 'test result', { threshold: 3 });

    expect(result.passed).toBe(false);
    expect(result.score).toBe(2);
  });

  it('runQualityReviewer enforces the configured threshold even when pass is true', async () => {
    const bus = new EventBus();
    installAgentResponder(
      bus,
      JSON.stringify({ score: 1, feedback: 'Too shallow', pass: true }),
      true,
    );

    const deps = createValidationDeps(bus);
    const result = await deps.runQualityReviewer('test prompt', 'test result', { threshold: 3 });

    expect(result).toMatchObject({ passed: false, score: 1 });
  });

  it('runEvaluator returns failed (not auto-pass) when agent task fails', async () => {
    const bus = new EventBus();
    installAgentResponder(bus, '', false);

    const deps = createValidationDeps(bus);
    const result = await deps.runEvaluator('test prompt', 'test result');

    expect(result.passed).toBe(false);
    expect(result.reason).toBe('Evaluator agent failed');
  });

  it('runEvaluator fails closed when agent output is invalid JSON', async () => {
    const bus = new EventBus();
    installAgentResponder(bus, 'not-json', true);

    const deps = createValidationDeps(bus);
    await expect(deps.runEvaluator('test prompt', 'test result')).resolves.toEqual({
      passed: false,
      reason: 'Evaluator returned invalid output',
    });
  });

  it('treats a cancelled successful completion as a failed validator result', async () => {
    const bus = new EventBus();
    bus.on('agent:task:request', (event: unknown) => {
      const taskId = (event as { payload: { taskId: string } }).payload.taskId;
      const completion = {
        id: generateId(),
        timestamp: Date.now(),
        source: 'agent-manager',
        type: 'agent:task:complete',
        payload: { taskId, result: '{}', durationMs: 1, success: true, cancelled: true },
      } as RavenEvent;
      bus.emit(completion);
    });

    const deps = createValidationDeps(bus);
    const result = await deps.runEvaluator('test prompt', 'test result');

    expect(result).toEqual({ passed: false, reason: 'Evaluator agent failed' });
  });

  it('runEvaluator accepts an optional context object without changing behavior', async () => {
    const bus = new EventBus();
    installAgentResponder(bus, JSON.stringify({ passed: true, reason: 'ok' }), true);

    const deps = createValidationDeps(bus);
    const result = await deps.runEvaluator('test prompt', 'test result', {
      criteria: 'must be concise',
      treeId: 'tree-1',
      taskId: 'task-1',
    });

    expect(result.passed).toBe(true);
  });

  it('includes project identity in validator requests', async () => {
    const bus = new EventBus();
    const request = new Promise<{ projectId?: string }>((resolve) => {
      bus.once('agent:task:request', (event: unknown) => {
        resolve((event as { payload: { projectId?: string } }).payload);
      });
    });
    installAgentResponder(bus, JSON.stringify({ passed: true, reason: 'ok' }), true);

    const deps = createValidationDeps(bus);
    const resultPromise = deps.runEvaluator('test prompt', 'test result', {
      projectId: 'project-1',
    });
    await expect(request).resolves.toMatchObject({ projectId: 'project-1' });
    await expect(resultPromise).resolves.toMatchObject({ passed: true });
  });

  it('fails closed on timeout, cancels the exact dispatched task, and cleans listeners', async () => {
    vi.useFakeTimers();
    const bus = new EventBus();
    const cancelAgentTask = vi.fn(() => true);
    const requests: string[] = [];
    bus.on('agent:task:request', (event: unknown) => {
      requests.push((event as { payload: { taskId: string } }).payload.taskId);
    });
    const before = bus.listenerCount();
    const deps = createValidationDeps(bus, { cancelAgentTask });
    const resultPromise = deps.runEvaluator('test prompt', 'test result');

    await vi.advanceTimersByTimeAsync(120_000);
    await expect(resultPromise).resolves.toEqual({
      passed: false,
      reason: 'Evaluator validation failed',
    });
    expect(requests).toHaveLength(1);
    expect(cancelAgentTask).toHaveBeenCalledOnce();
    expect(cancelAgentTask).toHaveBeenCalledWith(requests[0]);
    expect(bus.listenerCount()).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts an in-flight validator with the caller reason and ignores late completion', async () => {
    vi.useFakeTimers();
    const bus = new EventBus();
    const controller = new AbortController();
    const cancelAgentTask = vi.fn(() => true);
    let taskId: string | undefined;
    bus.on('agent:task:request', (event: unknown) => {
      taskId = (event as { payload: { taskId: string } }).payload.taskId;
    });
    const before = bus.listenerCount();
    const deps = createValidationDeps(bus, { cancelAgentTask });
    const reason = new Error('execution stopped');
    const resultPromise = deps.runEvaluator('test prompt', 'test result', {
      signal: controller.signal,
    });

    controller.abort(reason);
    await expect(resultPromise).rejects.toBe(reason);
    expect(cancelAgentTask).toHaveBeenCalledWith(taskId);
    expect(bus.listenerCount()).toBe(before);
    if (taskId) {
      emitAgentCompleteForTask(bus, taskId, JSON.stringify({ passed: true, reason: 'late' }), true);
    }
    expect(cancelAgentTask).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not dispatch or cancel when already aborted', async () => {
    const bus = new EventBus();
    const controller = new AbortController();
    const reason = new Error('already stopped');
    controller.abort(reason);
    const cancelAgentTask = vi.fn(() => true);
    const request = vi.fn();
    bus.on('agent:task:request', request);
    const deps = createValidationDeps(bus, { cancelAgentTask });

    await expect(
      deps.runEvaluator('test prompt', 'test result', { signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(request).not.toHaveBeenCalled();
    expect(cancelAgentTask).not.toHaveBeenCalled();
  });
});
