import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { ToolCallLifetime } from './tool-call-lifetime.ts';

/** Reject new calls after task completion/cancellation and drain admitted work.
 * An admitted mutation retains its own commit/rollback semantics. */
export function guardTool<Schema extends SdkMcpToolDefinition['inputSchema']>(
  definition: SdkMcpToolDefinition<Schema>,
  signal?: AbortSignal,
  lifetime?: ToolCallLifetime,
): SdkMcpToolDefinition<Schema> {
  const rejected = (text: string): Awaited<ReturnType<typeof definition.handler>> => ({
    isError: true,
    content: [{ type: 'text' as const, text }],
  });
  return {
    ...definition,
    async handler(args, extra) {
      if (signal?.aborted) return rejected('Task cancelled');
      const release = lifetime?.tryEnter();
      if (lifetime && !release) return rejected('Task ended');
      try {
        const result = await definition.handler(args, extra);
        return signal?.aborted ? rejected('Task cancelled') : result;
      } finally {
        release?.();
      }
    },
  };
}
