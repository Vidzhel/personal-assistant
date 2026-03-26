import {
  createLogger,
  type EventBusInterface,
  type AgentTaskCompleteEvent,
  type AgentTaskRequestEvent,
} from '@raven/shared';
import type { TaskStore } from './task-store.ts';

const log = createLogger('task-lifecycle');

export interface TaskLifecycle {
  start: () => void;
  stop: () => void;
}

// eslint-disable-next-line max-lines-per-function -- factory with start/stop handlers and event subscription logic
export function createTaskLifecycle(deps: {
  eventBus: EventBusInterface;
  taskStore: TaskStore;
}): TaskLifecycle {
  const { eventBus, taskStore } = deps;

  // Maps agent task IDs to RavenTask IDs for precise completion linkage
  const agentToRavenTask = new Map<string, string>();
  let requestHandler: ((event: unknown) => void) | null = null;
  let completeHandler: ((event: unknown) => void) | null = null;

  function extractArtifacts(result: string): string[] {
    const artifacts: string[] = [];
    const fileMatches = result.match(/(?:\/[\w./-]+\.\w+)/g);
    if (fileMatches) {
      for (const match of fileMatches) {
        if (!artifacts.includes(match)) artifacts.push(match);
      }
    }
    return artifacts;
  }

  return {
    start(): void {
      // Track agent task → RavenTask mapping when agent tasks are requested
      requestHandler = (event: unknown): void => {
        const e = event as AgentTaskRequestEvent;
        try {
          const inProgressTasks = taskStore.queryTasks({
            status: 'in_progress',
            assignedAgentId: e.payload.skillName,
            limit: 1,
          });

          if (inProgressTasks.length > 0) {
            agentToRavenTask.set(e.payload.taskId, inProgressTasks[0].id);
            log.info(`Mapped agent task ${e.payload.taskId} → RavenTask ${inProgressTasks[0].id}`);
          }
        } catch (err) {
          log.error(`Task lifecycle mapping error: ${err}`);
        }
      };

      completeHandler = (event: unknown): void => {
        const e = event as AgentTaskCompleteEvent;
        if (!e.payload.success) return;

        try {
          const ravenTaskId = agentToRavenTask.get(e.payload.taskId);
          if (ravenTaskId) {
            agentToRavenTask.delete(e.payload.taskId);
            const task = taskStore.getTask(ravenTaskId);
            if (task && task.status === 'in_progress') {
              const artifacts = extractArtifacts(e.payload.result ?? '');
              taskStore.completeTask(ravenTaskId, artifacts);
              log.info(
                `Auto-completed task ${ravenTaskId} from agent:task:complete ${e.payload.taskId}`,
              );
            }
          }
        } catch (err) {
          log.error(`Task lifecycle error: ${err}`);
        }
      };

      eventBus.on('agent:task:request', requestHandler);
      eventBus.on('agent:task:complete', completeHandler);
      log.info('Task lifecycle bridge started');
    },

    stop(): void {
      if (requestHandler) {
        eventBus.off('agent:task:request', requestHandler);
        requestHandler = null;
      }
      if (completeHandler) {
        eventBus.off('agent:task:complete', completeHandler);
        completeHandler = null;
      }
      agentToRavenTask.clear();
      log.info('Task lifecycle bridge stopped');
    },
  };
}
