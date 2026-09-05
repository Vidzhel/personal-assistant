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

/** Identifies which tree/task a validation call is for and carries its lifetime. */
export interface ValidationContext {
  treeId?: string;
  taskId?: string;
  projectId?: string;
  signal?: AbortSignal;
}

export interface ValidationDeps {
  runEvaluator: (
    taskPrompt: string,
    result: string,
    options?: { criteria?: string } & ValidationContext,
  ) => Promise<{ passed: boolean; reason: string }>;
  runQualityReviewer: (
    taskPrompt: string,
    result: string,
    options: { threshold: number } & ValidationContext,
  ) => Promise<{ passed: boolean; score: number; feedback: string }>;
}

export interface ValidateTaskResultOptions extends ValidationContext {
  deps: ValidationDeps;
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new Error('Validation cancelled');
  }
}

function contextOptions(context: ValidationContext): ValidationContext {
  return {
    ...(context.treeId === undefined ? {} : { treeId: context.treeId }),
    ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
    ...(context.projectId === undefined ? {} : { projectId: context.projectId }),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  };
}

interface ResolvedValidationOptions {
  deps: ValidationDeps;
  signal?: AbortSignal;
  context: ValidationContext;
}

function resolveValidationOptions(
  task: ExecutionTask,
  options: ValidateTaskResultOptions,
): ResolvedValidationOptions {
  const context = {
    treeId: options.treeId ?? task.parentTaskId,
    taskId: options.taskId ?? task.id,
    projectId: options.projectId,
    signal: options.signal,
  } satisfies ValidationContext;
  return { deps: options.deps, signal: options.signal, context };
}

interface EvaluatorGateOptions {
  deps: ValidationDeps;
  taskPrompt: string;
  resultSummary: string;
  criteria?: string;
  context: ValidationContext;
  taskId: string;
}

async function runEvaluatorGate(
  options: EvaluatorGateOptions,
): Promise<{ passed: boolean; reason: string }> {
  const { deps, taskPrompt, resultSummary, criteria, context, taskId } = options;
  try {
    return await deps.runEvaluator(taskPrompt, resultSummary, {
      criteria,
      ...contextOptions(context),
    });
  } catch (error) {
    throwIfAborted(context.signal);
    log.warn(`Evaluator validation failed closed for task ${taskId}: ${String(error)}`);
    return { passed: false, reason: 'Evaluator validation failed' };
  }
}

interface QualityGateOptions {
  deps: ValidationDeps;
  taskPrompt: string;
  resultSummary: string;
  threshold: number;
  context: ValidationContext;
  taskId: string;
}

async function runQualityGate(
  options: QualityGateOptions,
): Promise<{ passed: boolean; score: number; feedback: string }> {
  const { deps, taskPrompt, resultSummary, threshold, context, taskId } = options;
  try {
    return await deps.runQualityReviewer(taskPrompt, resultSummary, {
      threshold,
      ...contextOptions(context),
    });
  } catch (error) {
    throwIfAborted(context.signal);
    log.warn(`Quality validation failed closed for task ${taskId}: ${String(error)}`);
    return { passed: false, score: 0, feedback: 'Quality validation failed' };
  }
}

function gate2Fields(evalResult: { passed: boolean; reason: string } | undefined): {
  gate2Passed?: boolean;
  gate2Reason?: string;
} {
  return evalResult ? { gate2Passed: true, gate2Reason: evalResult.reason } : {};
}

// ── Gate 1: Programmatic checks ────────────────────────────────────────

function runGate1(task: ExecutionTask, config: TaskValidationConfig): boolean {
  if (!config.requireArtifacts) {
    return true;
  }
  const hasArtifacts = task.artifacts.length > 0;
  return hasArtifacts;
}

// ── Main pipeline ──────────────────────────────────────────────────────

// eslint-disable-next-line max-lines-per-function -- sequential gate pipeline with early returns
export async function validateTaskResult(
  task: ExecutionTask,
  config: Partial<TaskValidationConfig> | undefined,
  options: ValidateTaskResultOptions,
): Promise<ValidationResult> {
  const resolvedConfig = TaskValidationConfigSchema.parse(config ?? {});
  const taskPrompt = getTaskPrompt(task);
  const resultSummary = getResultSummary(task);
  const { deps, signal, context: validationContext } = resolveValidationOptions(task, options);

  throwIfAborted(signal);

  // Gate 1: Programmatic
  const gate1Passed = runGate1(task, resolvedConfig);
  if (!gate1Passed) {
    log.info('Gate 1 failed: no artifacts', task.id);
    return { passed: false, gate1Passed: false };
  }

  // Gate 2: Evaluator
  let evalResult: { passed: boolean; reason: string } | undefined;
  if (resolvedConfig.evaluator) {
    evalResult = await runEvaluatorGate({
      deps,
      taskPrompt,
      resultSummary,
      criteria: resolvedConfig.evaluatorCriteria,
      context: validationContext,
      taskId: task.id,
    });
    throwIfAborted(signal);
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
  }

  // Quality review is an explicit gate and may run without the evaluator.
  if (resolvedConfig.qualityReview) {
    throwIfAborted(signal);
    const qrResult = await runQualityGate({
      deps,
      taskPrompt,
      resultSummary,
      threshold: resolvedConfig.qualityThreshold,
      context: validationContext,
      taskId: task.id,
    });
    throwIfAborted(signal);
    if (!qrResult.passed || qrResult.score < resolvedConfig.qualityThreshold) {
      log.info('Gate 3 failed: quality below threshold', task.id, qrResult.score);
      return {
        passed: false,
        gate1Passed: true,
        ...gate2Fields(evalResult),
        gate3Passed: false,
        gate3Score: qrResult.score,
        gate3Feedback: qrResult.feedback,
      };
    }
    log.debug('Gate 3 passed', task.id, qrResult.score);
    return {
      passed: true,
      gate1Passed: true,
      ...gate2Fields(evalResult),
      gate3Passed: true,
      gate3Score: qrResult.score,
      gate3Feedback: qrResult.feedback,
    };
  }

  return { passed: true, gate1Passed: true, ...gate2Fields(evalResult) };
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
