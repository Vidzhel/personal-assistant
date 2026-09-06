import type { CanUseTool, HookCallback, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { ToolCallLifetime } from '../mcp-server/tool-call-lifetime.ts';

interface GuardDeps {
  lifetime: ToolCallLifetime;
  assertCurrent: () => void;
  policy?: CanUseTool;
}

const MAX_CACHED_DECISIONS = 2000;

function deny(error: unknown): PermissionResult {
  return { behavior: 'deny', message: error instanceof Error ? error.message : String(error) };
}

function assertOpen(deps: GuardDeps): void {
  if (!deps.lifetime.isOpen()) throw new Error('Task no longer accepts tool calls');
  deps.assertCurrent();
}

async function evaluate(deps: GuardDeps, args: Parameters<CanUseTool>): Promise<PermissionResult> {
  let release: (() => void) | undefined;
  try {
    assertOpen(deps);
    if (args[2].signal.aborted) return deny('Tool call cancelled');
    release = deps.lifetime.tryEnter();
    if (!release) return deny('Task no longer accepts tool calls');
    const result = deps.policy
      ? await deps.policy(...args)
      : { behavior: 'allow' as const, updatedInput: args[1] };
    assertOpen(deps);
    return args[2].signal.aborted
      ? deny('Tool call cancelled')
      : (result ?? deny('Tool policy returned no decision'));
  } catch (error) {
    return deny(error);
  } finally {
    release?.();
  }
}

/** Hooks enforce Raven policy before SDK auto/bypass/allowedTools decisions.
 * Cache only the matching hook result so the normal callback cannot double-audit. */
export function createSessionToolGuard(deps: GuardDeps): {
  preToolUse: HookCallback;
  canUseTool: CanUseTool;
} {
  const decisions = new Map<string, { signature: string; result: PermissionResult }>();
  const preToolUse: HookCallback = async (input, toolUseID, options) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const args = input.tool_input as Record<string, unknown>;
    const id = toolUseID ?? input.tool_use_id;
    const result = await evaluate(deps, [
      input.tool_name,
      args,
      { ...options, toolUseID: id, requestId: `hook:${id}` },
    ]);
    if (decisions.size >= MAX_CACHED_DECISIONS) decisions.clear();
    decisions.set(id, { signature: JSON.stringify([input.tool_name, args]), result });
    return result.behavior === 'deny'
      ? {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: result.message,
          },
        }
      : deps.policy && input.tool_name.startsWith('mcp__')
        ? {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'allow',
              updatedInput: result.updatedInput ?? args,
            },
          }
        : {};
  };
  const canUseTool: CanUseTool = async (...args) => {
    try {
      assertOpen(deps);
      if (args[2].signal.aborted) return deny('Tool call cancelled');
      const cached = decisions.get(args[2].toolUseID);
      decisions.delete(args[2].toolUseID);
      if (cached?.signature === JSON.stringify([args[0], args[1]])) return cached.result;
      return await evaluate(deps, args);
    } catch (error) {
      return deny(error);
    }
  };
  return { preToolUse, canUseTool };
}
