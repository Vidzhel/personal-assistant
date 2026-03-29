import { createLogger, generateId, buildMcpToolPattern } from '@raven/shared';
import type {
  AgentTask,
  McpServerConfig,
  PermissionTier,
  SubAgentDefinition,
  BashAccess,
} from '@raven/shared';
import { checkBashAccess } from '../bash-gate/bash-gate.ts';
import { parseCommand } from '../bash-gate/command-parser.ts';
import type { MessageStore } from '../session-manager/message-store.ts';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { PermissionEngine } from '../permission-engine/permission-engine.ts';
import type { AuditLog } from '../permission-engine/audit-log.ts';
import type { PendingApprovals } from '../permission-engine/pending-approvals.ts';
import { buildSystemPrompt } from './prompt-builder.ts';
import { getConfig, projectRoot } from '../config.ts';
import type { AgentBackend, ToolUseMeta } from './agent-backend.ts';
import { createSdkBackend } from './sdk-backend.ts';
import { createCliBackend } from './cli-backend.ts';
import { createRavenMcp, type RavenMcpDeps, type ScopeContext } from '../mcp-server/index.ts';

const log = createLogger('agent-session');

const STDERR_LOG_TAIL_LENGTH = -2000;
const STDERR_ERROR_TAIL_LENGTH = -500;

let activeBackend: AgentBackend | null = null;

export function initializeBackend(apiKey: string): void {
  activeBackend = apiKey ? createSdkBackend() : createCliBackend();
  log.info(`Agent backend: ${apiKey ? 'SDK' : 'CLI'} mode`);
}

function getActiveBackend(): AgentBackend {
  if (!activeBackend) {
    // Fallback: auto-initialize based on config if not explicitly initialized
    const config = getConfig();
    initializeBackend(config.ANTHROPIC_API_KEY);
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
  context: { sessionId?: string; skillName: string; pipelineName?: string },
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

function resolveAgentRole(task: AgentTask): ScopeContext['role'] {
  if (task.executionTaskId) return 'task';
  if (task.skillName === '_quality-reviewer' || task.skillName === '_evaluator') return 'validation';
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

  // Permission gate: enforce before query() only when actionName is explicitly provided
  if (permissionDeps && actionName) {
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
      };
    }

    // Add Raven MCP (in-process, scoped to this task)
    if (opts.ravenMcpDeps) {
      const ravenMcp = createRavenMcp(opts.ravenMcpDeps, {
        role: resolveAgentRole(task),
        projectId: task.projectId,
        sessionId: task.sessionId,
        treeId: task.treeId,
        taskId: task.executionTaskId,
      });
      sdkMcpServers['raven'] = ravenMcp;
    }

    const systemPrompt = buildSystemPrompt(task);

    // Compute allowed tools: base tools + MCP wildcards + Agent delegation
    const allowedTools = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];

    // Conditionally enable Bash tool based on agent's bash access config
    const bashAccess: BashAccess | undefined = task.bashAccess;
    if (bashAccess && bashAccess.access !== 'none') {
      allowedTools.push('Bash');
    }

    // Always include MCP wildcards — sub-agents inherit tools from the parent,
    // so the parent must have MCP tools in its allowed list for sub-agents to use them.
    for (const name of Object.keys(sdkMcpServers)) {
      allowedTools.push(buildMcpToolPattern(name));
    }
    if (opts.ravenMcpDeps) {
      allowedTools.push('mcp__raven__*');
    }
    const hasSubAgents = Object.keys(agentDefinitions).length > 0;
    if (hasSubAgents) {
      allowedTools.push('Agent');
    }

    const prompt = task.prompt;

    // Track Agent tool_use IDs → sub-agent type for attribution
    const agentToolMap = new Map<string, string>();

    function resolveAgentName(meta?: ToolUseMeta): string | undefined {
      if (!meta?.parentToolUseId) return undefined;
      return agentToolMap.get(meta.parentToolUseId);
    }

    const backend = getActiveBackend();
    const backendResult = await backend({
      prompt,
      systemPrompt,
      allowedTools,
      model: config.CLAUDE_MODEL,
      maxTurns: config.RAVEN_AGENT_MAX_TURNS,
      mcpServers: sdkMcpServers,
      agents: agentDefinitions,
      plugins: opts.plugins,
      onAssistantMessage: (text: string, meta?: ToolUseMeta) => {
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
            sessionId: sdkSessionId,
            messageType: 'assistant',
            content: text,
            messageId,
            agentName,
          },
        });
      },
      // eslint-disable-next-line complexity, max-lines-per-function -- tool routing with sub-agent tracking, bash audit, and event dispatch
      onToolUse: (toolName: string, toolInput: string, meta?: ToolUseMeta) => {
        // Track Agent tool invocations for sub-agent attribution
        if (toolName === 'Agent' && !meta?.parentToolUseId && meta?.toolUseId) {
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

        // Audit Bash commands (observational — SDK already executed the command)
        if (toolName === 'Bash' && bashAccess) {
          try {
            const input = JSON.parse(toolInput) as Record<string, unknown>;
            const command = (input.command as string) ?? '';
            if (command) {
              const chain = parseCommand(command);
              const gateResult = checkBashAccess(command, bashAccess);
              const level = gateResult.allowed ? 'info' : 'warn';
              log[level](
                `Bash audit [${bashAccess.access}] task=${task.id}: ${gateResult.allowed ? 'OK' : 'VIOLATION'} cmd="${chain.allBinaries.join(' | ')}"${gateResult.reason ? ` reason=${gateResult.reason}` : ''}`,
              );
              if (permissionDeps) {
                permissionDeps.auditLog.insert({
                  skillName: task.skillName,
                  actionName: `bash:${chain.allBinaries[0] ?? 'unknown'}`,
                  permissionTier: gateResult.allowed ? 'green' : 'red',
                  outcome: gateResult.allowed ? 'executed' : 'executed',
                  sessionId: task.sessionId,
                  // eslint-disable-next-line @typescript-eslint/no-magic-numbers -- reasonable truncation limit for audit log
                  details: `access=${bashAccess.access} cmd="${command.slice(0, 200)}"${gateResult.reason ? ` reason=${gateResult.reason}` : ''}`,
                });
              }
            }
          } catch {
            // toolInput may be truncated — ignore parse errors
          }
        }

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
            sessionId: sdkSessionId,
            messageType: 'tool_use',
            content: `${toolName}: ${toolInput}`,
            messageId,
            agentName,
          },
        });
      },
      onToolResult: (result) => {
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
        if (task.sessionId && messageStore) {
          messageStore.appendRawMessage(task.sessionId, rawJson);
        }
      },
      signal,
      onStderr: (data: string) => {
        stderrChunks.push(data);
        log.debug(`Agent stderr: ${data.trim()}`);
      },
      cwd: projectRoot,
    });

    sdkSessionId = backendResult.sessionId;
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
    errors.push(errMsg);
    if (stderrOutput) {
      errors.push(`stderr: ${stderrOutput.slice(STDERR_ERROR_TAIL_LENGTH)}`);
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
