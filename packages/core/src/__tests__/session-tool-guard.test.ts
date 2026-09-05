import { describe, expect, it, vi } from 'vitest';
import type { CanUseTool, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { createSessionToolGuard } from '../agent-manager/session-tool-guard.ts';
import { createToolCallLifetime } from '../mcp-server/tool-call-lifetime.ts';

function call(toolName = 'Bash'): PreToolUseHookInput {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: { command: 'echo hello' },
    tool_use_id: 'tool-1',
    session_id: 'sdk-1',
    transcript_path: '/tmp/test-transcript',
    cwd: '/tmp',
  };
}

describe('SDK hook and permission callback guard', () => {
  it('checks policy in the hook and avoids duplicate callback side effects', async () => {
    const policy = vi.fn<CanUseTool>(async (_tool, input) => ({
      behavior: 'allow',
      updatedInput: input,
    }));
    const assertCurrent = vi.fn();
    const guard = createSessionToolGuard({
      lifetime: createToolCallLifetime(),
      assertCurrent,
      policy,
    });
    const signal = new AbortController().signal;
    expect(await guard.preToolUse(call(), 'tool-1', { signal })).toEqual({});
    expect(
      await guard.canUseTool('Bash', call().tool_input as Record<string, unknown>, {
        signal,
        toolUseID: 'tool-1',
        requestId: 'request-1',
      }),
    ).toMatchObject({ behavior: 'allow' });
    expect(policy).toHaveBeenCalledOnce();
    expect(assertCurrent).toHaveBeenCalledTimes(3);
  });

  it('denies red-tier calls before SDK bypass mode can approve them', async () => {
    const policy: CanUseTool = async () => ({ behavior: 'deny', message: 'Queued for approval' });
    const guard = createSessionToolGuard({
      lifetime: createToolCallLifetime(),
      assertCurrent: () => {},
      policy,
    });
    expect(
      await guard.preToolUse(call('mcp__mail__send'), 'tool-1', {
        signal: new AbortController().signal,
      }),
    ).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: 'Queued for approval',
      },
    });
  });

  it('does not reuse a hook decision after ownership changes or input is rewritten', async () => {
    let current = true;
    const policy = vi.fn<CanUseTool>(async (_tool, input) => ({
      behavior: 'allow',
      updatedInput: input,
    }));
    const assertCurrent = () => {
      if (!current) throw new Error('Workspace revoked');
    };
    const guard = createSessionToolGuard({
      lifetime: createToolCallLifetime(),
      assertCurrent,
      policy,
    });
    const options = {
      signal: new AbortController().signal,
      toolUseID: 'tool-1',
      requestId: 'request-1',
    };
    await guard.preToolUse(call(), 'tool-1', options);
    await guard.canUseTool('Bash', { command: 'changed' }, options);
    expect(policy).toHaveBeenCalledTimes(2);
    current = false;
    expect(await guard.canUseTool('Bash', {}, options)).toMatchObject({
      behavior: 'deny',
      message: 'Workspace revoked',
    });
    expect(await guard.preToolUse(call(), 'tool-2', options)).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    expect(policy).toHaveBeenCalledTimes(2);
  });

  it('drains a pending policy and denies after cancellation or completion', async () => {
    let release!: () => void;
    const policy = vi.fn<CanUseTool>(async (_tool, input) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { behavior: 'allow', updatedInput: input };
    });
    const lifetime = createToolCallLifetime();
    const guard = createSessionToolGuard({ lifetime, assertCurrent: () => {}, policy });
    const controller = new AbortController();
    const pending = guard.preToolUse(call(), 'tool-1', { signal: controller.signal });
    await vi.waitFor(() => expect(policy).toHaveBeenCalledOnce());
    lifetime.close();
    let drained = false;
    const drain = lifetime.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    controller.abort();
    release();
    expect(await pending).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    await drain;
    expect(
      await guard.canUseTool(
        'Bash',
        {},
        { signal: controller.signal, toolUseID: 'later', requestId: 'request-later' },
      ),
    ).toMatchObject({ behavior: 'deny' });
    expect(policy).toHaveBeenCalledOnce();
  });
});
