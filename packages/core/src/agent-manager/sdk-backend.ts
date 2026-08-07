import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentBackend, BackendOptions, BackendResult } from './agent-backend.ts';

const INPUT_SUMMARY_MAX_LENGTH = 200;
const TOOL_RESULT_MAX_LENGTH = 500;

// eslint-disable-next-line max-lines-per-function -- manages SDK lifecycle with streaming message parsing
export function createSdkBackend(): AgentBackend {
  // eslint-disable-next-line max-lines-per-function, complexity -- SDK query with streaming message type routing
  return async (opts: BackendOptions): Promise<BackendResult> => {
    let sessionId: string | undefined;
    let resultText = '';
    let success = false;
    const errors: string[] = [];

    // The owner runs MAX-plan CLI auth (ANTHROPIC_API_KEY empty in
    // production): the SDK spawns its bundled `claude` binary and inherits
    // `~/.claude` auth. CLAUDECODE/CLAUDE_CODE_ENTRYPOINT are the nesting
    // guard the *outer* Claude Code session sets on this process's own env —
    // left in place, the spawned child would think it's nested inside
    // another Claude Code session and refuse to run. Delete rather than set
    // to `undefined`: Node's child_process would otherwise pass the literal
    // string "undefined" through as the env var's value.
    const env = { ...process.env } as Record<string, string>;
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    // Bridge the caller's AbortSignal (agent-manager.ts's cancelTask, via
    // agent-session.ts) into an SDK-native AbortController. Previously
    // cancellation was only checked between yielded messages (see the
    // opts.signal?.aborted check in the loop below) — a message with no
    // further output (a long tool call, a slow turn) meant an abort could
    // sit unnoticed for the query's full duration. Passing the SDK's own
    // abortController lets it cancel deterministically, including killing
    // the underlying subprocess.
    const abortController = new AbortController();
    if (opts.signal) {
      if (opts.signal.aborted) {
        abortController.abort();
      } else {
        opts.signal.addEventListener('abort', () => abortController.abort(), { once: true });
      }
    }

    const queryOptions: Record<string, unknown> = {
      systemPrompt: opts.systemPrompt,
      allowedTools: opts.allowedTools,
      // 'default' (not 'bypassPermissions'): the SDK calls canUseTool for
      // any tool it decides needs asking (its own risk heuristic for
      // built-in tools; unconditionally for MCP tools not in allowedTools —
      // see tool-policy.ts's module docstring for the evidence). Verified
      // live against the real SDK that 'default' + an always-resolving
      // canUseTool never blocks on an interactive prompt in this headless
      // context — the callback IS the "user" being asked. 'dontAsk' was
      // rejected: verified it auto-denies at the exact same decision point
      // WITHOUT ever invoking canUseTool, which would make the policy below
      // dead code. 'bypassPermissions' is gone entirely, along with the
      // `allowDangerouslySkipPermissions` flag that mode requires (and
      // which the code never set — see Phase 2 plan's Verified facts).
      permissionMode: 'default' as const,
      model: opts.model,
      maxTurns: opts.maxTurns,
      stderr: opts.onStderr,
      cwd: opts.cwd,
      env,
      abortController,
    };

    if (opts.canUseTool) {
      queryOptions.canUseTool = opts.canUseTool;
    }

    if (opts.resume) {
      queryOptions.resume = opts.resume;
    }

    if (opts.executablePathOverride) {
      queryOptions.pathToClaudeCodeExecutable = opts.executablePathOverride;
    }

    if (Object.keys(opts.mcpServers).length > 0) {
      queryOptions.mcpServers = opts.mcpServers;
      queryOptions.strictMcpConfig = true;
    }

    if (Object.keys(opts.agents).length > 0) {
      queryOptions.agents = opts.agents;
    }

    if (opts.plugins && opts.plugins.length > 0) {
      queryOptions.plugins = opts.plugins;
    }

    for await (const message of query({
      prompt: opts.prompt,
      options: queryOptions as Parameters<typeof query>[0]['options'],
    })) {
      if (opts.signal?.aborted) {
        errors.push('cancelled');
        break;
      }
      const msg = message as Record<string, unknown>;
      opts.onRawMessage?.(JSON.stringify(msg));

      if (msg.type === 'system' && msg.subtype === 'init') {
        sessionId = msg.session_id as string;
        opts.onSessionId?.(sessionId);
      }

      if (msg.type === 'assistant') {
        const parentToolUseId = (msg.parent_tool_use_id as string | null) ?? null;
        const content = msg.message as {
          content?: Array<{
            type: string;
            text?: string;
            name?: string;
            input?: unknown;
            id?: string;
          }>;
        };
        if (content?.content) {
          for (const block of content.content) {
            if (block.type === 'text' && block.text) {
              opts.onAssistantMessage(block.text, { parentToolUseId });
            }
            if (block.type === 'tool_use' && block.name && opts.onToolUse) {
              const inputSummary = block.input
                ? JSON.stringify(block.input).slice(0, INPUT_SUMMARY_MAX_LENGTH)
                : '';
              opts.onToolUse(block.name, inputSummary, {
                parentToolUseId,
                toolUseId: block.id,
              });
            }
          }
        }
      }

      if (msg.type === 'user') {
        const parentToolUseId = (msg.parent_tool_use_id as string | null) ?? null;
        const content = msg.message as {
          content?: Array<{
            type: string;
            tool_use_id?: string;
            content?: unknown;
            is_error?: boolean;
          }>;
        };
        if (content?.content && opts.onToolResult) {
          for (const block of content.content) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              const output =
                typeof block.content === 'string'
                  ? block.content
                  : JSON.stringify(block.content ?? '').slice(0, TOOL_RESULT_MAX_LENGTH);
              opts.onToolResult({
                toolUseId: block.tool_use_id,
                output,
                isError: block.is_error ?? false,
                meta: { parentToolUseId },
              });
            }
          }
        }
      }

      if (msg.type === 'result') {
        success = msg.subtype === 'success';
        resultText = (msg.result as string) ?? '';
        if (!success) {
          errors.push(`Agent ended with status: ${msg.subtype}`);
        }
      }
    }

    return { sessionId, result: resultText, success, errors };
  };
}
