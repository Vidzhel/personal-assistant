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
      expect(evalFn).toHaveBeenCalledWith('Build a widget', 'Result text', undefined);
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
