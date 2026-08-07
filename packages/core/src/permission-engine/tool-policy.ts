import { createLogger, generateId } from '@raven/shared';
import type { AuditOutcome, BashAccess, PermissionTier } from '@raven/shared';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { checkBashAccess } from '../bash-gate/bash-gate.ts';
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
 */

export interface ToolPolicyTaskContext {
  skillName: string;
  sessionId?: string;
  bashAccess?: BashAccess;
  /** See AgentTask.approvedActionName (packages/shared/src/types/agents.ts).
   * When a resolved action name equals this, the policy allows it directly
   * instead of re-resolving its tier — closes the approve -> re-run loop for
   * AgentManager.executeApprovedAction's synthetic task. */
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

function allow(): PermissionResult {
  return { behavior: 'allow' };
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
    return allow();
  }

  log.warn(
    `Bash denied [${bashAccess.access}] cmd="${chain.allBinaries.join(' | ')}": ${gateResult.reason}`,
  );
  return deny(gateResult.reason ?? 'Bash command denied');
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
  action: { actionName: string; tier: PermissionTier },
): PermissionResult {
  auditAction(deps, task, { ...action, outcome: 'executed' });
  if (action.tier === 'yellow') {
    emitApprovedEvent(deps, task, action);
  }
  return allow();
}

function blockForApproval(
  deps: ToolPolicyDeps,
  task: ToolPolicyTaskContext,
  action: { actionName: string; tier: PermissionTier; server: string; tool: string },
): PermissionResult {
  auditAction(deps, task, { ...action, outcome: 'queued' });
  const approval = deps.pendingApprovals.insert({
    actionName: action.actionName,
    skillName: task.skillName,
    details: `Blocked: ${action.actionName} (tool mcp__${action.server}__${action.tool})`,
    sessionId: task.sessionId,
  });
  emitBlockedEvent(deps, task, {
    actionName: action.actionName,
    tier: action.tier,
    approvalId: approval.id,
  });
  return deny(`Queued for approval (id ${approval.id}) — the owner has been asked on Telegram`);
}

function handleIntegrationMcp(
  deps: ToolPolicyDeps,
  task: ToolPolicyTaskContext,
  mcpCall: { server: string; tool: string },
): PermissionResult {
  const { server, tool } = mcpCall;
  const { actionName, tier } = resolveIntegrationAction(deps, server, tool);

  // Loop-closure: this exact action was just approved for this task's
  // synthetic re-dispatch (AgentManager.executeApprovedAction) — allow it
  // directly rather than re-resolving its tier and queuing it again.
  if (task.approvedActionName && task.approvedActionName === actionName) {
    auditAction(deps, task, {
      actionName,
      tier,
      outcome: 'executed',
      details: 'pre-approved re-dispatch',
    });
    return allow();
  }

  if (tier === 'green' || tier === 'yellow') {
    return allowKnownTier(deps, task, { actionName, tier });
  }

  return blockForApproval(deps, task, { actionName, tier, server, tool });
}

export function createToolPolicy(deps: ToolPolicyDeps, task: ToolPolicyTaskContext): CanUseTool {
  return async (toolName: string, input: Record<string, unknown>): Promise<PermissionResult> => {
    if (toolName === 'Bash') {
      return handleBash(deps, task, input);
    }

    // Already role-scoped by mcp-server/index.ts's ScopeContext (chat/task/
    // validation/knowledge) — no additional tier gating needed.
    if (toolName.startsWith('mcp__raven__') || toolName.startsWith('mcp__memory__')) {
      return allow();
    }

    const mcpMatch = MCP_TOOL_NAME_PATTERN.exec(toolName);
    if (mcpMatch) {
      const [, server, tool] = mcpMatch;
      return handleIntegrationMcp(deps, task, { server, tool });
    }

    // Read/Glob/Grep/WebSearch/WebFetch/Agent/TodoWrite/... — everything
    // else. These are also pre-listed in agent-session.ts's allowedTools, so
    // in practice the SDK rarely routes them here; this branch exists as a
    // defensive catch-all and is exercised directly by tool-policy.test.ts.
    return allow();
  };
}
