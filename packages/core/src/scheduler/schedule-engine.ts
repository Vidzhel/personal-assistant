import { Cron } from 'croner';
import { createLogger } from '@raven/shared';
import type { ScheduleYaml, RavenTask } from '@raven/shared';
import type { JobRegistry } from './job-registry.ts';

const log = createLogger('schedule-engine');

/** The slice of the task store the engine needs. */
export interface TaskStoreLike {
  createTask(input: {
    title: string;
    source: 'scheduled';
    scheduleId: string;
    status: 'in_progress';
    prompt?: string;
  }): RavenTask;
  updateTask(
    id: string,
    patch: { status: 'completed' | 'blocked'; description?: string },
  ): RavenTask;
}

export interface RunJobDeps {
  jobRegistry: JobRegistry;
  taskStore: TaskStoreLike;
}

function markBlocked(deps: RunJobDeps, taskId: string, reason: string): void {
  deps.taskStore.updateTask(taskId, { status: 'blocked', description: reason });
}

/** Create a stamped RavenTask for one schedule fire, run its job handler, set final status. */
export async function runScheduledJob(def: ScheduleYaml, deps: RunJobDeps): Promise<void> {
  const task = deps.taskStore.createTask({
    title: def.name,
    source: 'scheduled',
    scheduleId: def.name,
    status: 'in_progress',
    prompt: `Scheduled job: ${def.run.ref}`,
  });

  const handler = deps.jobRegistry.get(def.run.ref);
  if (!handler) {
    log.error(`No job registered for "${def.run.ref}" (schedule ${def.name})`);
    markBlocked(deps, task.id, `No job handler registered: ${def.run.ref}`);
    return;
  }

  try {
    const result = await handler({ scheduleName: def.name, params: def.params ?? {} });
    deps.taskStore.updateTask(task.id, {
      status: 'completed',
      ...(result.summary !== undefined && { description: result.summary }),
    });
    log.info(`Schedule "${def.name}" completed: ${result.summary ?? 'ok'}`);
  } catch (err) {
    log.error(`Schedule "${def.name}" failed: ${String(err)}`);
    markBlocked(deps, task.id, String(err));
  }
}

export interface ScheduleEngineDeps {
  schedules: ScheduleYaml[];
  jobRegistry: JobRegistry;
  taskStore: TaskStoreLike;
  timezone: string;
}

export interface ScheduleEngine {
  start(): void;
  stop(): void;
}

function registerJobSchedule(def: ScheduleYaml, deps: RunJobDeps): Cron {
  const job = new Cron(def.cron, { timezone: def.timezone }, () => {
    runScheduledJob(def, deps).catch((err: unknown) =>
      log.error(`runScheduledJob(${def.name}) failed: ${String(err)}`),
    );
  });
  log.info(
    `Registered job schedule "${def.name}" (${def.cron}) → next ${job.nextRun()?.toISOString() ?? 'n/a'}`,
  );
  return job;
}

export function createScheduleEngine(deps: ScheduleEngineDeps): ScheduleEngine {
  const jobs: Cron[] = [];

  function start(): void {
    for (const def of deps.schedules) {
      if (def.run.kind !== 'job') {
        log.info(`Skipping schedule "${def.name}" (kind=${def.run.kind}) — handled elsewhere`);
        continue;
      }
      if (def.enabled === false) {
        log.info(`Schedule "${def.name}" disabled — not registered`);
        continue;
      }
      jobs.push(registerJobSchedule(def, { jobRegistry: deps.jobRegistry, taskStore: deps.taskStore }));
    }
    log.info(`Schedule engine started with ${jobs.length} job schedules`);
  }

  function stop(): void {
    for (const job of jobs) job.stop();
    jobs.length = 0;
    log.info('Schedule engine stopped');
  }

  return { start, stop };
}
