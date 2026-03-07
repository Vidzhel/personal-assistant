import { createLogger, generateId } from '@raven/shared';
import type { AgentTask, McpServerConfig, PermissionTier, SubAgentDefinition } from '@raven/shared';
import type { MessageStore } from '../session-manager/message-store.ts';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { PermissionEngine } from '../permission-engine/permission-engine.ts';
import type { AuditLog } from '../permission-engine/audit-log.ts';
import type { PendingApprovals } from '../permission-engine/pending-approvals.ts';
import { buildSystemPrompt } from './prompt-builder.ts';
import { getConfig } from '../config.ts';
import type { AgentBackend } from './agent-backend.ts';
import { createSdkBackend } from './sdk-backend.ts';
import { createCliBackend } from './cli-backend.ts';

const log = createLogger('agent-session');

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
  actionName?: string;
  permissionDeps?: PermissionDeps;
  messageStore?: MessageStore;
}

export interface GateResult {
  allowed: boolean;
  tier: PermissionTier;
  reason?: string;
}

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

/**
 * Runs a single agent task using Claude Agent SDK query().
 * This is the core execution unit - each call spawns a fresh agent
 * with only the MCPs needed for this specific task.
 */
export async function runAgentTask(opts: RunOptions): Promise<AgentSessionResult> {
  const { task, eventBus, mcpServers, agentDefinitions, actionName, permissionDeps, messageStore } =
    opts;
  const config = getConfig();
  const startTime = Date.now();

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
    const sdkMcpServers: Record<
      string,
      { command: string; args: string[]; env?: Record<string, string> }
    > = {};
    for (const [name, cfg] of Object.entries(mcpServers)) {
      sdkMcpServers[name] = {
        command: cfg.command,
        args: cfg.args,
        env: cfg.env,
      };
    }

    const systemPrompt = buildSystemPrompt(task);

    // Compute allowed tools: base tools + all MCP tool wildcards
    const allowedTools = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];
    for (const name of Object.keys(sdkMcpServers)) {
      allowedTools.push(`mcp__${name}__*`);
    }

    // If there are sub-agent definitions, allow Task tool
    if (Object.keys(agentDefinitions).length > 0) {
      allowedTools.push('Task');
    }

    const backend = getActiveBackend();
    const backendResult = await backend({
      prompt: task.prompt,
      systemPrompt,
      allowedTools,
      model: config.CLAUDE_MODEL,
      maxTurns: config.RAVEN_AGENT_MAX_TURNS,
      mcpServers: sdkMcpServers,
      agents: agentDefinitions,
      onAssistantMessage: (text: string) => {
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
          },
        });
      },
      onToolUse: (toolName: string, toolInput: string) => {
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
          },
        });
        if (task.sessionId && messageStore) {
          messageStore.appendMessage(task.sessionId, {
            role: 'action',
            content: `${toolName}: ${toolInput}`,
            taskId: task.id,
            toolName,
            toolSummary: toolInput,
          });
        }
      },
      onStderr: (data: string) => {
        stderrChunks.push(data);
        log.debug(`Agent stderr: ${data.trim()}`);
      },
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
      log.error(`Agent stderr output: ${stderrOutput.slice(-2000)}`);
    }
    errors.push(errMsg);
    if (stderrOutput) {
      errors.push(`stderr: ${stderrOutput.slice(-500)}`);
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
