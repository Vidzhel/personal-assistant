import { createLogger, generateId } from '@raven/shared';
import type { AgentTask, AgentTaskRequestEvent } from '@raven/shared';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { McpManager } from '../mcp-manager/mcp-manager.ts';
import type { SkillRegistry } from '../skill-registry/skill-registry.ts';
import { runAgentTask } from './agent-session.ts';
import { getConfig } from '../config.ts';

const log = createLogger('agent-manager');

/**
 * AgentManager owns the task queue and agent concurrency.
 * It listens for agent:task:request events and runs them using Claude Agent SDK.
 *
 * CRITICAL: The agent manager NEVER gives MCPs to the main orchestrator agent.
 * MCPs are only attached to sub-agents that are skill-specific.
 */
export class AgentManager {
  private queue: AgentTask[] = [];
  private running = new Map<string, Promise<void>>();
  private maxConcurrent: number;

  constructor(
    private eventBus: EventBus,
    private mcpManager: McpManager,
    private skillRegistry: SkillRegistry,
  ) {
    this.maxConcurrent = getConfig().RAVEN_MAX_CONCURRENT_AGENTS;

    this.eventBus.on<AgentTaskRequestEvent>('agent:task:request', (event) => {
      this.enqueue(event.payload);
    });
  }

  private enqueue(payload: AgentTaskRequestEvent['payload']): void {
    const task: AgentTask = {
      id: payload.taskId,
      sessionId: payload.sessionId,
      projectId: payload.projectId,
      skillName: payload.skillName,
      prompt: payload.prompt,
      status: 'queued',
      priority: payload.priority,
      mcpServers: payload.mcpServers,
      agentDefinitions: payload.agentDefinitions ?? {},
      createdAt: Date.now(),
    };

    // Insert by priority
    const priorityOrder = { urgent: 0, high: 1, normal: 2, low: 3 };
    const idx = this.queue.findIndex(
      (t) => priorityOrder[t.priority] > priorityOrder[task.priority],
    );
    if (idx === -1) {
      this.queue.push(task);
    } else {
      this.queue.splice(idx, 0, task);
    }

    log.info(`Task queued: ${task.id} (${task.skillName}, priority: ${task.priority})`);
    this.processQueue();
  }

  private processQueue(): void {
    while (this.running.size < this.maxConcurrent && this.queue.length > 0) {
      const task = this.queue.shift();
      if (!task) break;
      const promise = this.runTask(task).finally(() => {
        this.running.delete(task.id);
        this.processQueue();
      });
      this.running.set(task.id, promise);
    }
  }

  private async runTask(task: AgentTask): Promise<void> {
    task.status = 'running';
    task.startedAt = Date.now();

    this.eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'agent-manager',
      projectId: task.projectId,
      type: 'agent:message',
      payload: {
        taskId: task.id,
        messageType: 'thinking',
        content: `Starting ${task.skillName} agent...`,
      },
    });

    const result = await runAgentTask({
      task,
      eventBus: this.eventBus,
      mcpServers: task.mcpServers,
      agentDefinitions: task.agentDefinitions,
    });

    task.status = result.success ? 'completed' : 'failed';
    task.result = result.result;
    task.durationMs = result.durationMs;
    task.errors = result.errors;
    task.completedAt = Date.now();

    this.eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'agent-manager',
      projectId: task.projectId,
      type: 'agent:task:complete',
      payload: {
        taskId: task.id,
        sessionId: result.sdkSessionId,
        result: result.result,
        durationMs: result.durationMs,
        success: result.success,
        errors: result.errors,
      },
    });

    log.info(
      `Task completed: ${task.id} (${result.success ? 'success' : 'failed'}, ${result.durationMs}ms)`,
    );
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  getRunningCount(): number {
    return this.running.size;
  }
}
