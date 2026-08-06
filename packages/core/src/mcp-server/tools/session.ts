import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { generateId } from '@raven/shared';
import type { RavenMcpDeps } from '../types.ts';
import type { ScopeContext } from '../scope.ts';

const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 100;

const errorResult = (
  message: string,
): { content: [{ type: 'text'; text: string }]; isError: true } => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

const okResult = (data: unknown): { content: [{ type: 'text'; text: string }] } => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
});

const SendMessageSchema = {
  content: z.string().describe('The message content to send'),
  format: z.enum(['text', 'markdown']).optional().describe('Message format'),
};

function buildSendMessage(
  deps: RavenMcpDeps,
  scope: ScopeContext,
): SdkMcpToolDefinition<typeof SendMessageSchema> {
  return tool(
    'send_message',
    'Send a message to the current session as the assistant.',
    SendMessageSchema,
    async (args) => {
      if (!scope.sessionId) {
        return errorResult('No sessionId in scope — cannot send_message');
      }

      const messageId = deps.messageStore?.appendMessage(scope.sessionId, {
        role: 'assistant',
        content: args.content,
      });

      deps.eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: 'mcp-server',
        type: 'agent:message',
        payload: {
          taskId: scope.taskId ?? '',
          sessionId: scope.sessionId,
          messageType: 'assistant',
          content: args.content,
          messageId: messageId ?? undefined,
        },
      });

      return okResult({ messageId });
    },
  );
}

const GetSessionHistorySchema = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_HISTORY_LIMIT)
    .optional()
    .describe('Maximum number of messages to return (1-100, default 20)'),
};

function buildGetSessionHistory(
  deps: RavenMcpDeps,
  scope: ScopeContext,
): SdkMcpToolDefinition<typeof GetSessionHistorySchema> {
  return tool(
    'get_session_history',
    'Retrieve the message history for the current session.',
    GetSessionHistorySchema,
    async (args) => {
      if (!scope.sessionId) {
        return errorResult('No sessionId in scope — cannot get_session_history');
      }

      const limit = args.limit ?? DEFAULT_HISTORY_LIMIT;
      const all = deps.messageStore?.getMessages(scope.sessionId) ?? [];
      const messages = all.slice(-limit).map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        agentName: m.agentName,
      }));

      return okResult({ messages });
    },
    {
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
  );
}

// Heterogeneous collection: each builder above keeps its own concrete,
// zod-inferred schema type (no `any`); only this array — which must hold
// tools with different schemas side by side, and whose elements are called
// with per-tool concrete args in the test suite via `.find()` — needs the
// erasure, matching the SDK's own `Array<SdkMcpToolDefinition<any>>` field
// on `createSdkMcpServer`.
export function buildSessionTools(
  deps: RavenMcpDeps,
  scope: ScopeContext,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK type erasure at heterogeneous tool collection (see comment above)
): Array<SdkMcpToolDefinition<any>> {
  return [buildSendMessage(deps, scope), buildGetSessionHistory(deps, scope)];
}
