import { z } from 'zod';
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
  executeAction(params: {
    actionName: string;
    skillName: string;
    details?: string;
    sessionId?: string;
  }): Promise<{ success: boolean; result?: string; error?: string }>;
}

interface ServiceState {
  eventBus: EventBusInterface;
  taskStore?: TaskStoreLike;
  agentManager?: AgentManagerLike;
  controller: AbortController;
  activeRuns: Set<Promise<unknown>>;
  releaseJob?: () => void;
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

const TicktickTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  content: z.string().optional(),
  status: z.number(),
  projectId: z.string().optional(),
});
const TicktickTasksSchema = z.array(TicktickTaskSchema);

let currentState: ServiceState | undefined;

function awaitWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason ?? new Error('Service stopped'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

async function fetchTicktickTasks(
  agentManager: AgentManagerLike,
  signal: AbortSignal,
): Promise<TicktickTask[] | null> {
  signal.throwIfAborted();
  const fetchResult = await awaitWithAbort(
    agentManager.executeAction({
      actionName: 'ticktick:get-tasks',
      // Library skill name ('ticktick'), not the pre-library SUITE_TASK_MANAGEMENT
      // label — executeAction resolves MCP servers/sub-agents from this
      // via CapabilityLibrary.collectMcpServers, which only knows library names.
      skillName: 'ticktick',
      details: 'Fetch all TickTick tasks for sync',
    }),
    signal,
  );
  signal.throwIfAborted();

  if (!fetchResult.success || !fetchResult.result) {
    log.warn(`TickTick fetch failed: ${fetchResult.error ?? 'no result'}`);
    return null;
  }

  try {
    const parsed = TicktickTasksSchema.safeParse(JSON.parse(fetchResult.result));
    if (!parsed.success) {
      log.warn('TickTick response did not contain valid task records');
      return null;
    }
    return parsed.data;
  } catch {
    log.warn('Could not parse TickTick tasks from agent result');
    return null;
  }
}

function syncTicktickTasks(
  taskStore: TaskStoreLike,
  ticktickTasks: TicktickTask[],
  signal: AbortSignal,
): { created: number; updated: number } {
  signal.throwIfAborted();
  // Get existing synced tasks for dedup
  const existingSynced = taskStore.queryTasks({
    source: 'ticktick',
    includeArchived: true,
    limit: Number.MAX_SAFE_INTEGER,
  });
  const existingByExternalId = new Map(existingSynced.map((t) => [t.externalId, t]));

  let created = 0;
  let updated = 0;

  for (const tt of ticktickTasks) {
    signal.throwIfAborted();
    const existing = existingByExternalId.get(tt.id);
    const isCompleted = tt.status === 2;

    if (!existing) {
      // Create new synced task
      const createdTask = taskStore.createTask({
        title: tt.title,
        description: tt.content,
        status: isCompleted ? 'completed' : 'todo',
        source: 'ticktick',
        externalId: tt.id,
      });
      existingByExternalId.set(tt.id, createdTask);
      created++;
    } else if (isCompleted && existing.status !== 'completed' && existing.status !== 'archived') {
      // TickTick task was completed — sync completion
      const completed = taskStore.completeTask(existing.id);
      existingByExternalId.set(tt.id, completed);
      updated++;
    }
  }

  return { created, updated };
}

function emitSyncNotification(state: ServiceState, created: number, updated: number): void {
  if (state.controller.signal.aborted || currentState !== state) return;
  state.eventBus.emit({
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

async function runSync(state: ServiceState): Promise<boolean> {
  const { taskStore, agentManager, controller } = state;

  if (!taskStore) {
    log.warn('Task store not available — skipping sync');
    return false;
  }

  if (!agentManager) {
    log.warn('Agent manager not available — skipping sync');
    return false;
  }

  log.info('Starting TickTick sync');

  try {
    // Inbound: Fetch TickTick tasks via agent
    const ticktickTasks = await fetchTicktickTasks(agentManager, controller.signal);
    if (!ticktickTasks) return false;

    const { created, updated } = syncTicktickTasks(taskStore, ticktickTasks, controller.signal);

    log.info(`TickTick sync complete: ${created} created, ${updated} updated`);

    // Emit notification if any changes
    if (created > 0 || updated > 0) {
      emitSyncNotification(state, created, updated);
    }
    return true;
  } catch (err) {
    if (controller.signal.aborted) return false;
    log.error(`TickTick sync error: ${err}`);
    return false;
  }
}

function startRun(state: ServiceState): Promise<boolean> {
  if (state.controller.signal.aborted || currentState !== state) return Promise.resolve(false);
  const run = runSync(state);
  state.activeRuns.add(run);
  void run.then(
    () => state.activeRuns.delete(run),
    () => state.activeRuns.delete(run),
  );
  return run;
}

export const ticktickSync: RavenService = {
  async start(context: ServiceContext): Promise<void> {
    if (currentState) await ticktickSync.stop();
    const state: ServiceState = {
      eventBus: context.eventBus,
      taskStore: context.config.taskStore as TaskStoreLike | undefined,
      agentManager: context.config.agentManager as AgentManagerLike | undefined,
      controller: new AbortController(),
      activeRuns: new Set(),
    };
    state.releaseJob = context.jobRegistry.register(SYNC_SCHEDULE_NAME, async () => {
      if (state.controller.signal.aborted || currentState !== state) {
        throw new Error('TickTick sync stopped');
      }
      const completed = await startRun(state);
      if (!completed) {
        throw new Error(
          state.controller.signal.aborted ? 'TickTick sync stopped' : 'TickTick sync failed',
        );
      }
      return { summary: 'TickTick sync complete' };
    });
    currentState = state;

    log.info('TickTick sync service started — job registered');
  },

  async stop(): Promise<void> {
    const state = currentState;
    if (!state) return;
    currentState = undefined;
    state.releaseJob?.();
    state.releaseJob = undefined;
    state.controller.abort(new Error('TickTick sync stopped'));
    await Promise.allSettled([...state.activeRuns]);
    log.info('TickTick sync service stopped');
  },
};

export default ticktickSync;
