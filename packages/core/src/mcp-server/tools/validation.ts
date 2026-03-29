import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { generateId } from '@raven/shared';
import type { RavenMcpDeps } from '../types.ts';
import type { ScopeContext } from '../scope.ts';

const MAX_VALIDATION_SCORE = 5;

const okResult = (data: unknown): { content: [{ type: 'text'; text: string }] } => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
});

export function buildValidationTools(
  deps: RavenMcpDeps,
  scope: ScopeContext,
): SdkMcpToolDefinition[] {
  const submitValidationScore = tool(
    'submit_validation_score',
    'Submit a validation score for a task. Provide a score (1-5), feedback, and whether the task passed.',
    {
      score: z
        .number()
        .int()
        .min(1)
        .max(MAX_VALIDATION_SCORE)
        .describe('Validation score from 1 (worst) to 5 (best)'),
      feedback: z.string().describe('Detailed feedback explaining the score'),
      pass: z.boolean().describe('Whether the task passes validation'),
    },
    async (args) => {
      deps.eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: 'mcp-server',
        type: 'execution:task:validation',
        payload: {
          treeId: scope.treeId ?? '',
          taskId: scope.taskId ?? '',
          score: args.score,
          feedback: args.feedback,
          pass: args.pass,
        },
      });

      return okResult({ ack: true });
    },
  );

  return [submitValidationScore];
}
