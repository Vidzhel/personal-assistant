import { query } from '@anthropic-ai/claude-code';
import { createLogger, generateId } from '@raven/shared';
import type { AgentTask, McpServerConfig, PermissionTier, SubAgentDefinition } from '@raven/shared';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { PermissionEngine } from '../permission-engine/permission-engine.ts';
import type { AuditLog } from '../permission-engine/audit-log.ts';
import type { PendingApprovals } from '../permission-engine/pending-approvals.ts';
import { buildSystemPrompt } from './prompt-builder.ts';
import { getConfig } from '../config.ts';

const log = createLogger('agent-session');

export interface AgentSessionResult {
  taskId: string;
  sdkSessionId?: string;
  result: string;
  durationMs: number;
  success: boolean;
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
  const { task, eventBus, mcpServers, agentDefinitions, actionName, permissionDeps } = opts;
  const config = getConfig();
  const startTime = Date.now();

  log.info(`Starting agent task ${task.id} for skill ${task.skillName}`);

  // Permission gate: enforce before query() if deps are provided
  if (permissionDeps) {
    const gateAction = actionName ?? 'unknown:undeclared';
    const gateResult = enforcePermissionGate(
      gateAction,
      { ...permissionDeps, eventBus },
      { sessionId: task.sessionId, skillName: task.skillName },
    );

    if (!gateResult.allowed) {
      log.info(
        `Task ${task.id} blocked by permission gate (action: ${gateAction}, tier: ${gateResult.tier})`,
      );
      return {
        taskId: task.id,
        result: `Action blocked: ${gateAction} requires approval (tier: ${gateResult.tier})`,
        durationMs: Date.now() - startTime,
        success: false,
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
    // Build MCP config for the SDK - transform our config to SDK format
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

    const queryOptions: Record<string, unknown> = {
      systemPrompt,
      allowedTools,
      permissionMode: 'bypassPermissions',
      model: config.CLAUDE_MODEL,
      maxTurns: config.RAVEN_AGENT_MAX_TURNS,
      stderr: (data: string) => {
        stderrChunks.push(data);
        log.debug(`Agent stderr: ${data.trim()}`);
      },
    };

    if (Object.keys(sdkMcpServers).length > 0) {
      queryOptions.mcpServers = sdkMcpServers;
    }

    if (Object.keys(agentDefinitions).length > 0) {
      queryOptions.agents = agentDefinitions;
    }

    for await (const message of query({
      prompt: task.prompt,
      options: queryOptions as Parameters<typeof query>[0]['options'],
    })) {
      const msg = message as Record<string, unknown>;

      // Capture session ID
      if (msg.type === 'system' && msg.subtype === 'init') {
        sdkSessionId = msg.session_id as string;
      }

      // Stream assistant messages to event bus
      if (msg.type === 'assistant') {
        const content = msg.message as {
          content?: Array<{ type: string; text?: string; name?: string }>;
        };
        if (content?.content) {
          for (const block of content.content) {
            if (block.type === 'text' && block.text) {
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
                  content: block.text,
                },
              });
            }
          }
        }
      }

      // Capture final result
      if (msg.type === 'result') {
        success = msg.subtype === 'success';
        resultText = (msg.result as string) ?? '';
        if (!success) {
          errors.push(`Agent ended with status: ${msg.subtype}`);
        }
      }
    }
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
    success = false;
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
