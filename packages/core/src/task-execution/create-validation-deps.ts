import { createLogger, generateId } from '@raven/shared';
import type { EventBusInterface } from '@raven/shared';
import { z } from 'zod';
import type { ValidationDeps } from './validation-pipeline.ts';

const log = createLogger('validation-deps');

const EvaluatorOutputSchema = z.object({
  passed: z.boolean(),
  reason: z.string(),
});

const MAX_QUALITY_SCORE = 5;

const QualityReviewerOutputSchema = z.object({
  score: z.number().int().min(1).max(MAX_QUALITY_SCORE),
  feedback: z.string(),
  pass: z.boolean(),
});

const VALIDATION_TIMEOUT_MS = 120_000;

function parseValidatorJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

// Validators are prompt-hardcoded by design: runEvaluatorImpl/
// runQualityReviewerImpl build their own prompts below rather than reading
// projects/agents/_evaluator|_quality-reviewer/agent.yaml's `instructions`
// (or its model/maxTurns) — those YAML fields are not wired to this dispatch
// and must not be treated as configuring it. namedAgentId is passed through
// only for identification; validators have no project memory tools. `internal: 'validator'` is
// the actual privilege grant.
interface RunAgentOptions {
  eventBus: EventBusInterface;
  prompt: string;
  agentId: string;
  signal?: AbortSignal;
  projectId?: string;
  cancelAgentTask?: (id: string) => boolean;
}

interface AgentRunState {
  taskId: string;
  settled: boolean;
  dispatched: boolean;
  cancelAgentTask?: (id: string) => boolean;
}

interface SettleAgentRunOptions {
  state: AgentRunState;
  reason: unknown;
  reject: (reason?: unknown) => void;
  cleanup: () => void;
}

function settleAgentRun(options: SettleAgentRunOptions): void {
  const { state, reason, reject, cleanup } = options;
  if (state.settled) return;
  state.settled = true;
  cleanup();
  // Settle before invoking cancellation: it may synchronously emit completion.
  reject(reason);
  if (state.dispatched && state.cancelAgentTask) {
    try {
      state.cancelAgentTask(state.taskId);
    } catch (error) {
      log.warn(`Unable to cancel validation agent ${state.taskId}: ${String(error)}`);
    }
  }
}

interface ValidationRequestOptions {
  eventBus: EventBusInterface;
  taskId: string;
  prompt: string;
  agentId: string;
  projectId?: string;
}

function emitValidationRequest(options: ValidationRequestOptions): void {
  const { eventBus, taskId, prompt, agentId, projectId } = options;
  eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: 'validation-pipeline',
    type: 'agent:task:request',
    payload: {
      taskId,
      prompt,
      skillName: 'orchestrator',
      mcpServers: {},
      priority: 'low',
      namedAgentId: agentId,
      internal: 'validator',
      ...(projectId === undefined ? {} : { projectId }),
    },
  });
}

interface AgentCompletionOptions {
  state: AgentRunState;
  taskId: string;
  cleanup: () => void;
  resolve: (value: { result: string; success: boolean }) => void;
}

function createCompletionHandler(options: AgentCompletionOptions): (event: unknown) => void {
  const { state, taskId, cleanup, resolve } = options;
  return (event: unknown): void => {
    if (state.settled) return;
    const p = (
      event as {
        payload: { taskId: string; result: string; success: boolean; cancelled?: boolean };
      }
    ).payload;
    if (p.taskId !== taskId) return;
    state.settled = true;
    cleanup();
    resolve({ result: p.result, success: p.success && !p.cancelled });
  };
}

interface AgentTimeoutOptions {
  state: AgentRunState;
  agentId: string;
  reject: (reason?: unknown) => void;
  cleanup: () => void;
}

function createAgentTimeout(options: AgentTimeoutOptions): ReturnType<typeof setTimeout> {
  const { state, agentId, reject, cleanup } = options;
  return setTimeout(() => {
    settleAgentRun({
      state,
      reason: new Error(`Validation agent ${agentId} timed out after ${VALIDATION_TIMEOUT_MS}ms`),
      reject,
      cleanup,
    });
  }, VALIDATION_TIMEOUT_MS);
}

function waitForAgent(
  options: RunAgentOptions,
  taskId: string,
): Promise<{ result: string; success: boolean }> {
  const { eventBus, prompt, agentId, signal, projectId, cancelAgentTask } = options;
  return new Promise((resolve, reject) => {
    const state: AgentRunState = {
      taskId,
      settled: false,
      dispatched: false,
      cancelAgentTask,
    };

    const cleanup = (): void => {
      clearTimeout(timeout);
      eventBus.off('agent:task:complete', handler);
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = (): void => {
      settleAgentRun({
        state,
        reason: signal?.reason ?? new Error('Validation cancelled'),
        reject,
        cleanup,
      });
    };

    const handler = createCompletionHandler({ state, taskId, cleanup, resolve });
    const timeout = createAgentTimeout({ state, agentId, reject, cleanup });

    if (signal?.aborted) {
      settleAgentRun({
        state,
        reason: signal.reason ?? new Error('Validation cancelled'),
        reject,
        cleanup,
      });
      return;
    }

    eventBus.on('agent:task:complete', handler);
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      state.dispatched = true;
      emitValidationRequest({ eventBus, taskId, prompt, agentId, projectId });
    } catch (error) {
      settleAgentRun({ state, reason: error, reject, cleanup });
    }
  });
}

function runAgent(options: RunAgentOptions): Promise<{ result: string; success: boolean }> {
  return waitForAgent(options, generateId());
}

interface RunEvaluatorOptions {
  eventBus: EventBusInterface;
  taskPrompt: string;
  result: string;
  criteria?: string;
  treeId?: string;
  taskId?: string;
  projectId?: string;
  signal?: AbortSignal;
  cancelAgentTask?: (id: string) => boolean;
}

async function runEvaluatorImpl(
  options: RunEvaluatorOptions,
): Promise<{ passed: boolean; reason: string }> {
  const {
    eventBus,
    taskPrompt,
    result,
    criteria,
    treeId,
    taskId,
    projectId,
    signal,
    cancelAgentTask,
  } = options;
  const prompt = [
    'Evaluate this task result.',
    `Task: ${taskPrompt}`,
    `Result: ${result}`,
    ...(criteria ? [`Criteria: ${criteria}`] : []),
    'Respond with a JSON object only (no markdown, no extra text):',
    '{"passed": true|false, "reason": "<your reason>"}',
  ].join('\n');

  try {
    const response = await runAgent({
      eventBus,
      prompt,
      agentId: '_evaluator',
      signal,
      projectId,
      cancelAgentTask,
    });
    if (!response.success) {
      return { passed: false, reason: 'Evaluator agent failed' };
    }
    const parsed = EvaluatorOutputSchema.safeParse(parseValidatorJson(response.result.trim()));
    if (!parsed.success) {
      log.warn(`Evaluator output invalid: ${parsed.error.message}`);
      return { passed: false, reason: 'Evaluator returned invalid output' };
    }
    return { passed: parsed.data.passed, reason: parsed.data.reason };
  } catch (err) {
    log.warn(
      `Evaluator unavailable (tree=${treeId ?? 'unknown'}, task=${taskId ?? 'unknown'}): ${String(err)}`,
    );
    if (signal?.aborted) throw err;
    return { passed: false, reason: 'Evaluator validation failed' };
  }
}

interface RunQualityReviewerOptions {
  eventBus: EventBusInterface;
  taskPrompt: string;
  result: string;
  threshold: number;
  treeId?: string;
  taskId?: string;
  projectId?: string;
  signal?: AbortSignal;
  cancelAgentTask?: (id: string) => boolean;
}

function buildQualityPrompt(taskPrompt: string, result: string, threshold: number): string {
  return [
    'Review this task result for quality.',
    `Task: ${taskPrompt}`,
    `Result: ${result}`,
    `Quality threshold: ${String(threshold)}/${String(MAX_QUALITY_SCORE)}`,
    'Respond with a JSON object only (no markdown, no extra text):',
    `{"score": <1-${String(MAX_QUALITY_SCORE)}>, "feedback": "<your feedback>", "pass": <true if score >= ${String(threshold)}, else false>}`,
  ].join('\n');
}

function parseQualityResult(
  result: string,
  threshold: number,
): { passed: boolean; score: number; feedback: string } | undefined {
  const parsed = QualityReviewerOutputSchema.safeParse(parseValidatorJson(result.trim()));
  if (!parsed.success) {
    log.warn(`Quality reviewer output invalid: ${parsed.error.message}`);
    return undefined;
  }
  return {
    passed: parsed.data.pass && parsed.data.score >= threshold,
    score: parsed.data.score,
    feedback: parsed.data.feedback,
  };
}

async function runQualityReviewerImpl(
  options: RunQualityReviewerOptions,
): Promise<{ passed: boolean; score: number; feedback: string }> {
  const {
    eventBus,
    taskPrompt,
    result,
    threshold,
    treeId,
    taskId,
    projectId,
    signal,
    cancelAgentTask,
  } = options;
  const prompt = buildQualityPrompt(taskPrompt, result, threshold);
  try {
    const response = await runAgent({
      eventBus,
      prompt,
      agentId: '_quality-reviewer',
      signal,
      projectId,
      cancelAgentTask,
    });
    if (!response.success) {
      return { passed: false, score: 0, feedback: 'Quality reviewer agent failed' };
    }
    const qualityResult = parseQualityResult(response.result, threshold);
    if (!qualityResult) {
      return { passed: false, score: 0, feedback: 'Quality reviewer returned invalid output' };
    }
    return qualityResult;
  } catch (err) {
    log.warn(
      `Quality reviewer unavailable (tree=${treeId ?? 'unknown'}, task=${taskId ?? 'unknown'}): ${String(err)}`,
    );
    if (signal?.aborted) throw err;
    return {
      passed: false,
      score: 0,
      feedback: 'Quality reviewer validation failed',
    };
  }
}

export interface ValidationDepsOptions {
  cancelAgentTask?: (id: string) => boolean;
}

export function createValidationDeps(
  eventBus: EventBusInterface,
  factoryOptions: ValidationDepsOptions = {},
): ValidationDeps {
  return {
    runEvaluator: (taskPrompt, result, options) =>
      runEvaluatorImpl({
        eventBus,
        taskPrompt,
        result,
        criteria: options?.criteria,
        treeId: options?.treeId,
        taskId: options?.taskId,
        projectId: options?.projectId,
        signal: options?.signal,
        cancelAgentTask: factoryOptions.cancelAgentTask,
      }),
    runQualityReviewer: (taskPrompt, result, options) =>
      runQualityReviewerImpl({
        eventBus,
        taskPrompt,
        result,
        threshold: options.threshold,
        treeId: options.treeId,
        taskId: options.taskId,
        projectId: options.projectId,
        signal: options.signal,
        cancelAgentTask: factoryOptions.cancelAgentTask,
      }),
  };
}
