/**
 * Tests for createValidationDeps — the real event-bus-driven evaluator /
 * quality-reviewer dispatch used by the task execution engine's validation
 * pipeline (see validation-pipeline.ts).
 */

import { describe, it, expect } from 'vitest';
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

  it('runEvaluator returns failed (not auto-pass) when agent task fails', async () => {
    const bus = new EventBus();
    installAgentResponder(bus, '', false);

    const deps = createValidationDeps(bus);
    const result = await deps.runEvaluator('test prompt', 'test result');

    expect(result.passed).toBe(false);
    expect(result.reason).toBe('Evaluator agent failed');
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
});
