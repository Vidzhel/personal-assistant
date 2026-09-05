import { describe, expect, it } from 'vitest';
import { createToolCallLifetime } from '../mcp-server/tool-call-lifetime.ts';

describe('ToolCallLifetime', () => {
  it('admits multiple calls and makes release idempotent', async () => {
    const lifetime = createToolCallLifetime();
    const releaseOne = lifetime.tryEnter();
    const releaseTwo = lifetime.tryEnter();
    expect(lifetime.isOpen()).toBe(true);
    expect(releaseOne).toBeTypeOf('function');
    expect(releaseTwo).toBeTypeOf('function');
    lifetime.close();
    expect(lifetime.tryEnter()).toBeUndefined();
    let drained = false;
    const drain = lifetime.drain().then(() => {
      drained = true;
    });
    releaseOne?.();
    releaseOne?.();
    await Promise.resolve();
    expect(drained).toBe(false);
    releaseTwo?.();
    await drain;
    expect(drained).toBe(true);
  });

  it('resolves drain immediately when there are no admitted calls', async () => {
    const lifetime = createToolCallLifetime();
    await expect(lifetime.drain()).resolves.toBeUndefined();
    lifetime.close();
    await expect(lifetime.drain()).resolves.toBeUndefined();
  });
});
