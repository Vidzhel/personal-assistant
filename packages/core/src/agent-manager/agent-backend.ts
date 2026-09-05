import type { SubAgentDefinition } from '@raven/shared';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';

export type AgentBackend = (opts: BackendOptions) => Promise<BackendResult>;

const CANCEL_DRAIN_MS = 1000;

/** Give cooperative backends time to stop; settle local work even if they ignore abort.
 * The abandoned promise stays observed. This does not cancel external work itself. */
export async function runCancellableBackend(
  backend: AgentBackend,
  options: BackendOptions,
): Promise<BackendResult> {
  const cancelled: BackendResult = { result: '', success: false, errors: ['cancelled'] };
  if (options.signal?.aborted) return cancelled;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const cancellation = new Promise<BackendResult>((resolve) => {
    onAbort = () => {
      timer = setTimeout(() => resolve(cancelled), CANCEL_DRAIN_MS);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const result = await Promise.race([backend(options), cancellation]);
    return options.signal?.aborted ? cancelled : result;
  } finally {
    clearTimeout(timer);
    if (onAbort) options.signal?.removeEventListener('abort', onAbort);
  }
}

export interface ToolUseMeta {
  parentToolUseId?: string | null; // null = main agent, string = sub-agent
  toolUseId?: string; // ID of this tool_use block
}

export interface BackendOptions {
  prompt: string;
  systemPrompt: string;
  allowedTools: string[];
  model: string;
  maxTurns: number;
  mcpServers: Record<string, unknown>;
  agents: Record<string, SubAgentDefinition>;
  plugins?: Array<{ type: 'local'; path: string }>;
  onAssistantMessage: (text: string, meta?: ToolUseMeta) => void;
  onToolUse?: (toolName: string, toolInput: string, meta?: ToolUseMeta) => void;
  onToolResult?: (result: {
    toolUseId: string;
    output: string;
    isError: boolean;
    meta?: ToolUseMeta;
  }) => void;
  onRawMessage?: (rawJson: string) => void;
  /** Called with the SDK-assigned session id as soon as it's known (the
   * `system`/`init` message), independent of whether the query eventually
   * succeeds, fails, or throws mid-stream. BackendResult.sessionId only
   * carries the id on a clean return — a mid-stream throw skips that
   * `return` entirely, so this callback is the only way the caller can
   * still observe (and link) a session id from a query that errored out
   * after establishing one. See agent-session.ts's runAgentTask. */
  onSessionId?: (id: string) => void;
  signal?: AbortSignal;
  onStderr: (data: string) => void;
  cwd?: string;
  /** SDK session id to resume — continues that session's history instead of
   * starting cold. Only set for chat turns (see agent-session.ts runAgentTask). */
  resume?: string;
  /** Test-only seam: overrides the SDK's `pathToClaudeCodeExecutable`, letting
   * tests point the backend at a fake executable instead of the real `claude`
   * CLI. Never set in production. */
  executablePathOverride?: string;
  /** Per-tool-call permission callback — see permission-engine/tool-policy.ts.
   * Threaded through with `permissionMode: 'default'` (sdk-backend.ts) in
   * place of the old `bypassPermissions` mode. Undefined when the task has
   * no permissionDeps (agent-session.ts), matching today's opt-in gating. */
  canUseTool?: CanUseTool;
}

export interface BackendResult {
  sessionId?: string;
  result: string;
  success: boolean;
  errors: string[];
}
