import { describe, expect, it, vi } from 'vitest';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { guardTool } from '../mcp-server/guard-tool.ts';

describe('task MCP cancellation boundary', () => {
  it('rejects calls after abort before invoking their handler', async () => {
    const controller = new AbortController();
    const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'success' }] }));
    const guarded = guardTool(tool('fixture', 'Fixture mutation', {}, handler), controller.signal);
    controller.abort();
    expect(await guarded.handler({}, {})).toMatchObject({
      isError: true,
      content: [{ text: 'Task cancelled' }],
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not report a successful late response as uncancelled', async () => {
    const controller = new AbortController();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const guarded = guardTool(
      tool('fixture', 'Fixture operation', {}, async () => {
        await pending;
        return { content: [{ type: 'text' as const, text: 'success' }] };
      }),
      controller.signal,
    );
    const result = guarded.handler({}, {});
    controller.abort();
    finish();
    expect(await result).toMatchObject({ isError: true });
  });
});
