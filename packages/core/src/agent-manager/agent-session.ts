import { createLogger, generateId } from '@raven/shared';
import type { AgentTask, McpServerConfig, PermissionTier, SubAgentDefinition } from '@raven/shared';
import type { MessageStore, StoredMessage } from '../session-manager/message-store.ts';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { PermissionEngine } from '../permission-engine/permission-engine.ts';
import type { AuditLog } from '../permission-engine/audit-log.ts';
import type { PendingApprovals } from '../permission-engine/pending-approvals.ts';
import { buildSystemPrompt } from './prompt-builder.ts';
import { getConfig } from '../config.ts';
import type { AgentBackend, ToolUseMeta } from './agent-backend.ts';
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

const MAX_HISTORY_MESSAGES = 50;

function formatConversationHistory(messages: StoredMessage[], currentPrompt: string): string {
  const history = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-MAX_HISTORY_MESSAGES);
  // Last user message IS the current prompt (already appended by orchestrator), strip it
  const prior = history.slice(0, -1);
  if (prior.length === 0) return currentPrompt;

  const transcript = prior
    .map((m) => `[${m.role === 'user' ? 'User' : 'Assistant'}]: ${m.content}`)
    .join('\n\n');

  return `<conversation-history>\n${transcript}\n</conversation-history>\n\n[User]: ${currentPrompt}`;
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

    // Compute allowed tools: base tools + MCP wildcards OR Agent delegation
    const allowedTools = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];
    const hasSubAgents = Object.keys(agentDefinitions).length > 0;
    if (hasSubAgents) {
      // Orchestrator delegates to sub-agents — no direct MCP access
      allowedTools.push('Agent');
    } else {
      // Leaf agent — direct MCP tool access
      for (const name of Object.keys(sdkMcpServers)) {
        allowedTools.push(`mcp__${name}__*`);
      }
    }

    let prompt = task.prompt;
    if (task.sessionId && messageStore) {
      const history = messageStore.getMessages(task.sessionId);
      prompt = formatConversationHistory(history, task.prompt);
    }

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
