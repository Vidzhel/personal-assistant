import {
  generateId,
  createLogger,
  SUITE_TASK_MANAGEMENT,
  type EventBusInterface,
  type RavenTask,
} from '@raven/shared';
import type { ServiceContext, RavenService } from '../types.ts';

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
  queryTasks(filters: { source?: string; includeArchived?: boolean; limit?: number }): RavenTask[];
}

interface TicktickTask {
  id: string;
  title: string;
  content?: string;
  status: number;
  projectId?: string;
}

let eventBus: EventBusInterface | null = null;

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

async function fetchTicktickTasks(agentManager: AgentManagerLike): Promise<TicktickTask[] | null> {
  const fetchResult = await agentManager.executeApprovedAction({
    actionName: 'ticktick:get-tasks',
    // Library skill name ('ticktick'), not the pre-library SUITE_TASK_MANAGEMENT
    // label — executeApprovedAction resolves MCP servers/sub-agents from this
    // via CapabilityLibrary.collectMcpServers, which only knows library names.
    skillName: 'ticktick',
    details: 'Fetch all TickTick tasks for sync',
  });

  if (!fetchResult.success || !fetchResult.result) {
    log.warn(`TickTick fetch failed: ${fetchResult.error ?? 'no result'}`);
    return null;
  }

  try {
    return JSON.parse(fetchResult.result) as TicktickTask[];
  } catch {
    log.warn('Could not parse TickTick tasks from agent result');
    return null;
  }
}

function syncTicktickTasks(
  taskStore: TaskStoreLike,
  ticktickTasks: TicktickTask[],
): { created: number; updated: number } {
  // Get existing synced tasks for dedup
  const existingSynced = taskStore.queryTasks({
    source: 'ticktick',
    includeArchived: true,
    limit: 1000,
  });
  const existingByExternalId = new Map(existingSynced.map((t) => [t.externalId, t]));

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

  return { created, updated };
}

function emitSyncNotification(created: number, updated: number): void {
  if (!eventBus) return;
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
    const ticktickTasks = await fetchTicktickTasks(agentManager);
    if (!ticktickTasks) return;

    const { created, updated } = syncTicktickTasks(taskStore, ticktickTasks);

    log.info(`TickTick sync complete: ${created} created, ${updated} updated`);

    // Emit notification if any changes
    if (created > 0 || updated > 0) {
      emitSyncNotification(created, updated);
    }
  } catch (err) {
    log.error(`TickTick sync error: ${err}`);
  }
}

export const ticktickSync: RavenService = {
  async start(context: ServiceContext): Promise<void> {
    eventBus = context.eventBus;
    context.jobRegistry.register(SYNC_SCHEDULE_NAME, async () => {
      await runSync();
      return { summary: 'TickTick sync complete' };
    });

    log.info('TickTick sync service started — job registered');
  },

  async stop(): Promise<void> {
    eventBus = null;
    log.info('TickTick sync service stopped');
  },
};

export default ticktickSync;
