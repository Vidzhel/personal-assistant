import { createLogger } from '@raven/shared';
import type { ExecutionTask, TaskValidationConfig } from '@raven/shared';
import { TaskValidationConfigSchema } from '@raven/shared';

const log = createLogger('validation-pipeline');

// ── Types ──────────────────────────────────────────────────────────────

export interface ValidationResult {
  passed: boolean;
  gate1Passed: boolean;
  gate2Passed?: boolean;
  gate2Reason?: string;
  gate3Passed?: boolean;
  gate3Score?: number;
  gate3Feedback?: string;
}

export interface ValidationDeps {
  runEvaluator: (
    taskPrompt: string,
    result: string,
    criteria?: string,
  ) => Promise<{ passed: boolean; reason: string }>;
  runQualityReviewer: (
    taskPrompt: string,
    result: string,
    threshold: number,
  ) => Promise<{ passed: boolean; score: number; feedback: string }>;
}

// ── Helpers ────────────────────────────────────────────────────────────

function getTaskPrompt(task: ExecutionTask): string {
  if (task.node.type === 'agent') {
    return task.node.prompt;
  }
  return task.node.title;
}

function getResultSummary(task: ExecutionTask): string {
  return task.summary ?? '';
}

// ── Gate 1: Programmatic checks ────────────────────────────────────────

function runGate1(task: ExecutionTask, config: TaskValidationConfig): boolean {
  if (!config.requireArtifacts) {
    return true;
  }
  const hasArtifacts = task.artifacts.length > 0;
  const hasSummary = !!task.summary && task.summary.trim().length > 0;
  return hasArtifacts || hasSummary;
}

// ── Main pipeline ──────────────────────────────────────────────────────

// eslint-disable-next-line max-lines-per-function -- sequential gate pipeline with early returns
export async function validateTaskResult(
  task: ExecutionTask,
  config: Partial<TaskValidationConfig> | undefined,
  deps: ValidationDeps,
): Promise<ValidationResult> {
  const resolvedConfig = TaskValidationConfigSchema.parse(config ?? {});
  const taskPrompt = getTaskPrompt(task);
  const resultSummary = getResultSummary(task);

  // Gate 1: Programmatic
  const gate1Passed = runGate1(task, resolvedConfig);
  if (!gate1Passed) {
    log.info('Gate 1 failed: no artifacts or summary', task.id);
    return { passed: false, gate1Passed: false };
  }

  // Gate 2: Evaluator
  if (resolvedConfig.evaluator) {
    const evalResult = await deps.runEvaluator(
      taskPrompt,
      resultSummary,
      resolvedConfig.evaluatorCriteria,
    );
    if (!evalResult.passed) {
      log.info('Gate 2 failed: evaluator rejected result', task.id, evalResult.reason);
      return {
        passed: false,
        gate1Passed: true,
        gate2Passed: false,
        gate2Reason: evalResult.reason,
      };
    }
    log.debug('Gate 2 passed', task.id);

    // Gate 3: Quality Review (only after gate 2 passes)
    if (resolvedConfig.qualityReview) {
      const qrResult = await deps.runQualityReviewer(
        taskPrompt,
        resultSummary,
        resolvedConfig.qualityThreshold,
      );
      if (!qrResult.passed) {
        log.info('Gate 3 failed: quality below threshold', task.id, qrResult.score);
        return {
          passed: false,
          gate1Passed: true,
          gate2Passed: true,
          gate3Passed: false,
          gate3Score: qrResult.score,
          gate3Feedback: qrResult.feedback,
        };
      }
      log.debug('Gate 3 passed', task.id, qrResult.score);
      return {
        passed: true,
        gate1Passed: true,
        gate2Passed: true,
        gate2Reason: evalResult.reason,
        gate3Passed: true,
        gate3Score: qrResult.score,
        gate3Feedback: qrResult.feedback,
      };
    }

    return {
      passed: true,
      gate1Passed: true,
      gate2Passed: true,
      gate2Reason: evalResult.reason,
    };
  }

  // Gate 2 skipped — check gate 3 independently? No, spec says gate 3 only runs after gate 2
  return { passed: true, gate1Passed: true };
}

// ── Retry prompt builder ───────────────────────────────────────────────

export function buildRetryPrompt(
  originalPrompt: string,
  lastError: string,
  attempt: number,
): string {
  return [
    `## Retry Attempt ${String(attempt)}`,
    '',
    '### Previous Failure',
    lastError,
    '',
    '### Original Task',
    originalPrompt,
    '',
    '### Instructions',
    'Please address the feedback above and re-attempt the original task.',
    'Focus specifically on resolving the issues mentioned in the previous failure.',
  ].join('\n');
}
