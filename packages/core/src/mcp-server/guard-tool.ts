import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';

/** Reject new calls and late success responses after task cancellation.
 * An already admitted mutation retains its own commit/rollback semantics. */
export function guardTool<Schema extends SdkMcpToolDefinition['inputSchema']>(
  definition: SdkMcpToolDefinition<Schema>,
  signal?: AbortSignal,
): SdkMcpToolDefinition<Schema> {
  const cancelled = (): Awaited<ReturnType<typeof definition.handler>> => ({
    isError: true,
    content: [{ type: 'text' as const, text: 'Task cancelled' }],
  });
  return {
    ...definition,
    async handler(args, extra) {
      if (signal?.aborted) return cancelled();
      const result = await definition.handler(args, extra);
      return signal?.aborted ? cancelled() : result;
    },
  };
}
