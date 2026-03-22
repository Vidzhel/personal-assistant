import {
  generateId,
  createLogger,
  SUITE_TASK_MANAGEMENT,
  type EventBusInterface,
  type DatabaseInterface,
  type RavenTask,
  type ScheduleTriggeredEvent,
} from '@raven/shared';
import type { ServiceContext, SuiteService } from '@raven/core/suite-registry/service-runner.ts';

const log = createLogger('ticktick-sync');

const SYNC_SCHEDULE_NAME = 'ticktick-task-sync';

interface AgentManagerLike {
  executeApprovedAction(params: {
    actionName: string;
    skillName: string;
    details?: string;
    sessionId?: string;
  }): Promise<{ success: boolean; result?: string; error?: string }>;
}

interface TaskStoreLike {
  createTask(input: {
    title: string;
    description?: string;
    status?: string;
    source: string;
    externalId: string;
    projectId?: string;
  }): RavenTask;
  completeTask(id: string, artifacts?: string[]): RavenTask;
  queryTasks(filters: {
    source?: string;
    includeArchived?: boolean;
    limit?: number;
  }): RavenTask[];
}

let eventBus: EventBusInterface | null = null;
let db: DatabaseInterface | null = null;
let scheduleHandler: ((event: unknown) => void) | null = null;

function getTaskStore(): TaskStoreLike | null {
  try {
    const mod = globalThis as unknown as { __raven_task_store__?: TaskStoreLike };
    return mod.__raven_task_store__ ?? null;
  } catch {
    return null;
  }
}

function getAgentManager(): AgentManagerLike | null {
  try {
    const mod = globalThis as unknown as { __raven_agent_manager__?: AgentManagerLike };
    return mod.__raven_agent_manager__ ?? null;
  } catch {
    return null;
  }
}

// eslint-disable-next-line max-lines-per-function -- service lifecycle with inbound/outbound sync
async function runSync(): Promise<void> {
  const taskStore = getTaskStore();
  const agentManager = getAgentManager();

  if (!taskStore) {
    log.warn('Task store not available — skipping sync');
    return;
  }

  if (!agentManager) {
    log.warn('Agent manager not available — skipping sync');
    return;
  }

  log.info('Starting TickTick sync');

  try {
    // Inbound: Fetch TickTick tasks via agent
    const fetchResult = await agentManager.executeApprovedAction({
      actionName: 'ticktick:get-tasks',
      skillName: SUITE_TASK_MANAGEMENT,
      details: 'Fetch all TickTick tasks for sync',
    });

    if (!fetchResult.success || !fetchResult.result) {
      log.warn(`TickTick fetch failed: ${fetchResult.error ?? 'no result'}`);
      return;
    }

    // Parse agent result for task data
    let ticktickTasks: Array<{
      id: string;
      title: string;
      content?: string;
      status: number;
      projectId?: string;
    }>;

    try {
      ticktickTasks = JSON.parse(fetchResult.result) as typeof ticktickTasks;
    } catch {
      log.warn('Could not parse TickTick tasks from agent result');
      return;
    }

    // Get existing synced tasks for dedup
    const existingSynced = taskStore.queryTasks({
      source: 'ticktick',
      includeArchived: true,
      limit: 1000,
    });
    const existingByExternalId = new Map(
      existingSynced.map((t) => [t.externalId, t]),
    );

    let created = 0;
    let updated = 0;

    for (const tt of ticktickTasks) {
      const existing = existingByExternalId.get(tt.id);
      const isCompleted = tt.status === 2;

      if (!existing) {
        // Create new synced task
        taskStore.createTask({
          title: tt.title,
          description: tt.content,
          status: isCompleted ? 'completed' : 'todo',
          source: 'ticktick',
          externalId: tt.id,
          projectId: tt.projectId,
        });
        created++;
      } else if (isCompleted && existing.status !== 'completed' && existing.status !== 'archived') {
        // TickTick task was completed — sync completion
        taskStore.completeTask(existing.id);
        updated++;
      }
    }

    log.info(`TickTick sync complete: ${created} created, ${updated} updated`);

    // Emit notification if any changes
    if ((created > 0 || updated > 0) && eventBus) {
      eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: SUITE_TASK_MANAGEMENT,
        type: 'notification',
        payload: {
          channel: 'telegram' as const,
          title: 'TickTick Sync',
          body: `Synced ${created} new, ${updated} updated tasks from TickTick`,
          topicName: 'Tasks',
        },
      });
    }
  } catch (err) {
    log.error(`TickTick sync error: ${err}`);
  }
}

export const ticktickSync: SuiteService = {
  async start(context: ServiceContext): Promise<void> {
    eventBus = context.eventBus;
    db = context.db;

    scheduleHandler = (event: unknown): void => {
      const e = event as ScheduleTriggeredEvent;
      if (e.payload.scheduleName === SYNC_SCHEDULE_NAME) {
        void runSync();
      }
    };

    eventBus.on('schedule:triggered', scheduleHandler);
    log.info('TickTick sync service started — listening for schedule triggers');
  },

  async stop(): Promise<void> {
    if (eventBus && scheduleHandler) {
      eventBus.off('schedule:triggered', scheduleHandler);
    }
    eventBus = null;
    db = null;
    scheduleHandler = null;
    log.info('TickTick sync service stopped');
  },
};

export default ticktickSync;
