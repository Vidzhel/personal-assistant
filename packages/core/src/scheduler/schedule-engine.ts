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

export type FireTemplate = (
  ref: string,
  options: { scheduleId: string; params?: Record<string, unknown> },
) => string | Promise<string>;

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

export interface RunTemplateDeps {
  fireTemplate: FireTemplate;
}

/** Fire a template-kind schedule. The resulting tree is the board-visible, scheduleId-stamped item. */
export async function runScheduledTemplate(def: ScheduleYaml, deps: RunTemplateDeps): Promise<void> {
  try {
    const treeId = await deps.fireTemplate(def.run.ref, {
      scheduleId: def.name,
      params: def.params ?? {},
    });
    log.info(`Schedule "${def.name}" fired template "${def.run.ref}" → tree ${treeId}`);
  } catch (err) {
    log.error(`Schedule "${def.name}" template fire failed: ${String(err)}`);
  }
}

export interface ScheduleEngineDeps {
  schedules: ScheduleYaml[];
  jobRegistry: JobRegistry;
  taskStore: TaskStoreLike;
  timezone: string;
  fireTemplate?: FireTemplate;
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

function registerTemplateSchedule(def: ScheduleYaml, fireTemplate: FireTemplate): Cron {
  const job = new Cron(def.cron, { timezone: def.timezone }, () => {
    runScheduledTemplate(def, { fireTemplate }).catch((err: unknown) =>
      log.error(`runScheduledTemplate(${def.name}) failed: ${String(err)}`),
    );
  });
  log.info(
    `Registered template schedule "${def.name}" (${def.cron}) → next ${job.nextRun()?.toISOString() ?? 'n/a'}`,
  );
  return job;
}

function registerScheduleDef(def: ScheduleYaml, deps: ScheduleEngineDeps): Cron | null {
  if (def.enabled === false) {
    log.info(`Schedule "${def.name}" disabled — not registered`);
    return null;
  }
  if (def.run.kind === 'job') {
    return registerJobSchedule(def, { jobRegistry: deps.jobRegistry, taskStore: deps.taskStore });
  }
  if (def.run.kind === 'template') {
    if (!deps.fireTemplate) {
      log.warn(`Schedule "${def.name}" is template-kind but no fireTemplate dep — skipping`);
      return null;
    }
    return registerTemplateSchedule(def, deps.fireTemplate);
  }
  log.info(`Skipping schedule "${def.name}" (kind=${def.run.kind}) — unrecognised kind`);
  return null;
}

export function createScheduleEngine(deps: ScheduleEngineDeps): ScheduleEngine {
  const jobs: Cron[] = [];

  function start(): void {
    for (const def of deps.schedules) {
      const job = registerScheduleDef(def, deps);
      if (job) jobs.push(job);
    }
    log.info(`Schedule engine started with ${jobs.length} schedules`);
  }

  function stop(): void {
    for (const job of jobs) job.stop();
    jobs.length = 0;
    log.info('Schedule engine stopped');
  }

  return { start, stop };
}
