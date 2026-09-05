import { Cron } from 'croner';
import { createLogger, generateId } from '@raven/shared';
import type { ScheduleYaml, RavenTask } from '@raven/shared';
import type { JobRegistry } from './job-registry.ts';
import type { SchedulePrefs } from './schedule-prefs.ts';
import type { ScheduleFireLog } from './schedule-fire-log.ts';

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
  /** Optional so existing unit tests that construct RunJobDeps by hand keep
   * working unchanged — see self-test.ts for the reader side. */
  scheduleFireLog?: ScheduleFireLog;
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
    deps.scheduleFireLog?.record(def.name, 'blocked', { detail: 'No job handler registered' });
    return;
  }

  try {
    const result = await handler({ scheduleName: def.name, params: def.params ?? {} });
    deps.taskStore.updateTask(task.id, {
      status: 'completed',
      ...(result.summary !== undefined && { description: result.summary }),
    });
    log.info(`Schedule "${def.name}" completed: ${result.summary ?? 'ok'}`);
    deps.scheduleFireLog?.record(def.name, 'completed', { detail: result.summary });
  } catch (err) {
    log.error(`Schedule "${def.name}" failed: ${String(err)}`);
    markBlocked(deps, task.id, String(err));
    deps.scheduleFireLog?.record(def.name, 'blocked', { detail: String(err) });
  }
}

export interface RunTemplateDeps {
  fireTemplate: FireTemplate;
  scheduleFireLog?: ScheduleFireLog;
}

/** Fire a template-kind schedule. The resulting tree is the board-visible, scheduleId-stamped item. */
export async function runScheduledTemplate(
  def: ScheduleYaml,
  deps: RunTemplateDeps,
): Promise<void> {
  try {
    const treeId = await deps.fireTemplate(def.run.ref, {
      scheduleId: def.name,
      params: def.params ?? {},
    });
    log.info(`Schedule "${def.name}" fired template "${def.run.ref}" → tree ${treeId}`);
    deps.scheduleFireLog?.record(def.name, 'fired', { detail: treeId });
  } catch (err) {
    log.error(`Schedule "${def.name}" template fire failed: ${String(err)}`);
    deps.scheduleFireLog?.record(def.name, 'failed', { detail: String(err) });
  }
}

/** Ambient check-in dispatch — see services/system/heartbeat.ts. Returns a
 * short summary (e.g. "HEARTBEAT_OK (swallowed)" or "notified owner") for
 * the fire log; the handler itself owns the silence-contract decision of
 * whether a notification actually went out. */
export type FireHeartbeat = () => Promise<{ summary: string }>;

export interface RunHeartbeatDeps {
  fireHeartbeat: FireHeartbeat;
  scheduleFireLog?: ScheduleFireLog;
}

/** Fire a heartbeat-kind schedule. Unlike job/template, this never touches
 * the task board — an ambient check-in is not owner-visible work, only its
 * (rare) notification is. */
export async function runScheduledHeartbeat(
  def: ScheduleYaml,
  deps: RunHeartbeatDeps,
): Promise<void> {
  try {
    const result = await deps.fireHeartbeat();
    log.info(`Schedule "${def.name}" heartbeat: ${result.summary}`);
    deps.scheduleFireLog?.record(def.name, 'completed', { detail: result.summary });
  } catch (err) {
    log.error(`Schedule "${def.name}" heartbeat failed: ${String(err)}`);
    deps.scheduleFireLog?.record(def.name, 'failed', { detail: String(err) });
  }
}

export interface ScheduleEngineDeps {
  schedules: ScheduleYaml[];
  jobRegistry: JobRegistry;
  taskStore: TaskStoreLike;
  timezone: string;
  fireTemplate?: FireTemplate;
  fireHeartbeat?: FireHeartbeat;
  schedulePrefs?: SchedulePrefs;
  scheduleFireLog?: ScheduleFireLog;
  /** Test seam for deterministic schedule-health timestamps. */
  now?: () => number;
}

export interface ScheduleInfo {
  name: string;
  cron: string;
  timezone: string;
  kind: 'job' | 'template' | 'agent' | 'heartbeat';
  ref: string;
  enabled: boolean;
  registered: boolean;
  nextRun: string | null;
}

export interface ScheduleHealth extends ScheduleInfo {
  active: boolean;
  activatedAt: number | null;
  activationId: string | null;
  inFlightSince: number | null;
}

export interface ScheduleEngine {
  start(): void;
  /** Stops every cron job, then awaits any fireDef() calls already in
   * flight (cron-triggered fires are fire-and-forget, so without this a
   * shutdown could tear down the DB/event bus out from under a fire that's
   * still mid-flight). */
  stop(): Promise<void>;
  list(): ScheduleInfo[];
  getHealth(): ScheduleHealth[];
  setEnabled(name: string, enabled: boolean): boolean;
  runNow(name: string): Promise<boolean>;
  getActiveCount(): number;
  getUpcoming(limit: number): Array<{ name: string; scheduledAt: string; kind: string }>;
  /** Full stop/rebuild/restart against a fresh schedule list — the cheapest
   * correct resync after a scaffolded schedule changes the definitions on
   * disk. jobRegistry/taskStore/schedulePrefs/scheduleFireLog are untouched,
   * so fire-log history and enabled-overrides survive the reload. */
  reload(schedules: ScheduleYaml[]): void;
}

interface ScheduleEntry {
  def: ScheduleYaml;
  job: Cron | null;
  activatedAt: number | null;
  activationId: string | null;
  signature: string;
}

type EntryMap = Map<string, ScheduleEntry>;

/** entries + inFlight are created together and threaded through together —
 * bundled into one param so startEntry (which needs both, plus name and
 * deps) stays under the max-params guardrail. */
interface EngineState {
  entries: EntryMap;
  inFlight: Map<
    Promise<void>,
    { name: string; startedAt: number; signature: string; activationId: string | null }
  >;
  overrides: Map<string, boolean>;
  admissionOpen: boolean;
  stopPromise?: Promise<void>;
}

function checkRegistered(def: ScheduleYaml, deps: ScheduleEngineDeps): boolean {
  if (def.run.kind === 'job') return deps.jobRegistry.has(def.run.ref);
  if (def.run.kind === 'template') return deps.fireTemplate !== undefined;
  if (def.run.kind === 'heartbeat') return deps.fireHeartbeat !== undefined;
  return false;
}

function checkEffectiveEnabled(
  def: ScheduleYaml,
  deps: ScheduleEngineDeps,
  overrides?: Map<string, boolean>,
): boolean {
  const inMemoryOverride = overrides?.get(def.name);
  if (inMemoryOverride !== undefined) return inMemoryOverride;
  const override = deps.schedulePrefs?.getEnabledOverride(def.name);
  return override ?? def.enabled !== false;
}

function scheduleSignature(def: ScheduleYaml, enabled: boolean): string {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, canonicalize(nested)]),
      );
    }
    return value;
  };

  return JSON.stringify({
    cron: def.cron,
    timezone: def.timezone,
    enabled,
    params: canonicalize(def.params ?? null),
    run: canonicalize(def.run),
  });
}

async function fireDef(def: ScheduleYaml, deps: ScheduleEngineDeps): Promise<void> {
  if (def.run.kind === 'job') {
    await runScheduledJob(def, {
      jobRegistry: deps.jobRegistry,
      taskStore: deps.taskStore,
      scheduleFireLog: deps.scheduleFireLog,
    }).catch((err: unknown) => log.error(`runScheduledJob(${def.name}) failed: ${String(err)}`));
    return;
  }
  if (def.run.kind === 'template' && deps.fireTemplate) {
    const fireTemplate = deps.fireTemplate;
    await runScheduledTemplate(def, {
      fireTemplate,
      scheduleFireLog: deps.scheduleFireLog,
    }).catch((err: unknown) =>
      log.error(`runScheduledTemplate(${def.name}) failed: ${String(err)}`),
    );
    return;
  }
  if (def.run.kind === 'heartbeat' && deps.fireHeartbeat) {
    const fireHeartbeat = deps.fireHeartbeat;
    await runScheduledHeartbeat(def, {
      fireHeartbeat,
      scheduleFireLog: deps.scheduleFireLog,
    }).catch((err: unknown) =>
      log.error(`runScheduledHeartbeat(${def.name}) failed: ${String(err)}`),
    );
    return;
  }

  // No branch matched: a template-kind schedule with no fireTemplate
  // handler configured, a heartbeat-kind schedule with no fireHeartbeat
  // handler configured, or a run.kind (e.g. 'agent') nothing here handles
  // yet. Previously this fell through silently — runNow() has no
  // registration gate, so calling it on such a schedule did nothing and
  // reported success. Log it and leave a durable 'blocked' fire record so
  // self-test's checkScheduleFires can see it too.
  const reason =
    def.run.kind === 'template'
      ? `Schedule "${def.name}" is template-kind but no fireTemplate handler is configured`
      : def.run.kind === 'heartbeat'
        ? `Schedule "${def.name}" is heartbeat-kind but no fireHeartbeat handler is configured`
        : `Schedule "${def.name}" has unsupported run.kind "${def.run.kind}" — nothing fired`;
  log.error(reason);
  deps.scheduleFireLog?.record(def.name, 'blocked', { detail: reason });
}

/** Fires def and tracks the resulting promise in `inFlight` for the
 * duration of the call, so stop() can await anything already running when
 * it's invoked instead of abandoning it mid-flight. */
function trackedFire(
  entry: ScheduleEntry,
  deps: ScheduleEngineDeps,
  state: EngineState,
): Promise<void> {
  if (!state.admissionOpen) return Promise.resolve();

  const signature = entry.signature;
  const activationId = entry.activationId;
  const promiseState = {
    name: entry.def.name,
    startedAt: (deps.now ?? Date.now)(),
    signature,
    activationId,
  };
  const fireLog = deps.scheduleFireLog;
  const invocationDeps: ScheduleEngineDeps = fireLog
    ? {
        ...deps,
        scheduleFireLog: {
          record: (name, status, details) =>
            fireLog.record(name, status, { ...details, activationId }),
        },
      }
    : deps;
  // Admission is recorded before yielding to the microtask that starts the
  // handler. This makes synchronous task creation visible to health checks.
  const promise = Promise.resolve()
    .then(() => fireDef(entry.def, invocationDeps))
    .catch((err: unknown) => {
      log.error(`Schedule "${entry.def.name}" fire failed: ${String(err)}`);
    });
  const trackedPromise = promise.finally(() => state.inFlight.delete(trackedPromise));
  state.inFlight.set(trackedPromise, promiseState);
  return trackedPromise;
}

function startEntry(name: string, state: EngineState, deps: ScheduleEngineDeps): void {
  const { entries } = state;
  const entry = entries.get(name);
  if (!entry || entry.job || !canStartEntry(name, entry, { state, deps })) return;
  // F1 defense-in-depth: croner throws SYNCHRONOUSLY on a bad cron pattern
  // (at construction) or bad IANA timezone (as soon as it computes the
  // first run, which happens here too since a callback is supplied). The
  // write path (scaffolding-api.ts's createSchedule) already validates
  // before anything hits disk, but a schedule file can still reach this
  // point some other way (hand-edited YAML, a future write path, a stale
  // file from before that guard existed) — resync() calls startEntry for
  // every schedule in one unguarded loop, so one bad entry throwing here
  // would previously abort every schedule iterated after it. Catching here
  // means the bad entry is logged and left unscheduled (entry.job stays
  // null) while every other schedule starts normally.
  try {
    entry.job = new Cron(entry.def.cron, { timezone: entry.def.timezone }, () =>
      trackedFire(entry, deps, state),
    );
    entry.activatedAt ??= (deps.now ?? Date.now)();
    entry.activationId ??= generateId();
    log.info(
      `Scheduled "${name}" (${entry.def.cron}) → next ${entry.job.nextRun()?.toISOString() ?? 'n/a'}`,
    );
  } catch (err) {
    entry.job = null;
    log.error(
      `Schedule "${name}" has an invalid cron ("${entry.def.cron}") or timezone ("${entry.def.timezone}") — skipping: ${String(err)}`,
    );
  }
}

function canStartEntry(name: string, entry: ScheduleEntry, context: EngineContext): boolean {
  const { state, deps } = context;
  if (!state.admissionOpen) return false;
  if (!checkRegistered(entry.def, deps)) {
    log.warn(`Schedule "${name}" handler not registered (suite disabled?) — not scheduled`);
    return false;
  }
  if (!checkEffectiveEnabled(entry.def, deps, state.overrides)) {
    log.info(`Schedule "${name}" disabled — not scheduled`);
    return false;
  }
  return true;
}

function stopEntry(name: string, entries: EntryMap, clearActivation = false): void {
  const entry = entries.get(name);
  if (entry?.job) {
    entry.job.stop();
    entry.job = null;
  }
  if (clearActivation && entry) entry.activatedAt = null;
  if (clearActivation && entry) entry.activationId = null;
}

function buildList(
  entries: EntryMap,
  deps: ScheduleEngineDeps,
  overrides: Map<string, boolean>,
): ScheduleInfo[] {
  return [...entries.values()].map(({ def, job }) => ({
    name: def.name,
    cron: def.cron,
    timezone: def.timezone,
    kind: def.run.kind,
    ref: def.run.ref,
    enabled: checkEffectiveEnabled(def, deps, overrides),
    registered: checkRegistered(def, deps),
    nextRun: job?.nextRun()?.toISOString() ?? null,
  }));
}

function buildHealth(state: EngineState, deps: ScheduleEngineDeps): ScheduleHealth[] {
  const inFlightSince = new Map<string, number>();
  for (const { name, startedAt, signature, activationId } of state.inFlight.values()) {
    const current = state.entries.get(name);
    if (current?.signature !== signature || current.activationId !== activationId) continue;
    const currentSince = inFlightSince.get(name);
    if (currentSince === undefined || startedAt < currentSince) {
      inFlightSince.set(name, startedAt);
    }
  }

  return [...state.entries.values()].map(({ def, job, activatedAt, activationId }) => ({
    name: def.name,
    cron: def.cron,
    timezone: def.timezone,
    kind: def.run.kind,
    ref: def.run.ref,
    enabled: checkEffectiveEnabled(def, deps, state.overrides),
    registered: checkRegistered(def, deps),
    nextRun: job?.nextRun()?.toISOString() ?? null,
    active: job !== null,
    activatedAt,
    activationId,
    inFlightSince: inFlightSince.get(def.name) ?? null,
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

/** Stop every running cron, rebuild `entries` from `deps.schedules`, and
 * start whichever ones are registered + enabled. Shared by start() (initial
 * boot) and reload() (a scaffolded schedule changed the definitions) — both
 * are "throw away and rebuild," which is simpler and safer than diffing
 * added/removed/changed schedules for what is, in practice, a handful of
 * cron jobs. */
function resync(state: EngineState, deps: ScheduleEngineDeps): number {
  const { entries } = state;
  const previous = new Map(entries);
  for (const name of entries.keys()) stopEntry(name, entries);
  entries.clear();
  for (const def of deps.schedules) {
    const enabled = checkEffectiveEnabled(def, deps, state.overrides);
    const signature = scheduleSignature(def, enabled);
    const old = previous.get(def.name);
    entries.set(def.name, {
      def,
      job: null,
      activatedAt: old?.signature === signature ? old.activatedAt : null,
      activationId: old?.signature === signature ? old.activationId : null,
      signature,
    });
  }
  if (state.admissionOpen) {
    for (const name of entries.keys()) startEntry(name, state, deps);
  }
  return [...entries.values()].filter((e) => e.job).length;
}

async function stopEngine(state: EngineState): Promise<void> {
  state.admissionOpen = false;
  for (const name of state.entries.keys()) stopEntry(name, state.entries, true);
  if (state.inFlight.size > 0) {
    log.info(`Schedule engine stop: awaiting ${String(state.inFlight.size)} in-flight fire(s)`);
    await Promise.allSettled([...state.inFlight.keys()]);
  }
}

function requestStop(state: EngineState): Promise<void> {
  if (state.stopPromise) return state.stopPromise;
  const draining = stopEngine(state);
  state.stopPromise = draining.finally(() => {
    state.stopPromise = undefined;
  });
  return state.stopPromise;
}

interface EngineContext {
  state: EngineState;
  deps: ScheduleEngineDeps;
}

function setEntryEnabled(name: string, enabled: boolean, context: EngineContext): boolean {
  const { state, deps } = context;
  const entry = state.entries.get(name);
  if (!entry) return false;
  const previous = checkEffectiveEnabled(entry.def, deps, state.overrides);
  deps.schedulePrefs?.setEnabledOverride(name, enabled);
  state.overrides.set(name, enabled);
  entry.signature = scheduleSignature(entry.def, enabled);
  if (enabled) {
    if (!previous) entry.activatedAt = null;
    if (state.admissionOpen) startEntry(name, state, deps);
  } else stopEntry(name, state.entries, true);
  return true;
}

export function createScheduleEngine(deps: ScheduleEngineDeps): ScheduleEngine {
  const state: EngineState = {
    entries: new Map(),
    inFlight: new Map(),
    overrides: new Map(),
    admissionOpen: false,
  };

  return {
    start(): void {
      if (state.admissionOpen || state.stopPromise) return;
      state.admissionOpen = true;
      const active = resync(state, deps);
      log.info(`Schedule engine started with ${active} active schedules`);
    },
    reload(schedules: ScheduleYaml[]): void {
      deps.schedules = schedules;
      const active = resync(state, deps);
      log.info(`Schedule engine reloaded with ${active} active schedules`);
    },
    stop: () => requestStop(state),
    list(): ScheduleInfo[] {
      return buildList(state.entries, deps, state.overrides);
    },
    getHealth(): ScheduleHealth[] {
      return buildHealth(state, deps);
    },
    setEnabled: (name, enabled) => setEntryEnabled(name, enabled, { state, deps }),
    async runNow(name: string): Promise<boolean> {
      const entry = state.entries.get(name);
      if (!entry || !state.admissionOpen) return false;
      await trackedFire(entry, deps, state);
      return true;
    },
    getActiveCount(): number {
      return [...state.entries.values()].filter((e) => e.job).length;
    },
    getUpcoming(limit: number): Array<{ name: string; scheduledAt: string; kind: string }> {
      return buildUpcoming(state.entries, limit);
    },
  };
}
