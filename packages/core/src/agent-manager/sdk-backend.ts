import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentBackend, BackendOptions, BackendResult } from './agent-backend.ts';

const INPUT_SUMMARY_MAX_LENGTH = 200;
const TOOL_RESULT_MAX_LENGTH = 500;
const COST_FALLBACK_SUBTYPES = new Set(['success', 'error_max_turns', 'error_max_budget_usd']);

function readModelCost(entry: unknown): number | undefined {
  if (entry === null || typeof entry !== 'object') return undefined;
  const cost = (entry as { costUSD?: unknown }).costUSD;
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
}

function readModelUsageCost(usage: unknown): number | undefined {
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return undefined;
  const entries = Object.values(usage as Record<string, unknown>);
  if (entries.length === 0) return undefined;
  let total = 0;
  for (const entry of entries) {
    const cost = readModelCost(entry);
    if (cost === undefined) return undefined;
    total += cost;
  }
  return Number.isFinite(total) ? total : undefined;
}

function readEstimatedCost(message: Record<string, unknown>): number | undefined {
  const modelCost = readModelUsageCost(message.modelUsage);
  if (
    modelCost !== undefined &&
    (COST_FALLBACK_SUBTYPES.has(String(message.subtype)) || modelCost > 0)
  ) {
    return modelCost;
  }

  if (
    typeof message.subtype !== 'string' ||
    !COST_FALLBACK_SUBTYPES.has(message.subtype) ||
    typeof message.total_cost_usd !== 'number' ||
    !Number.isFinite(message.total_cost_usd) ||
    message.total_cost_usd < 0
  ) {
    return undefined;
  }
  return message.total_cost_usd;
}

// eslint-disable-next-line max-lines-per-function -- manages SDK lifecycle with streaming message parsing
export function createSdkBackend(): AgentBackend {
  // eslint-disable-next-line max-lines-per-function, complexity -- SDK query with streaming message type routing
  return async (opts: BackendOptions): Promise<BackendResult> => {
    let sessionId: string | undefined;
    let resultText = '';
    let success = false;
    const errors: string[] = [];
    let estimatedCostUsd: number | undefined;

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
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';

    // Bridge the caller's AbortSignal (agent-manager.ts's cancelTask, via
    // agent-session.ts) into an SDK-native AbortController. Previously
    // cancellation was only checked between yielded messages (see the
    // opts.signal?.aborted check in the loop below) — a message with no
    // further output (a long tool call, a slow turn) meant an abort could
    // sit unnoticed for the query's full duration. Passing the SDK's own
    // abortController lets it cancel deterministically, including killing
    // the underlying subprocess.
    const abortController = new AbortController();
    if (opts.signal?.aborted) return { result: '', success: false, errors: ['cancelled'] };
    const onAbort = (): void => abortController.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const queryOptions: Record<string, unknown> = {
      systemPrompt: opts.systemPrompt,
      allowedTools: opts.allowedTools,
      permissionMode: opts.permissionMode ?? 'default',
      model: opts.model,
      maxTurns: opts.maxTurns,
      stderr: opts.onStderr,
      cwd: opts.cwd,
      env,
      abortController,
      additionalDirectories: opts.additionalDirectories,
      settingSources: opts.settingSources ?? [],
      hooks: opts.hooks,
      strictMcpConfig: true,
    };

    if (opts.permissionMode === 'bypassPermissions') {
      queryOptions.allowDangerouslySkipPermissions = true;
    }

    if (opts.maxBudgetUsd !== undefined) {
      queryOptions.maxBudgetUsd = opts.maxBudgetUsd;
    }

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
    }

    if (Object.keys(opts.agents).length > 0) {
      queryOptions.agents = opts.agents;
    }

    if (opts.plugins && opts.plugins.length > 0) {
      queryOptions.plugins = opts.plugins;
    }

    try {
      for await (const message of query({
        prompt: opts.prompt,
        options: queryOptions as Parameters<typeof query>[0]['options'],
      })) {
        const msg = message as Record<string, unknown>;
        if (msg.type === 'result') {
          // Result costs are cumulative. A later result supersedes an earlier
          // estimate, including when its usage is unavailable; retaining an
          // older value would under-report work done after that result.
          estimatedCostUsd = readEstimatedCost(msg);
        }
        if (opts.signal?.aborted) {
          errors.push('cancelled');
          success = false;
          resultText = '';
          break;
        }
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
    } catch (error) {
      if (opts.signal?.aborted) {
        if (!errors.includes('cancelled')) errors.push('cancelled');
        success = false;
        resultText = '';
      } else {
        errors.push(error instanceof Error ? error.message : String(error));
        success = false;
      }
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
    }
    return {
      sessionId,
      result: resultText,
      success,
      errors,
      ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
    };
  };
}
