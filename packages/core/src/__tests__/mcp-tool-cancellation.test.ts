import { describe, expect, it, vi } from 'vitest';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { guardTool } from '../mcp-server/guard-tool.ts';
import { createToolCallLifetime } from '../mcp-server/tool-call-lifetime.ts';

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

  it('drains an admitted call after abort and releases it on success', async () => {
    const controller = new AbortController();
    const lifetime = createToolCallLifetime();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const handler = vi.fn(async () => {
      await pending;
      return { content: [{ type: 'text' as const, text: 'committed' }] };
    });
    const guarded = guardTool(
      tool('fixture', 'Fixture operation', {}, handler),
      controller.signal,
      lifetime,
    );
    const result = guarded.handler({}, {});
    controller.abort();
    lifetime.close();
    let drained = false;
    const drain = lifetime.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    finish();
    expect(await result).toMatchObject({ isError: true, content: [{ text: 'Task cancelled' }] });
    await drain;
    expect(drained).toBe(true);
    expect(lifetime.isOpen()).toBe(false);
  });

  it('refuses new calls after lifetime close without invoking the handler', async () => {
    const lifetime = createToolCallLifetime();
    const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'late' }] }));
    const guarded = guardTool(
      tool('fixture', 'Fixture operation', {}, handler),
      undefined,
      lifetime,
    );
    lifetime.close();
    expect(await guarded.handler({}, {})).toMatchObject({
      isError: true,
      content: [{ text: 'Task ended' }],
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('allows an already admitted call to finish after normal close', async () => {
    const lifetime = createToolCallLifetime();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const guarded = guardTool(
      tool('fixture', 'Fixture operation', {}, async () => {
        await pending;
        return { content: [{ type: 'text' as const, text: 'committed' }] };
      }),
      undefined,
      lifetime,
    );
    const result = guarded.handler({}, {});
    lifetime.close();
    const drain = lifetime.drain();
    finish();
    await expect(result).resolves.toMatchObject({ content: [{ text: 'committed' }] });
    await expect(drain).resolves.toBeUndefined();
  });

  it('releases admission when a handler throws', async () => {
    const lifetime = createToolCallLifetime();
    const guarded = guardTool(
      tool('fixture', 'Fixture operation', {}, async () => {
        throw new Error('handler failed');
      }),
      undefined,
      lifetime,
    );
    await expect(guarded.handler({}, {})).rejects.toThrow('handler failed');
    lifetime.close();
    await expect(lifetime.drain()).resolves.toBeUndefined();
  });
});
