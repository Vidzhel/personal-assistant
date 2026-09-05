import { describe, it, expect, vi } from 'vitest';
import type { ExecutionTask } from '@raven/shared';
import { validateTaskResult, buildRetryPrompt } from '../task-execution/validation-pipeline.ts';
import type { ValidationDeps } from '../task-execution/validation-pipeline.ts';

// ── Helpers ────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<ExecutionTask> = {}): ExecutionTask {
  return {
    id: 'task-1',
    parentTaskId: 'tree-1',
    node: {
      id: 'node-1',
      title: 'Test node',
      type: 'agent',
      prompt: 'Do the thing',
      blockedBy: [],
    },
    status: 'completed',
    artifacts: [],
    retryCount: 0,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ValidationDeps> = {}): ValidationDeps {
  return {
    runEvaluator: vi.fn().mockResolvedValue({ passed: true, reason: 'Looks good' }),
    runQualityReviewer: vi
      .fn()
      .mockResolvedValue({ passed: true, score: 4, feedback: 'Well done' }),
    ...overrides,
  };
}

// ── Gate 1 ─────────────────────────────────────────────────────────────

describe('validateTaskResult', () => {
  describe('Gate 1', () => {
    it('passes when artifacts exist', async () => {
      const task = makeTask({
        artifacts: [{ type: 'file', label: 'output.txt', filePath: '/tmp/out.txt' }],
      });
      const result = await validateTaskResult(
        task,
        { requireArtifacts: true, evaluator: false, qualityReview: false },
        makeDeps(),
      );
      expect(result.gate1Passed).toBe(true);
      expect(result.passed).toBe(true);
    });

    it('passes when summary exists (even without artifacts)', async () => {
      const task = makeTask({ summary: 'Task completed successfully' });
      const result = await validateTaskResult(
        task,
        { requireArtifacts: true, evaluator: false, qualityReview: false },
        makeDeps(),
      );
      expect(result.gate1Passed).toBe(true);
      expect(result.passed).toBe(true);
    });

    it('fails when no artifacts AND no summary (requireArtifacts=true)', async () => {
      const task = makeTask({ artifacts: [], summary: undefined });
      const deps = makeDeps();
      const result = await validateTaskResult(
        task,
        { requireArtifacts: true, evaluator: false, qualityReview: false },
        deps,
      );
      expect(result.gate1Passed).toBe(false);
      expect(result.passed).toBe(false);
      expect(deps.runEvaluator).not.toHaveBeenCalled();
    });

    it('passes when requireArtifacts=false even with no artifacts', async () => {
      const task = makeTask({ artifacts: [], summary: undefined });
      const result = await validateTaskResult(
        task,
        { requireArtifacts: false, evaluator: false, qualityReview: false },
        makeDeps(),
      );
      expect(result.gate1Passed).toBe(true);
      expect(result.passed).toBe(true);
    });
  });

  // ── Gate 2 ───────────────────────────────────────────────────────────

  describe('Gate 2', () => {
    it('passes when evaluator returns PASS', async () => {
      const task = makeTask({ summary: 'Done' });
      const deps = makeDeps({
        runEvaluator: vi.fn().mockResolvedValue({ passed: true, reason: 'Good' }),
      });
      const result = await validateTaskResult(
        task,
        { requireArtifacts: true, evaluator: true, qualityReview: false },
        deps,
      );
      expect(result.gate2Passed).toBe(true);
      expect(result.passed).toBe(true);
    });

    it('fails when evaluator returns FAIL (includes reason)', async () => {
      const task = makeTask({ summary: 'Done' });
      const deps = makeDeps({
        runEvaluator: vi.fn().mockResolvedValue({ passed: false, reason: 'Missing requirements' }),
      });
      const result = await validateTaskResult(
        task,
        { requireArtifacts: true, evaluator: true, qualityReview: false },
        deps,
      );
      expect(result.gate2Passed).toBe(false);
      expect(result.gate2Reason).toBe('Missing requirements');
      expect(result.passed).toBe(false);
    });

    it('skipped when config.evaluator=false', async () => {
      const task = makeTask({ summary: 'Done' });
      const deps = makeDeps();
      const result = await validateTaskResult(
        task,
        { requireArtifacts: true, evaluator: false, qualityReview: false },
        deps,
      );
      expect(result.gate2Passed).toBeUndefined();
      expect(deps.runEvaluator).not.toHaveBeenCalled();
      expect(result.passed).toBe(true);
    });

    it('receives correct task prompt and result', async () => {
      const task = makeTask({
        summary: 'Result text',
        node: {
          id: 'n1',
          title: 'My node',
          type: 'agent',
          prompt: 'Build a widget',
          blockedBy: [],
        },
      });
      const evalFn = vi.fn().mockResolvedValue({ passed: true, reason: 'ok' });
      await validateTaskResult(
        task,
        { requireArtifacts: true, evaluator: true, qualityReview: false },
        makeDeps({ runEvaluator: evalFn }),
      );
      expect(evalFn).toHaveBeenCalledWith('Build a widget', 'Result text', {
        criteria: undefined,
        treeId: task.parentTaskId,
        taskId: task.id,
      });
    });

    it('propagates lifetime and project context to the evaluator', async () => {
      const task = makeTask({ summary: 'Result text' });
      const controller = new AbortController();
      const evalFn = vi.fn().mockResolvedValue({ passed: true, reason: 'ok' });
      await validateTaskResult(
        task,
        { requireArtifacts: true, evaluator: true, qualityReview: false },
        makeDeps({ runEvaluator: evalFn }),
        { signal: controller.signal, projectId: 'project-1' },
      );
      expect(evalFn).toHaveBeenCalledWith('Do the thing', 'Result text', {
        criteria: undefined,
        treeId: task.parentTaskId,
        taskId: task.id,
        projectId: 'project-1',
        signal: controller.signal,
      });
    });

    it('fails closed when evaluator throws', async () => {
      const task = makeTask({ summary: 'Done' });
      const result = await validateTaskResult(
        task,
        { requireArtifacts: true, evaluator: true, qualityReview: false },
        makeDeps({ runEvaluator: vi.fn().mockRejectedValue(new Error('validator failed')) }),
      );
      expect(result).toMatchObject({
        passed: false,
        gate1Passed: true,
        gate2Passed: false,
        gate2Reason: 'Evaluator validation failed',
      });
    });
  });

  // ── Gate 3 ───────────────────────────────────────────────────────────

  describe('Gate 3', () => {
    it('passes when score >= threshold', async () => {
      const task = makeTask({ summary: 'Done' });
      const deps = makeDeps({
        runQualityReviewer: vi
          .fn()
          .mockResolvedValue({ passed: true, score: 4, feedback: 'Great' }),
      });
      const result = await validateTaskResult(
        task,
        { requireArtifacts: true, evaluator: true, qualityReview: true, qualityThreshold: 3 },
        deps,
      );
      expect(result.gate3Passed).toBe(true);
      expect(result.gate3Score).toBe(4);
      expect(result.passed).toBe(true);
    });

    it('fails when score < threshold (includes score and feedback)', async () => {
      const task = makeTask({ summary: 'Done' });
      const deps = makeDeps({
        runQualityReviewer: vi
          .fn()
          .mockResolvedValue({ passed: false, score: 2, feedback: 'Too shallow' }),
      });
      const result = await validateTaskResult(
        task,
        { requireArtifacts: true, evaluator: true, qualityReview: true, qualityThreshold: 3 },
        deps,
      );
      expect(result.gate3Passed).toBe(false);
      expect(result.gate3Score).toBe(2);
      expect(result.gate3Feedback).toBe('Too shallow');
      expect(result.passed).toBe(false);
    });

    it('fails when reviewer claims pass below the configured threshold', async () => {
      const task = makeTask({ summary: 'Done' });
      const deps = makeDeps({
        runQualityReviewer: vi
          .fn()
          .mockResolvedValue({ passed: true, score: 2, feedback: 'Too shallow' }),
      });
      const result = await validateTaskResult(
        task,
        { requireArtifacts: true, evaluator: true, qualityReview: true, qualityThreshold: 3 },
        deps,
      );
      expect(result).toMatchObject({ passed: false, gate3Passed: false, gate3Score: 2 });
    });

    it('skipped when config.qualityReview=false', async () => {
      const task = makeTask({ summary: 'Done' });
      const deps = makeDeps();
      const result = await validateTaskResult(
        task,
        { requireArtifacts: true, evaluator: true, qualityReview: false },
        deps,
      );
      expect(result.gate3Passed).toBeUndefined();
      expect(deps.runQualityReviewer).not.toHaveBeenCalled();
    });

    it('runs explicit quality review when evaluator is disabled', async () => {
      const task = makeTask({ summary: 'Done' });
      const deps = makeDeps();
      const result = await validateTaskResult(
        task,
        { requireArtifacts: true, evaluator: false, qualityReview: true, qualityThreshold: 3 },
        deps,
      );

      expect(deps.runEvaluator).not.toHaveBeenCalled();
      expect(deps.runQualityReviewer).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ passed: true, gate1Passed: true, gate3Passed: true });
      expect(result.gate2Passed).toBeUndefined();
    });

    it('only runs after gate 2 passes', async () => {
      const task = makeTask({ summary: 'Done' });
      const deps = makeDeps({
        runEvaluator: vi.fn().mockResolvedValue({ passed: false, reason: 'Bad' }),
      });
      const result = await validateTaskResult(
        task,
        { requireArtifacts: true, evaluator: true, qualityReview: true },
        deps,
      );
      expect(result.gate2Passed).toBe(false);
      expect(result.gate3Passed).toBeUndefined();
      expect(deps.runQualityReviewer).not.toHaveBeenCalled();
    });

    it('does not start gate 3 when gate 2 aborts', async () => {
      const task = makeTask({ summary: 'Done' });
      const controller = new AbortController();
      const reason = new Error('stopped');
      const evalFn = vi.fn().mockImplementation(async () => {
        controller.abort(reason);
        return { passed: true, reason: 'late pass' };
      });
      const deps = makeDeps({ runEvaluator: evalFn });

      await expect(
        validateTaskResult(
          task,
          { requireArtifacts: true, evaluator: true, qualityReview: true },
          deps,
          { signal: controller.signal },
        ),
      ).rejects.toBe(reason);
      expect(deps.runQualityReviewer).not.toHaveBeenCalled();
    });

    it('does not begin validation when the signal is already aborted', async () => {
      const task = makeTask({ summary: 'Done' });
      const controller = new AbortController();
      const reason = new Error('stopped before validation');
      controller.abort(reason);
      const deps = makeDeps();

      await expect(
        validateTaskResult(
          task,
          { requireArtifacts: true, evaluator: true, qualityReview: true },
          deps,
          { signal: controller.signal },
        ),
      ).rejects.toBe(reason);
      expect(deps.runEvaluator).not.toHaveBeenCalled();
      expect(deps.runQualityReviewer).not.toHaveBeenCalled();
    });
  });

  // ── Full pipeline ────────────────────────────────────────────────────

  describe('Full pipeline', () => {
    it('all gates pass → result.passed=true', async () => {
      const task = makeTask({ summary: 'Done' });
      const result = await validateTaskResult(
        task,
        { requireArtifacts: true, evaluator: true, qualityReview: true, qualityThreshold: 3 },
        makeDeps(),
      );
      expect(result.passed).toBe(true);
      expect(result.gate1Passed).toBe(true);
      expect(result.gate2Passed).toBe(true);
      expect(result.gate3Passed).toBe(true);
    });

    it('gate 1 fails → gates 2+3 not called', async () => {
      const task = makeTask({ artifacts: [], summary: undefined });
      const deps = makeDeps();
      const result = await validateTaskResult(
        task,
        { requireArtifacts: true, evaluator: true, qualityReview: true },
        deps,
      );
      expect(result.passed).toBe(false);
      expect(result.gate1Passed).toBe(false);
      expect(deps.runEvaluator).not.toHaveBeenCalled();
      expect(deps.runQualityReviewer).not.toHaveBeenCalled();
    });

    it('gate 2 fails → gate 3 not called', async () => {
      const task = makeTask({ summary: 'Done' });
      const deps = makeDeps({
        runEvaluator: vi.fn().mockResolvedValue({ passed: false, reason: 'Nope' }),
      });
      const result = await validateTaskResult(
        task,
        { requireArtifacts: true, evaluator: true, qualityReview: true },
        deps,
      );
      expect(result.passed).toBe(false);
      expect(result.gate2Passed).toBe(false);
      expect(deps.runQualityReviewer).not.toHaveBeenCalled();
    });
  });
});

// ── buildRetryPrompt ───────────────────────────────────────────────────

describe('buildRetryPrompt', () => {
  it('includes attempt number', () => {
    const prompt = buildRetryPrompt('Do X', 'Failed because Y', 2);
    expect(prompt).toContain('Retry Attempt 2');
  });

  it('includes original prompt', () => {
    const prompt = buildRetryPrompt('Build a widget', 'Error', 1);
    expect(prompt).toContain('Build a widget');
  });

  it('includes failure reason', () => {
    const prompt = buildRetryPrompt('Do X', 'Missing output file', 1);
    expect(prompt).toContain('Missing output file');
  });

  it('formatted as clear sections', () => {
    const prompt = buildRetryPrompt('Do X', 'Failed', 1);
    expect(prompt).toContain('### Previous Failure');
    expect(prompt).toContain('### Original Task');
    expect(prompt).toContain('### Instructions');
  });
});
