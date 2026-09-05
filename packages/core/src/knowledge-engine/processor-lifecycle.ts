import { createLogger, type RavenEvent, type RavenEventType } from '@raven/shared';
import type { EventBus } from '../event-bus/event-bus.ts';

const DRAIN_TIMEOUT_MS = 1_000;

export interface ProcessorLifecycle {
  run<T>(operation: () => Promise<T>): Promise<T>;
  track<T>(work: Promise<T>): Promise<T>;
  guard<T extends object>(dependency: T): T;
  emit(event: RavenEvent): void;
  listen(type: RavenEventType, operation: (event: RavenEvent) => Promise<void>): void;
  stop(): Promise<void>;
  assertActive(): void;
  signal: AbortSignal;
}

interface ScopeState {
  eventBus: EventBus;
  name: string;
  log: ReturnType<typeof createLogger>;
  controller: AbortController;
  listeners: Array<() => void>;
  pending: Set<Promise<unknown>>;
  stopping?: Promise<void>;
}

function assertActive(state: ScopeState): void {
  if (state.controller.signal.aborted) throw new Error(`${state.name} is stopped`);
}

function track<T>(state: ScopeState, work: Promise<T>): Promise<T> {
  state.pending.add(work);
  void work.then(
    () => state.pending.delete(work),
    () => state.pending.delete(work),
  );
  return work;
}

function run<T>(state: ScopeState, operation: () => Promise<T>): Promise<T> {
  try {
    assertActive(state);
    return track(state, operation());
  } catch (err) {
    return Promise.reject(err);
  }
}

// A late continuation may finish, but cannot begin another dependency call.
function guard<T extends object>(state: ScopeState, dependency: T): T {
  return new Proxy(dependency, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]): unknown => {
        assertActive(state);
        return Reflect.apply(value, target, args);
      };
    },
  });
}

function listen(
  state: ScopeState,
  type: RavenEventType,
  operation: (event: RavenEvent) => Promise<void>,
): void {
  assertActive(state);
  const handler = (event: RavenEvent): void => {
    if (state.controller.signal.aborted) return;
    void run(state, () => operation(event)).catch((err: unknown) => {
      if (!state.controller.signal.aborted) state.log.error(`Event processing failed: ${err}`);
    });
  };
  state.listeners.push(() => state.eventBus.off(type, handler));
  state.eventBus.on(type, handler);
}

async function drain(state: ScopeState): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled([...state.pending]),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          state.log.warn(
            `Stopped accepting work; ${state.pending.size} local operations still settling`,
          );
          resolve();
        }, DRAIN_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function stop(state: ScopeState): Promise<void> {
  if (state.stopping) return state.stopping;
  state.controller.abort();
  for (const unsubscribe of state.listeners.splice(0)) {
    try {
      unsubscribe();
    } catch (err) {
      state.log.warn(`Listener cleanup failed: ${err}`);
    }
  }
  state.stopping = drain(state);
  return state.stopping;
}

/** Own local subscriptions and bounded work disposal; external model tasks are not cancelled. */
export function createProcessorLifecycle(eventBus: EventBus, name: string): ProcessorLifecycle {
  const state: ScopeState = {
    eventBus,
    name,
    log: createLogger(name),
    controller: new AbortController(),
    listeners: [],
    pending: new Set(),
  };
  return {
    run: (operation) => run(state, operation),
    track: (work) => track(state, work),
    guard: (dependency) => guard(state, dependency),
    emit: (event) => {
      assertActive(state);
      eventBus.emit(event);
    },
    listen: (type, operation) => listen(state, type, operation),
    stop: () => stop(state),
    assertActive: () => assertActive(state),
    signal: state.controller.signal,
  };
}
