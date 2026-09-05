import { createLogger, generateId } from '@raven/shared';
import type { AgentTask, McpServerConfig, PermissionTier, SubAgentDefinition } from '@raven/shared';
import type { MessageStore } from '../session-manager/message-store.ts';
import type { SessionManager } from '../session-manager/session-manager.ts';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { PermissionEngine } from '../permission-engine/permission-engine.ts';
import type { AuditLog } from '../permission-engine/audit-log.ts';
import type { PendingApprovals } from '../permission-engine/pending-approvals.ts';
import type { CapabilityLibrary } from '../capability-library/capability-library.ts';
import { createToolPolicy } from '../permission-engine/tool-policy.ts';
import { buildSystemPrompt } from './prompt-builder.ts';
import { getConfig, projectRoot } from '../config.ts';
import type { AgentBackend, ToolUseMeta } from './agent-backend.ts';
import { runCancellableBackend } from './agent-backend.ts';
import { createSdkBackend } from './sdk-backend.ts';
import { createRavenMcp, type RavenMcpDeps, type ScopeContext } from '../mcp-server/index.ts';
import type { MemoryStore } from '../agent-memory/memory-store.ts';
import { createMemoryMcp } from '../mcp-server/memory-mcp.ts';
import { getAvailableKnowledgeTools } from '../mcp-server/tools/knowledge.ts';
import { formatMemoryBlock } from '../agent-memory/memory-store.ts';

const log = createLogger('agent-session');

const STDERR_LOG_TAIL_LENGTH = -2000;
const STDERR_ERROR_TAIL_LENGTH = -500;

let activeBackend: AgentBackend | null = null;

/**
 * One backend: the SDK drives the same `claude` binary under CLI/MAX auth
 * that a hand-rolled CLI spawn used to (see sdk-backend.ts's env stripping).
 * ANTHROPIC_API_KEY, when set, simply flows through as an env var rather
 * than selecting a different code path — there is no more CLI/SDK split.
 */
export function initializeBackend(): void {
  activeBackend = createSdkBackend();
  log.info('Agent backend: SDK');
}

/**
 * Test/override seam: inject a backend directly, bypassing the SDK/CLI
 * selection in initializeBackend(). Used by createRaven's `agentBackend`
 * override so tests never spawn a real subprocess.
 */
export function setActiveBackend(backend: AgentBackend): void {
  activeBackend = backend;
  log.info('Agent backend: injected (override)');
}

function getActiveBackend(): AgentBackend {
  if (!activeBackend) {
    // Fallback: auto-initialize if not explicitly initialized yet
    initializeBackend();
  }
  // initializeBackend always sets activeBackend
  return activeBackend as AgentBackend;
}

export interface AgentSessionResult {
  taskId: string;
  sdkSessionId?: string;
  result: string;
  durationMs: number;
  success: boolean;
  blocked?: boolean;
  errors?: string[];
}

export interface PermissionDeps {
  permissionEngine: PermissionEngine;
  auditLog: AuditLog;
  pendingApprovals: PendingApprovals;
  /** Optional: only used by the canUseTool policy's unmapped-MCP-tool
   * fallback (tool-policy.ts) — absent degrades that fallback to 'yellow'. */
  capabilityLibrary?: CapabilityLibrary;
}

export interface RunOptions {
  task: AgentTask;
  eventBus: EventBus;
  mcpServers: Record<string, McpServerConfig>;
  agentDefinitions: Record<string, SubAgentDefinition>;
  plugins?: Array<{ type: 'local'; path: string }>;
  actionName?: string;
  permissionDeps?: PermissionDeps;
  messageStore?: MessageStore;
  signal?: AbortSignal;
  ravenMcpDeps?: RavenMcpDeps;
  memoryStore?: MemoryStore;
  /** Overrides `config.CLAUDE_MODEL` for this one dispatch — e.g.
   * memory-consolidation.ts resolving a named agent's own model tier
   * (haiku/opus) instead of the global default. Omitted by every other
   * caller today (session-retrospective.ts, knowledge-consolidation.ts),
   * which keep using the global default unchanged. */
  model?: string;
  /** Overrides `config.RAVEN_AGENT_MAX_TURNS` for this one dispatch — e.g.
   * heartbeat.ts caps its ambient check-in turn low (8) since it's an
   * unattended background dispatch, not an interactive chat turn where the
   * owner's own patience is the real limiter. Omitted by every other
   * caller, which keep using the global default unchanged. */
  maxTurns?: number;
  /** Used to resume the SDK session for chat turns (task.sessionId set) and
   * to record the session id the backend returns. Execution/validation
   * tasks never carry task.sessionId (see orchestrator.ts vs
   * execution-bridge.ts), so they stay cold by design even when this is
   * provided. */
  sessionManager?: SessionManager;
}

export interface GateResult {
  allowed: boolean;
  tier: PermissionTier;
  reason?: string;
}

// eslint-disable-next-line max-lines-per-function -- handles green/yellow/red permission tiers with audit and event emission
export function enforcePermissionGate(
  actionName: string,
  deps: PermissionDeps & { eventBus: EventBus },
  context: { sessionId?: string; skillName: string },
): GateResult {
  const tier = deps.permissionEngine.resolveTier(actionName);

  if (tier === 'green') {
    deps.auditLog.insert({
      skillName: context.skillName,
      actionName,
      permissionTier: tier,
      outcome: 'executed',
      sessionId: context.sessionId,
    });
    return { allowed: true, tier };
  }

  if (tier === 'yellow') {
    deps.auditLog.insert({
      skillName: context.skillName,
      actionName,
      permissionTier: tier,
      outcome: 'executed',
      sessionId: context.sessionId,
    });
    deps.eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'permission-gate',
      type: 'permission:approved',
      payload: {
        actionName,
        skillName: context.skillName,
        tier,
        sessionId: context.sessionId,
      },
    });
    return { allowed: true, tier };
  }

  // Red tier: block and queue
  deps.auditLog.insert({
    skillName: context.skillName,
    actionName,
    permissionTier: tier,
    outcome: 'queued',
    sessionId: context.sessionId,
  });
  const approval = deps.pendingApprovals.insert({
    actionName,
    skillName: context.skillName,
    details: `Blocked: ${actionName}`,
    sessionId: context.sessionId,
  });
  deps.eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: 'permission-gate',
    type: 'permission:blocked',
    payload: {
      actionName,
      skillName: context.skillName,
      tier,
      approvalId: approval.id,
      sessionId: context.sessionId,
    },
  });
  return { allowed: false, tier, reason: 'queued-for-approval' };
}

/** Records which sub-agent type a top-level `Agent` tool_use started, keyed
 * by its tool_use id, so later tool_use/message events from that sub-agent
 * (identified via `parentToolUseId`) can be attributed back to it — see
 * resolveAgentName below. Only top-level Agent invocations are tracked
 * (`!meta?.parentToolUseId`); a sub-agent's own nested Agent calls (if any)
 * aren't attributed further. */
function trackAgentToolUse(
  agentToolMap: Map<string, string>,
  toolUse: { toolName: string; toolInput: string; meta?: ToolUseMeta },
): void {
  const { toolName, toolInput, meta } = toolUse;
  if (toolName !== 'Agent' || meta?.parentToolUseId || !meta?.toolUseId) return;

  try {
    const input = JSON.parse(toolInput) as Record<string, unknown>;
    const subagentType = (input.subagent_type as string) ?? (input.description as string);
    if (subagentType) {
      agentToolMap.set(meta.toolUseId, subagentType);
    }
  } catch {
    // toolInput may be truncated — ignore parse errors
  }
}

function resolveAgentRole(task: AgentTask): ScopeContext['role'] {
  // Validators dispatched by create-validation-deps.ts carry
  // internal: 'validator' on the request — set only by that runtime
  // dispatcher, never by an agent-authored request, so this scope cannot be
  // self-granted by simply naming an agent '_evaluator'/'_quality-reviewer'
  // (namedAgentId is fully agent-authorable and must not gate this).
  if (task.internal === 'validator') return 'validation';
  if (task.executionTaskId) return 'task';
  if (task.skillName === '_quality-reviewer' || task.skillName === '_evaluator')
    return 'validation';
  if (task.skillName === 'knowledge') return 'knowledge';
  return 'chat';
}

/**
 * Runs a single agent task using Claude Agent SDK query().
 * This is the core execution unit - each call spawns a fresh agent
 * with only the MCPs needed for this specific task.
 */
// eslint-disable-next-line max-lines-per-function, complexity -- core orchestration function managing full agent lifecycle
export async function runAgentTask(opts: RunOptions): Promise<AgentSessionResult> {
  const {
    task,
    eventBus,
    mcpServers,
    agentDefinitions,
    actionName,
    permissionDeps,
    messageStore,
    signal,
  } = opts;
  const config = getConfig();
  const startTime = Date.now();

  if (signal?.aborted) {
    return {
      taskId: task.id,
      result: 'Task cancelled',
      durationMs: 0,
      success: false,
      errors: ['cancelled'],
    };
  }

  log.info(`Starting agent task ${task.id} for skill ${task.skillName}`);

  // Permission gate: enforce before query() only when actionName is
  // explicitly provided, and skip it entirely when this task is the
  // synthetic re-dispatch for an action a human already approved
  // (AgentManager.executeAction sets task.approvedActionName ===
  // actionName in that case) — otherwise resolveTier would report the same
  // red tier again and the approve -> re-run loop would never close. The
  // canUseTool policy built below carries the same approvedActionName
  // forward so the actual tool call it gates during this run isn't
  // re-blocked either.
  if (permissionDeps && actionName && actionName !== task.approvedActionName) {
    const gateResult = enforcePermissionGate(
      actionName,
      { ...permissionDeps, eventBus },
      { sessionId: task.sessionId, skillName: task.skillName },
    );

    if (!gateResult.allowed) {
      log.info(
        `Task ${task.id} blocked by permission gate (action: ${actionName}, tier: ${gateResult.tier})`,
      );
      return {
        taskId: task.id,
        result: `Action blocked: ${actionName} requires approval (tier: ${gateResult.tier})`,
        durationMs: Date.now() - startTime,
        success: false,
        blocked: true,
        errors: [gateResult.reason ?? 'blocked'],
      };
    }
  }

  let sdkSessionId: string | undefined;
  let resultText = '';
  let success = false;
  const errors: string[] = [];
  const stderrChunks: string[] = [];

  try {
    // Build MCP config - transform our config to backend format
    const sdkMcpServers: Record<string, unknown> = {};
    for (const [name, cfg] of Object.entries(mcpServers)) {
      sdkMcpServers[name] = {
        command: cfg.command,
        args: cfg.args,
        env: cfg.env,
        // SDK 0.3.x connects external MCPs non-blocking by default, which can
        // let turn 1 start before a task's tools register. Raven only hands a
        // task an MCP it needs, so block until connected (5s cap) — restores
        // the pre-0.3.x turn-1 availability the system was built against.
        alwaysLoad: true,
      };
    }

    // Per-agent identity used for memory MCP and system prompt injection.
    const memoryAgentName = task.namedAgentId;

    const scope: ScopeContext = {
      role: resolveAgentRole(task),
      projectId: task.projectId,
      sessionId: task.sessionId,
      treeId: task.treeId,
      taskId: task.executionTaskId,
      agentTaskId: task.id,
    };

    // Add Raven MCP (in-process, scoped to this task)
    if (opts.ravenMcpDeps) {
      const ravenMcp = createRavenMcp(opts.ravenMcpDeps, scope, signal);
      sdkMcpServers['raven'] = ravenMcp;
    }

    // Per-agent memory MCP: in-process, scoped to this agent's own directory.
    // Identity is the named agent id, which equals the agent's YAML name (id === name).
    if (opts.memoryStore && memoryAgentName) {
      sdkMcpServers['memory'] = createMemoryMcp({
        signal,
        memoryStore: opts.memoryStore,
        agentName: memoryAgentName,
      });
    }

    let systemPrompt = buildSystemPrompt(task, undefined, {
      chatMcpAvailable: Boolean(opts.ravenMcpDeps) && scope.role === 'chat',
      hasSubAgents: Object.keys(agentDefinitions).length > 0,
      knowledgeTools: opts.ravenMcpDeps ? getAvailableKnowledgeTools(opts.ravenMcpDeps, scope) : [],
    });
    if (opts.memoryStore && memoryAgentName) {
      const memoryIndex = await opts.memoryStore.readIndex(memoryAgentName);
      if (memoryIndex) {
        systemPrompt = `${systemPrompt}\n\n${formatMemoryBlock(memoryIndex)}`;
      }
    }

    // Compute allowed tools: base tools + Agent delegation only. Bash and
    // integration-MCP tool wildcards (buildMcpToolPattern for task.mcpServers)
    // are deliberately NOT pre-authorized here: a tool name listed in
    // allowedTools bypasses the canUseTool policy built below entirely —
    // verified live against the real SDK (see tool-policy.ts's module
    // docstring) — so Bash and mcp__<server>__* must fall through to the
    // SDK's "ask" path where that policy actually gets to decide per call.
    // Raven/memory MCP tools stay pre-authorized: the policy allows them
    // unconditionally anyway (already role-scoped — mcp-server/index.ts's
    // ScopeContext), so there's no enforcement value in round-tripping them.
    const allowedTools = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];

    if (opts.ravenMcpDeps) {
      allowedTools.push('mcp__raven__*');
    }
    if (opts.memoryStore && memoryAgentName) {
      allowedTools.push('mcp__memory__*');
    }
    const hasSubAgents = Object.keys(agentDefinitions).length > 0;
    if (hasSubAgents) {
      allowedTools.push('Agent');
    }

    // canUseTool: built per task (it has task.bashAccess + task.skillName +
    // task.approvedActionName already) and threaded into the backend below.
    // Undefined when this task has no permissionDeps, matching today's
    // opt-in gating (see runAgentTask's pre-check above for the same guard).
    const canUseTool = permissionDeps
      ? createToolPolicy(
          {
            permissionEngine: permissionDeps.permissionEngine,
            auditLog: permissionDeps.auditLog,
            pendingApprovals: permissionDeps.pendingApprovals,
            capabilityLibrary: permissionDeps.capabilityLibrary,
            eventBus,
          },
          {
            skillName: task.skillName,
            sessionId: task.sessionId,
            bashAccess: task.bashAccess,
            approvedActionName: task.approvedActionName,
          },
        )
      : undefined;

    const prompt = task.prompt;

    // Track Agent tool_use IDs → sub-agent type for attribution
    const agentToolMap = new Map<string, string>();

    function resolveAgentName(meta?: ToolUseMeta): string | undefined {
      if (!meta?.parentToolUseId) return undefined;
      return agentToolMap.get(meta.parentToolUseId);
    }

    // Resume only applies to chat turns: task.sessionId is set exclusively
    // by orchestrator.ts's handleUserChat (see AgentTaskRequestEvent.payload
    // .sessionId). Execution-bridge dispatches and validator tasks never set
    // it, so they always run cold — resuming session state into an unrelated
    // task/validation lineage would leak chat context across it.
    const resume =
      task.sessionId && opts.sessionManager
        ? opts.sessionManager.getSdkSessionId(task.sessionId)
        : undefined;

    const backend = getActiveBackend();
    const backendResult = await runCancellableBackend(backend, {
      prompt,
      resume,
      systemPrompt,
      allowedTools,
      model: opts.model ?? config.CLAUDE_MODEL,
      maxTurns: opts.maxTurns ?? config.RAVEN_AGENT_MAX_TURNS,
      mcpServers: sdkMcpServers,
      agents: agentDefinitions,
      plugins: opts.plugins,
      canUseTool: canUseTool
        ? (...args) =>
            signal?.aborted
              ? Promise.resolve({ behavior: 'deny' as const, message: 'Task cancelled' })
              : canUseTool(...args).then((result) =>
                  signal?.aborted
                    ? { behavior: 'deny' as const, message: 'Task cancelled' }
                    : result,
                )
        : undefined,
      onAssistantMessage: (text: string, meta?: ToolUseMeta) => {
        if (signal?.aborted) return;
        const agentName = resolveAgentName(meta);
        let messageId: string | undefined;
        if (task.sessionId && messageStore) {
          messageId = messageStore.appendMessage(task.sessionId, {
            role: 'assistant',
            content: text,
            taskId: task.id,
            agentName,
          });
        }
        eventBus.emit({
          id: generateId(),
          timestamp: Date.now(),
          source: task.skillName,
          projectId: task.projectId,
          type: 'agent:message',
          payload: {
            taskId: task.id,
            sessionId: task.sessionId,
            messageType: 'assistant',
            content: text,
            messageId,
            agentName,
          },
        });
      },
      // Note: Bash commands are no longer audited here. Enforcement (and its
      // audit trail) now happens PRE-execution in the canUseTool policy
      // (tool-policy.ts) built above and threaded into the backend call —
      // this callback only fires after the SDK already ran the tool, so it
      // would be purely observational and redundant with that policy's own
      // audit writes.
      onToolUse: (toolName: string, toolInput: string, meta?: ToolUseMeta) => {
        if (signal?.aborted) return;
        trackAgentToolUse(agentToolMap, { toolName, toolInput, meta });

        const agentName = resolveAgentName(meta);
        let messageId: string | undefined;
        if (task.sessionId && messageStore) {
          messageId = messageStore.appendMessage(task.sessionId, {
            role: 'action',
            content: `${toolName}: ${toolInput}`,
            taskId: task.id,
            toolName,
            toolSummary: toolInput,
            agentName,
          });
        }
        eventBus.emit({
          id: generateId(),
          timestamp: Date.now(),
          source: task.skillName,
          projectId: task.projectId,
          type: 'agent:message',
          payload: {
            taskId: task.id,
            sessionId: task.sessionId,
            messageType: 'tool_use',
            content: `${toolName}: ${toolInput}`,
            messageId,
            agentName,
          },
        });
      },
      onToolResult: (result) => {
        if (signal?.aborted) return;
        const agentName = resolveAgentName(result.meta);
        if (task.sessionId && messageStore) {
          messageStore.appendMessage(task.sessionId, {
            role: 'tool-result',
            content: result.output,
            taskId: task.id,
            toolName: result.toolUseId,
            toolSummary: result.isError ? 'error' : 'success',
            agentName,
          });
        }
      },
      onRawMessage: (rawJson: string) => {
        if (signal?.aborted) return;
        if (task.sessionId && messageStore) {
          messageStore.appendRawMessage(task.sessionId, rawJson);
        }
      },
      // Captured as soon as the backend observes the SDK's `system`/`init`
      // message — independent of whether the query goes on to succeed,
      // fail, or throw mid-stream. This is the only source of sdkSessionId
      // on a throw (backendResult.sessionId is never assigned in that case,
      // since the throw skips the backend's `return` entirely).
      onSessionId: (id: string) => {
        if (signal?.aborted) return;
        sdkSessionId = id;
      },
      signal,
      onStderr: (data: string) => {
        if (signal?.aborted) return;
        stderrChunks.push(data);
        log.debug(`Agent stderr: ${data.trim()}`);
      },
      cwd: projectRoot,
    });

    sdkSessionId = backendResult.sessionId ?? sdkSessionId;
    resultText = backendResult.result;
    success = backendResult.success;
    errors.push(...backendResult.errors);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const stderrOutput = stderrChunks.join('');
    log.error(`Agent task ${task.id} failed: ${errMsg}`);
    if (stderrOutput) {
      log.error(`Agent stderr output: ${stderrOutput.slice(STDERR_LOG_TAIL_LENGTH)}`);
    }
    errors.push(signal?.aborted ? 'cancelled' : errMsg);
    if (stderrOutput) {
      errors.push(`stderr: ${stderrOutput.slice(STDERR_ERROR_TAIL_LENGTH)}`);
    }
  } finally {
    // Always link, even when resuming and even on a mid-stream throw: if
    // the SDK continues the same session id this is a no-op, but resume
    // can also fork to a new id, in which case the next turn must resume
    // from the latest one, not the one we started this turn with. Linking
    // from `finally` (F2) — rather than only on the try block's success
    // path — means a session id observed via onSessionId above still gets
    // persisted even when the query throws right after establishing it;
    // otherwise the next turn would have no sdk session to resume at all.
    if (task.sessionId && opts.sessionManager && sdkSessionId) {
      opts.sessionManager.linkSdkSession(task.sessionId, sdkSessionId);
    }
  }

  const durationMs = Date.now() - startTime;

  return {
    taskId: task.id,
    sdkSessionId,
    result: resultText,
    durationMs,
    success,
    errors: errors.length > 0 ? errors : undefined,
  };
}
