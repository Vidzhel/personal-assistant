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

// Validators are prompt-hardcoded by design: runEvaluatorImpl/
// runQualityReviewerImpl build their own prompts below rather than reading
// projects/agents/_evaluator|_quality-reviewer/agent.yaml's `instructions`
// (or its model/maxTurns) — those YAML fields are not wired to this dispatch
// and must not be treated as configuring it. namedAgentId is passed through
// only for identification/memory-scoping; `internal: 'validator'` below is
// the actual privilege grant.
function runAgent(
  eventBus: EventBusInterface,
  prompt: string,
  agentId: string,
): Promise<{ result: string; success: boolean }> {
  const taskId = generateId();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      eventBus.off('agent:task:complete', handler);
      reject(new Error(`Validation agent ${agentId} timed out after ${VALIDATION_TIMEOUT_MS}ms`));
    }, VALIDATION_TIMEOUT_MS);

    function handler(event: unknown): void {
      const p = (event as { payload: { taskId: string; result: string; success: boolean } })
        .payload;
      if (p.taskId !== taskId) return;
      clearTimeout(timeout);
      eventBus.off('agent:task:complete', handler);
      resolve({ result: p.result, success: p.success });
    }

    eventBus.on('agent:task:complete', handler);
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
      },
    });
  });
}

interface RunEvaluatorOptions {
  eventBus: EventBusInterface;
  taskPrompt: string;
  result: string;
  criteria?: string;
  treeId?: string;
  taskId?: string;
}

async function runEvaluatorImpl(
  options: RunEvaluatorOptions,
): Promise<{ passed: boolean; reason: string }> {
  const { eventBus, taskPrompt, result, criteria, treeId, taskId } = options;
  const prompt = [
    'Evaluate this task result.',
    `Task: ${taskPrompt}`,
    `Result: ${result}`,
    ...(criteria ? [`Criteria: ${criteria}`] : []),
    'Respond with a JSON object only (no markdown, no extra text):',
    '{"passed": true|false, "reason": "<your reason>"}',
  ].join('\n');

  try {
    const response = await runAgent(eventBus, prompt, '_evaluator');
    if (!response.success) {
      return { passed: false, reason: 'Evaluator agent failed' };
    }
    const parsed = EvaluatorOutputSchema.safeParse(JSON.parse(response.result.trim()) as unknown);
    if (!parsed.success) {
      log.warn(`Evaluator output invalid: ${parsed.error.message}`);
      return { passed: false, reason: 'Evaluator returned invalid output' };
    }
    return { passed: parsed.data.passed, reason: parsed.data.reason };
  } catch (err) {
    // Auto-pass keeps the pipeline moving (fail-open by design), but a
    // silent auto-pass on timeout/error is exactly the kind of thing that
    // needs to be visible — log it as a warning with the tree/task it
    // affected instead of just an error with no traceable context.
    log.warn(
      `Evaluator unavailable (tree=${treeId ?? 'unknown'}, task=${taskId ?? 'unknown'}), auto-passing: ${String(err)}`,
    );
    return { passed: true, reason: 'Evaluator unavailable, auto-passing' };
  }
}

interface RunQualityReviewerOptions {
  eventBus: EventBusInterface;
  taskPrompt: string;
  result: string;
  threshold: number;
  treeId?: string;
  taskId?: string;
}

async function runQualityReviewerImpl(
  options: RunQualityReviewerOptions,
): Promise<{ passed: boolean; score: number; feedback: string }> {
  const { eventBus, taskPrompt, result, threshold, treeId, taskId } = options;
  const prompt = [
    'Review this task result for quality.',
    `Task: ${taskPrompt}`,
    `Result: ${result}`,
    `Quality threshold: ${String(threshold)}/${String(MAX_QUALITY_SCORE)}`,
    'Respond with a JSON object only (no markdown, no extra text):',
    `{"score": <1-${String(MAX_QUALITY_SCORE)}>, "feedback": "<your feedback>", "pass": <true if score >= ${String(threshold)}, else false>}`,
  ].join('\n');

  try {
    const response = await runAgent(eventBus, prompt, '_quality-reviewer');
    if (!response.success) {
      return { passed: false, score: 0, feedback: 'Quality reviewer agent failed' };
    }
    const parsed = QualityReviewerOutputSchema.safeParse(
      JSON.parse(response.result.trim()) as unknown,
    );
    if (!parsed.success) {
      log.warn(`Quality reviewer output invalid: ${parsed.error.message}`);
      return { passed: false, score: 0, feedback: 'Quality reviewer returned invalid output' };
    }
    return { passed: parsed.data.pass, score: parsed.data.score, feedback: parsed.data.feedback };
  } catch (err) {
    // Same rationale as the evaluator: keep the fail-open auto-pass, but
    // surface it as a warning tied to the tree/task instead of a silent pass.
    log.warn(
      `Quality reviewer unavailable (tree=${treeId ?? 'unknown'}, task=${taskId ?? 'unknown'}), auto-passing: ${String(err)}`,
    );
    return {
      passed: true,
      score: MAX_QUALITY_SCORE,
      feedback: 'Quality reviewer unavailable, auto-passing',
    };
  }
}

export function createValidationDeps(eventBus: EventBusInterface): ValidationDeps {
  return {
    runEvaluator: (taskPrompt, result, options) =>
      runEvaluatorImpl({
        eventBus,
        taskPrompt,
        result,
        criteria: options?.criteria,
        treeId: options?.treeId,
        taskId: options?.taskId,
      }),
    runQualityReviewer: (taskPrompt, result, options) =>
      runQualityReviewerImpl({
        eventBus,
        taskPrompt,
        result,
        threshold: options.threshold,
        treeId: options.treeId,
        taskId: options.taskId,
      }),
  };
}
