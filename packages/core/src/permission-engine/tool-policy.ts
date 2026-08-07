import { createLogger, generateId } from '@raven/shared';
import type { AuditOutcome, BashAccess, PermissionTier } from '@raven/shared';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { checkBashAccess, globMatch } from '../bash-gate/bash-gate.ts';
import type { BashGateResult } from '../bash-gate/bash-gate.ts';
import { parseCommand } from '../bash-gate/command-parser.ts';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { PermissionEngine } from './permission-engine.ts';
import type { AuditLog } from './audit-log.ts';
import type { PendingApprovals } from './pending-approvals.ts';
import type { CapabilityLibrary } from '../capability-library/capability-library.ts';

const log = createLogger('tool-policy');

const DEFAULT_BASH_ACCESS: BashAccess = {
  access: 'none',
  allowedCommands: [],
  deniedCommands: [],
  allowedPaths: [],
  deniedPaths: [],
};

const AUDIT_COMMAND_TRUNCATE_LENGTH = 200;

/**
 * The SDK's per-tool-call permission callback (see sdk.d.ts's `CanUseTool` /
 * `PermissionResult`). Passed to `query()` as `canUseTool` with
 * `permissionMode: 'default'` (sdk-backend.ts) — this REPLACES the old
 * `bypassPermissions` mode. `enforcePermissionGate` (agent-session.ts)
 * remains as the coarse, pre-dispatch gate for tasks that carry an explicit
 * `actionName`; this policy is the fine-grained, per-tool-call gate that
 * fires *during* an agent's run, for every Bash command and every
 * integration-MCP tool call the model actually makes — including ones a
 * coarse actionName-based dispatch never anticipated.
 *
 * ## SDK invocation semantics (empirically verified against the real SDK —
 * `@anthropic-ai/claude-agent-sdk`, live `query()` probes, since sdk.d.ts's
 * comments alone don't specify this):
 *
 * - A tool name listed in `allowedTools` (BackendOptions/agent-session.ts)
 *   bypasses this callback ENTIRELY — the SDK auto-allows it without ever
 *   calling canUseTool, regardless of how "dangerous" the actual call looks
 *   (verified: `Bash` in allowedTools skips canUseTool even for `rm -rf`).
 *   This is why agent-session.ts's allowedTools construction must NOT
 *   include `Bash` or any integration-MCP wildcard (`mcp__<server>__*`) —
 *   doing so would silently disable this policy for exactly the calls it
 *   exists to gate.
 * - MCP tool calls not in `allowedTools` ALWAYS invoke this callback,
 *   unconditionally — verified for both a "boring" call (send_email with a
 *   valid recipient) and a call with no special framing. There is no
 *   built-in "this MCP tool looks safe" heuristic; every non-allowlisted MCP
 *   tool call reaches us.
 * - Built-in `Bash` calls only invoke this callback when the SDK's OWN
 *   internal risk heuristic flags the command as needing confirmation
 *   (verified: `echo hello` never reaches canUseTool, in OR out of
 *   allowedTools; `rm -rf` and `Write` always do, when not in allowedTools).
 *   This means the Bash branch below is a real, but PARTIAL, pre-execution
 *   gate: it reliably catches whatever the SDK itself already suspects, and
 *   correctly enforces `task.bashAccess` for those; it does not see every
 *   single Bash invocation the model makes. This is still strictly stronger
 *   than the observational post-execution audit it replaces (which saw
 *   every command, but only after the SDK had already run it).
 *
 * ## MCP tool name -> action name mapping
 *
 * Verified against library/skills/communication/email/gmail/config.json +
 * library/mcps/gmail.json, library/skills/productivity/task-management/
 * ticktick/config.json + library/mcps/ticktick.json, and the real tool
 * names registered by packages/mcp-ticktick/src/tools.ts (the in-repo
 * ticktick MCP server).
 *
 * The SDK calls this callback with `toolName = mcp__<server>__<tool>`,
 * where `<server>` is the MCP server key (== the library mcp's `name`,
 * e.g. "gmail", "ticktick") and `<tool>` is that server's own tool name
 * (snake_case for the in-repo ticktick server; vendor-defined for gmail-mcp).
 * Skill action names are `<skill>:<kebab-action>` (e.g. "ticktick:create-task").
 *
 * These do NOT map 1:1: ticktick's `create_task`/`update_task`/
 * `delete_task`/`complete_task` all match their `ticktick:*` action
 * counterparts exactly after snake_case -> kebab-case conversion, but
 * `get_task`/`get_all_tasks`/`filter_tasks`/`get_today_tasks`/
 * `get_completed_tasks` and every project-management tool
 * (`get_projects`, `create_project`, `delete_project`, `move_task`, ...)
 * have no declared action at all.
 *
 * Rule shipped (tier-by-tool-name with a conservative per-server fallback):
 *   1. `actionName = "${server}:${kebabCase(tool)}"`.
 *   2. If `actionName` is a KNOWN action (present in
 *      `permissionEngine.getActionCatalog()`) -> `resolveTier(actionName)`.
 *   3. Else -> the MAX (worst) tier among every action declared by any skill
 *      that references this MCP server (conservative: an unmapped tool on a
 *      skill that also has a red action is treated as red; an unmapped tool
 *      on an all-green/yellow skill is treated as yellow, not blindly
 *      trusted).
 *   4. Else (no skill references this server, or it declares zero actions)
 *      -> 'yellow'.
 *
 * ## Sub-agent MCP routing probe (2026-08-07, live `query()` probe, in-process
 * `createSdkMcpServer` echo tool + a sub-agent whose `tools` included the
 * `mcp__probe__*` pattern, delegated to via the `Agent` tool — no external
 * credentials/MCPs involved):
 *
 * - CONFIRMED: `canUseTool` DOES fire for a sub-agent's own MCP tool calls —
 *   it is NOT bypassed for delegated work. The callback fired with
 *   `options.agentID` populated to the sub-agent's id (undefined/absent for
 *   the top-level agent's own calls), which is the SDK's own way of telling
 *   the policy which agent triggered the request. This means AgentDefinition
 *   `tools` entries carrying `mcp__<server>__*` patterns (capability-library.ts's
 *   collectAgentDefinitions) are gated by this exact same policy when the
 *   sub-agent actually calls them — no separate mitigation (e.g. a
 *   PreToolUse hook) is needed for this concern.
 * - SURPRISE, unrelated to the routing question but discovered by the same
 *   probe and directly affecting THIS module: on the currently-installed
 *   `@anthropic-ai/claude-agent-sdk`, returning the bare
 *   `{ behavior: 'allow' }` this file's `allow()` helper used to return
 *   throws a runtime `ZodError` INSIDE the SDK for any MCP tool call (proven
 *   for both a top-level call and a sub-agent call) — the tool_result comes
 *   back as an error ("Tool permission request failed: ZodError... expected
 *   record, received undefined" at `updatedInput`), even though
 *   `sdk.d.ts` marks `updatedInput` as optional. `allow()` now takes the
 *   tool's `input` and echoes it back as `updatedInput` to satisfy the
 *   SDK's actual runtime schema. Every call site below was updated to pass
 *   its `input` through. This was silently broken in production for every
 *   gated MCP tool call (and would have broken this PR's own H2 file-tool
 *   gating) — the existing test suite never caught it because it mocks the
 *   SDK's `query()` entirely and never exercises this validation path.
 */

export interface ToolPolicyTaskContext {
  skillName: string;
  sessionId?: string;
  bashAccess?: BashAccess;
  /** See AgentTask.approvedActionName (packages/shared/src/types/agents.ts).
   * When a resolved action name equals this, the policy allows it directly
   * instead of re-resolving its tier — closes the approve -> re-run loop for
   * AgentManager.executeAction's synthetic task. */
  approvedActionName?: string;
}

export interface ToolPolicyDeps {
  permissionEngine: PermissionEngine;
  auditLog: AuditLog;
  pendingApprovals: PendingApprovals;
  eventBus: EventBus;
  /** Optional: only needed for the "unmapped MCP tool" fallback (rule #3
   * above). Absent (or failed to load) -> that fallback degrades to 'yellow'
   * (rule #4). */
  capabilityLibrary?: CapabilityLibrary;
}

const MCP_TOOL_NAME_PATTERN = /^mcp__([a-zA-Z0-9-]+)__(.+)$/;
const TIER_RANK: Record<PermissionTier, number> = { green: 0, yellow: 1, red: 2 };

function toKebabCase(toolName: string): string {
  return toolName.replace(/_/g, '-');
}

function maxTier(tiers: PermissionTier[]): PermissionTier {
  return tiers.reduce<PermissionTier>(
    (max, tier) => (TIER_RANK[tier] > TIER_RANK[max] ? tier : max),
    'green',
  );
}

/** Rule #3/#4: conservative fallback tier for an MCP tool with no declared
 * action, derived from the skill(s) that reference this MCP server. */
function fallbackTierForServer(
  capabilityLibrary: CapabilityLibrary | undefined,
  server: string,
): PermissionTier {
  if (!capabilityLibrary) return 'yellow';

  try {
    const tiers: PermissionTier[] = [];
    for (const skillName of capabilityLibrary.getSkillNames()) {
      const skill = capabilityLibrary.getSkill(skillName);
      if (!skill?.config.mcps.includes(server)) continue;
      for (const action of skill.config.actions) {
        tiers.push(action.defaultTier);
      }
    }
    return tiers.length > 0 ? maxTier(tiers) : 'yellow';
  } catch (err) {
    log.warn(
      `Capability library unavailable for MCP server fallback tier (${server}): ${err instanceof Error ? err.message : String(err)}`,
    );
    return 'yellow';
  }
}

function resolveIntegrationAction(
  deps: ToolPolicyDeps,
  server: string,
  tool: string,
): { actionName: string; tier: PermissionTier } {
  const actionName = `${server}:${toKebabCase(tool)}`;
  const isKnown = deps.permissionEngine
    .getActionCatalog()
    .some((entry) => entry.name === actionName);

  if (isKnown) {
    return { actionName, tier: deps.permissionEngine.resolveTier(actionName) };
  }

  return { actionName, tier: fallbackTierForServer(deps.capabilityLibrary, server) };
}

// See this file's module docstring, "Sub-agent MCP routing probe" — the
// SDK's runtime PermissionResult validator requires `updatedInput` to be a
// record on the 'allow' branch even though sdk.d.ts marks it optional.
// Echoing the tool's own input back unchanged is the correct no-op default.
function allow(input: Record<string, unknown> = {}): PermissionResult {
  return { behavior: 'allow', updatedInput: input };
}

function deny(message: string): PermissionResult {
  return { behavior: 'deny', message };
}

function handleBash(
  deps: ToolPolicyDeps,
  task: ToolPolicyTaskContext,
  input: Record<string, unknown>,
): PermissionResult {
  const command = typeof input.command === 'string' ? input.command : '';
  const bashAccess = task.bashAccess ?? DEFAULT_BASH_ACCESS;
  const chain = parseCommand(command);
  const gateResult = checkBashAccess(command, bashAccess);
  const actionName = `bash:${chain.allBinaries[0] ?? 'unknown'}`;
  const details = `access=${bashAccess.access} cmd="${command.slice(0, AUDIT_COMMAND_TRUNCATE_LENGTH)}"${gateResult.reason ? ` reason=${gateResult.reason}` : ''}`;

  deps.auditLog.insert({
    skillName: task.skillName,
    actionName,
    permissionTier: gateResult.allowed ? 'green' : 'red',
    outcome: gateResult.allowed ? 'executed' : 'denied',
    sessionId: task.sessionId,
    details,
  });

  if (gateResult.allowed) {
    log.info(`Bash allowed [${bashAccess.access}] cmd="${chain.allBinaries.join(' | ')}"`);
    return allow(input);
  }

  log.warn(
    `Bash denied [${bashAccess.access}] cmd="${chain.allBinaries.join(' | ')}": ${gateResult.reason}`,
  );
  return deny(gateResult.reason ?? 'Bash command denied');
}

const FILE_TOOL_PATH_KEYS: Record<string, string> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

const FILE_TOOL_ACTION_NAMES: Record<string, string> = {
  Write: 'fs:write',
  Edit: 'fs:edit',
  MultiEdit: 'fs:multi-edit',
  NotebookEdit: 'fs:notebook-edit',
};

function matchesAnyPath(patterns: string[], value: string): boolean {
  return patterns.some((p) => globMatch(p, value));
}

/** Mirrors bash-gate.ts's checkPaths/checkScoped/checkSandboxed path logic
 * exactly (deny takes precedence; an empty allowedPaths means unrestricted)
 * — 'sandboxed' has no equivalent of its command-allowlist for a file path,
 * so both 'scoped' and 'sandboxed' reduce to the same path check here. */
function checkFileAccess(path: string, bashAccess: BashAccess): BashGateResult {
  switch (bashAccess.access) {
    case 'none':
      return { allowed: false, reason: 'File-writing tools are disabled (bash access: none)' };
    case 'full':
      return { allowed: true };
    case 'scoped':
    case 'sandboxed':
      if (bashAccess.deniedPaths.length > 0 && matchesAnyPath(bashAccess.deniedPaths, path)) {
        return { allowed: false, reason: `Path "${path}" is denied` };
      }
      if (bashAccess.allowedPaths.length > 0 && !matchesAnyPath(bashAccess.allowedPaths, path)) {
        return { allowed: false, reason: `Path "${path}" is not in the allowed paths` };
      }
      return { allowed: true };
    default:
      return { allowed: false, reason: `Unknown access level: ${String(bashAccess.access)}` };
  }
}

/** H2: Write/Edit/MultiEdit/NotebookEdit used to fall through to the
 * catch-all `allow()` — completely ungated regardless of `task.bashAccess`.
 * These are file-mutating tools exactly like Bash, so they're gated with the
 * SAME access/path semantics bash-gate.ts uses for Bash paths. */
function handleFileTool(
  deps: ToolPolicyDeps,
  task: ToolPolicyTaskContext,
  call: { toolName: string; input: Record<string, unknown> },
): PermissionResult {
  const { toolName, input } = call;
  const bashAccess = task.bashAccess ?? DEFAULT_BASH_ACCESS;
  const pathKey = FILE_TOOL_PATH_KEYS[toolName];
  const rawPath = input[pathKey];
  const path = typeof rawPath === 'string' ? rawPath : '(unresolved path)';
  const actionName = FILE_TOOL_ACTION_NAMES[toolName];
  const gateResult = checkFileAccess(path, bashAccess);
  const details = `access=${bashAccess.access} path="${path}"${gateResult.reason ? ` reason=${gateResult.reason}` : ''}`;

  deps.auditLog.insert({
    skillName: task.skillName,
    actionName,
    permissionTier: gateResult.allowed ? 'green' : 'red',
    outcome: gateResult.allowed ? 'executed' : 'denied',
    sessionId: task.sessionId,
    details,
  });

  if (gateResult.allowed) {
    log.info(`${toolName} allowed [${bashAccess.access}] path="${path}"`);
    return allow(input);
  }

  log.warn(`${toolName} denied [${bashAccess.access}] path="${path}": ${gateResult.reason}`);
  return deny(gateResult.reason ?? `${toolName} denied`);
}

function auditAction(
  deps: ToolPolicyDeps,
  task: ToolPolicyTaskContext,
  entry: { actionName: string; tier: PermissionTier; outcome: AuditOutcome; details?: string },
): void {
  deps.auditLog.insert({
    skillName: task.skillName,
    actionName: entry.actionName,
    permissionTier: entry.tier,
    outcome: entry.outcome,
    sessionId: task.sessionId,
    details: entry.details,
  });
}

function emitApprovedEvent(
  deps: ToolPolicyDeps,
  task: ToolPolicyTaskContext,
  action: { actionName: string; tier: PermissionTier },
): void {
  deps.eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: 'tool-policy',
    type: 'permission:approved',
    payload: {
      actionName: action.actionName,
      skillName: task.skillName,
      tier: action.tier,
      sessionId: task.sessionId,
    },
  });
}

function emitBlockedEvent(
  deps: ToolPolicyDeps,
  task: ToolPolicyTaskContext,
  action: { actionName: string; tier: PermissionTier; approvalId: string },
): void {
  deps.eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: 'tool-policy',
    type: 'permission:blocked',
    payload: {
      actionName: action.actionName,
      skillName: task.skillName,
      tier: action.tier,
      approvalId: action.approvalId,
      sessionId: task.sessionId,
    },
  });
}

/** Green/yellow tiers execute immediately; yellow also emits the same
 * `permission:approved` event enforcePermissionGate emits for its own
 * (task-level) yellow branch, so dashboard/audit consumers see one
 * consistent event shape regardless of which gate handled the call. */
function allowKnownTier(
  deps: ToolPolicyDeps,
  task: ToolPolicyTaskContext,
  action: { actionName: string; tier: PermissionTier; input: Record<string, unknown> },
): PermissionResult {
  auditAction(deps, task, { ...action, outcome: 'executed' });
  if (action.tier === 'yellow') {
    emitApprovedEvent(deps, task, action);
  }
  return allow(action.input);
}

const APPROVAL_ARGS_MAX_LENGTH = 500;
const SENSITIVE_KEY_PATTERN = /token|password|secret|key/i;
const REDACTED_PLACEHOLDER = '[REDACTED]';

/** M9: approvals must carry the tool's actual arguments so a post-approval
 * re-dispatch (AgentManager.executeAction's synthetic task) has them
 * available — today it only gets the actionName + this `details` string.
 * Redacts any key matching /token|password|secret|key/i (case-insensitive)
 * before serializing, and truncates to ~500 chars. */
function summarizeToolInput(input: Record<string, unknown>): string {
  try {
    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      redacted[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED_PLACEHOLDER : value;
    }
    const json = JSON.stringify(redacted);
    return json.length > APPROVAL_ARGS_MAX_LENGTH
      ? `${json.slice(0, APPROVAL_ARGS_MAX_LENGTH)}...`
      : json;
  } catch (err) {
    return `(unserializable input: ${err instanceof Error ? err.message : String(err)})`;
  }
}

function blockForApproval(
  deps: ToolPolicyDeps,
  task: ToolPolicyTaskContext,
  action: {
    actionName: string;
    tier: PermissionTier;
    server: string;
    tool: string;
    input: Record<string, unknown>;
  },
): PermissionResult {
  auditAction(deps, task, { ...action, outcome: 'queued' });

  // M8: dedup repeated attempts at the same still-blocked action within this
  // session into one pending row instead of spamming a fresh approval + a
  // fresh Telegram ping per retry.
  const existing = deps.pendingApprovals.findUnresolved(action.actionName, task.sessionId);
  const approval =
    existing ??
    deps.pendingApprovals.insert({
      actionName: action.actionName,
      skillName: task.skillName,
      details: `Blocked: ${action.actionName} (tool mcp__${action.server}__${action.tool}) args=${summarizeToolInput(action.input)}`,
      sessionId: task.sessionId,
    });

  if (!existing) {
    emitBlockedEvent(deps, task, {
      actionName: action.actionName,
      tier: action.tier,
      approvalId: approval.id,
    });
  }

  return deny(`Queued for approval (id ${approval.id}) — the owner has been asked on Telegram`);
}

function handleIntegrationMcp(
  deps: ToolPolicyDeps,
  task: ToolPolicyTaskContext,
  mcpCall: { server: string; tool: string; input: Record<string, unknown> },
): PermissionResult {
  const { server, tool, input } = mcpCall;
  const { actionName, tier } = resolveIntegrationAction(deps, server, tool);

  // Loop-closure: this exact action was just approved for this task's
  // synthetic re-dispatch (AgentManager.executeAction) — allow it
  // directly rather than re-resolving its tier and queuing it again.
  if (task.approvedActionName && task.approvedActionName === actionName) {
    auditAction(deps, task, {
      actionName,
      tier,
      outcome: 'executed',
      details: 'pre-approved re-dispatch',
    });
    return allow(input);
  }

  if (tier === 'green' || tier === 'yellow') {
    return allowKnownTier(deps, task, { actionName, tier, input });
  }

  return blockForApproval(deps, task, { actionName, tier, server, tool, input });
}

export function createToolPolicy(deps: ToolPolicyDeps, task: ToolPolicyTaskContext): CanUseTool {
  return async (toolName: string, input: Record<string, unknown>): Promise<PermissionResult> => {
    if (toolName === 'Bash') {
      return handleBash(deps, task, input);
    }

    // H2: Write/Edit/MultiEdit/NotebookEdit used to reach the catch-all
    // below and execute completely ungated — see handleFileTool's docstring.
    if (toolName in FILE_TOOL_PATH_KEYS) {
      return handleFileTool(deps, task, { toolName, input });
    }

    // Already role-scoped by mcp-server/index.ts's ScopeContext (chat/task/
    // validation/knowledge) — no additional tier gating needed.
    if (toolName.startsWith('mcp__raven__') || toolName.startsWith('mcp__memory__')) {
      return allow(input);
    }

    const mcpMatch = MCP_TOOL_NAME_PATTERN.exec(toolName);
    if (mcpMatch) {
      const [, server, tool] = mcpMatch;
      return handleIntegrationMcp(deps, task, { server, tool, input });
    }

    // Read/Glob/Grep/WebSearch/WebFetch/Agent/TodoWrite/... — everything
    // else. These are also pre-listed in agent-session.ts's allowedTools, so
    // in practice the SDK rarely routes them here; this branch exists as a
    // defensive catch-all and is exercised directly by tool-policy.test.ts.
    return allow(input);
  };
}
