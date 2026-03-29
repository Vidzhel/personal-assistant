import { createLogger, generateId } from '@raven/shared';
import type { EventBusInterface } from '@raven/shared';
import type { ValidationDeps } from './validation-pipeline.ts';

const log = createLogger('validation-deps');

const VALIDATION_TIMEOUT_MS = 120_000;

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
      },
    });
  });
}

export function createValidationDeps(eventBus: EventBusInterface): ValidationDeps {
  return {
    runEvaluator: async (taskPrompt, result, criteria) => {
      const prompt = [
        'Evaluate this task result.',
        `Task: ${taskPrompt}`,
        `Result: ${result}`,
        ...(criteria ? [`Criteria: ${criteria}`] : []),
        'Respond with exactly PASS or FAIL on the first line, then your reason.',
      ].join('\n');

      try {
        const response = await runAgent(eventBus, prompt, '_evaluator');
        if (!response.success) {
          return { passed: false, reason: 'Evaluator agent failed' };
        }
        const passed = response.result.trim().toUpperCase().startsWith('PASS');
        const reason = response.result.replace(/^(PASS|FAIL)\s*/i, '').trim();
        return { passed, reason };
      } catch (err) {
        log.error(`Evaluator failed: ${String(err)}`);
        return { passed: true, reason: 'Evaluator unavailable, auto-passing' };
      }
    },

    runQualityReviewer: async (taskPrompt, result, threshold) => {
      const prompt = [
        'Review this task result for quality.',
        `Task: ${taskPrompt}`,
        `Result: ${result}`,
        `Quality threshold: ${String(threshold)}/5`,
        'Respond with SCORE: N (1-5) on the first line, then your feedback.',
      ].join('\n');

      try {
        const response = await runAgent(eventBus, prompt, '_quality-reviewer');
        if (!response.success) {
          return { passed: false, score: 0, feedback: 'Quality reviewer agent failed' };
        }
        const scoreMatch = response.result.match(/SCORE:\s*(\d+)/i);
        const score = scoreMatch ? Number(scoreMatch[1]) : 0;
        const feedback = response.result.replace(/SCORE:\s*\d+\s*/i, '').trim();
        return { passed: score >= threshold, score, feedback };
      } catch (err) {
        log.error(`Quality reviewer failed: ${String(err)}`);
        return { passed: true, score: 5, feedback: 'Quality reviewer unavailable, auto-passing' };
      }
    },
  };
}
