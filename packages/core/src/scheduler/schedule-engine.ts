import { Cron } from 'croner';
import { createLogger } from '@raven/shared';
import type { ScheduleYaml, RavenTask } from '@raven/shared';
import type { JobRegistry } from './job-registry.ts';
import type { SchedulePrefs } from './schedule-prefs.ts';

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
  schedulePrefs?: SchedulePrefs;
}

export interface ScheduleInfo {
  name: string;
  cron: string;
  timezone: string;
  kind: 'job' | 'template' | 'agent';
  ref: string;
  enabled: boolean;
  registered: boolean;
  nextRun: string | null;
}

export interface ScheduleEngine {
  start(): void;
  stop(): void;
  list(): ScheduleInfo[];
  setEnabled(name: string, enabled: boolean): boolean;
  runNow(name: string): Promise<boolean>;
  getActiveCount(): number;
  getUpcoming(limit: number): Array<{ name: string; scheduledAt: string; kind: string }>;
}

type EntryMap = Map<string, { def: ScheduleYaml; job: Cron | null }>;

function checkRegistered(def: ScheduleYaml, deps: ScheduleEngineDeps): boolean {
  if (def.run.kind === 'job') return deps.jobRegistry.has(def.run.ref);
  if (def.run.kind === 'template') return deps.fireTemplate !== undefined;
  return false;
}

function checkEffectiveEnabled(def: ScheduleYaml, deps: ScheduleEngineDeps): boolean {
  const override = deps.schedulePrefs?.getEnabledOverride(def.name);
  return override ?? def.enabled !== false;
}

async function fireDef(def: ScheduleYaml, deps: ScheduleEngineDeps): Promise<void> {
  if (def.run.kind === 'job') {
    await runScheduledJob(def, { jobRegistry: deps.jobRegistry, taskStore: deps.taskStore }).catch(
      (err: unknown) => log.error(`runScheduledJob(${def.name}) failed: ${String(err)}`),
    );
  } else if (def.run.kind === 'template' && deps.fireTemplate) {
    const fireTemplate = deps.fireTemplate;
    await runScheduledTemplate(def, { fireTemplate }).catch((err: unknown) =>
      log.error(`runScheduledTemplate(${def.name}) failed: ${String(err)}`),
    );
  }
}

function startEntry(name: string, entries: EntryMap, deps: ScheduleEngineDeps): void {
  const entry = entries.get(name);
  if (!entry || entry.job) return;
  if (!checkRegistered(entry.def, deps)) {
    log.warn(`Schedule "${name}" handler not registered (suite disabled?) — not scheduled`);
    return;
  }
  if (!checkEffectiveEnabled(entry.def, deps)) {
    log.info(`Schedule "${name}" disabled — not scheduled`);
    return;
  }
  entry.job = new Cron(entry.def.cron, { timezone: entry.def.timezone }, () => {
    void fireDef(entry.def, deps);
  });
  log.info(`Scheduled "${name}" (${entry.def.cron}) → next ${entry.job.nextRun()?.toISOString() ?? 'n/a'}`);
}

function stopEntry(name: string, entries: EntryMap): void {
  const entry = entries.get(name);
  if (entry?.job) {
    entry.job.stop();
    entry.job = null;
  }
}

function buildList(entries: EntryMap, deps: ScheduleEngineDeps): ScheduleInfo[] {
  return [...entries.values()].map(({ def, job }) => ({
    name: def.name,
    cron: def.cron,
    timezone: def.timezone,
    kind: def.run.kind,
    ref: def.run.ref,
    enabled: checkEffectiveEnabled(def, deps),
    registered: checkRegistered(def, deps),
    nextRun: job?.nextRun()?.toISOString() ?? null,
  }));
}

type UpcomingItem = { name: string; next: Date; kind: string };

function buildUpcoming(
  entries: EntryMap,
  limit: number,
): Array<{ name: string; scheduledAt: string; kind: string }> {
  const candidates: UpcomingItem[] = [];
  for (const { def, job } of entries.values()) {
    const next = job?.nextRun() ?? null;
    if (next !== null) candidates.push({ name: def.name, next, kind: def.run.kind });
  }
  return candidates
    .sort((a, b) => a.next.getTime() - b.next.getTime())
    .slice(0, limit)
    .map((x) => ({ name: x.name, scheduledAt: x.next.toISOString(), kind: x.kind }));
}

export function createScheduleEngine(deps: ScheduleEngineDeps): ScheduleEngine {
  const entries: EntryMap = new Map();

  return {
    start(): void {
      for (const def of deps.schedules) entries.set(def.name, { def, job: null });
      for (const name of entries.keys()) startEntry(name, entries, deps);
      const active = [...entries.values()].filter((e) => e.job).length;
      log.info(`Schedule engine started with ${active} active schedules`);
    },
    stop(): void {
      for (const name of entries.keys()) stopEntry(name, entries);
    },
    list(): ScheduleInfo[] {
      return buildList(entries, deps);
    },
    setEnabled(name: string, enabled: boolean): boolean {
      if (!entries.has(name)) return false;
      deps.schedulePrefs?.setEnabledOverride(name, enabled);
      if (enabled) startEntry(name, entries, deps);
      else stopEntry(name, entries);
      return true;
    },
    async runNow(name: string): Promise<boolean> {
      const entry = entries.get(name);
      if (!entry) return false;
      await fireDef(entry.def, deps);
      return true;
    },
    getActiveCount(): number {
      return [...entries.values()].filter((e) => e.job).length;
    },
    getUpcoming(limit: number): Array<{ name: string; scheduledAt: string; kind: string }> {
      return buildUpcoming(entries, limit);
    },
  };
}
