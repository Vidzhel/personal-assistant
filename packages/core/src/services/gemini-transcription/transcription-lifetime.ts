import type { EventBusInterface, RavenEvent } from '@raven/shared';

export interface TranscriptionRequest {
  signal: AbortSignal;
  wait<T>(operation: () => Promise<T>): Promise<T>;
  delay(ms: number): Promise<void>;
}

export interface TranscriptionLifetime {
  run(
    timeoutMs: number,
    operation: (request: TranscriptionRequest) => Promise<void>,
  ): Promise<void>;
  isActive(): boolean;
  emit(event: RavenEvent): void;
  stop(): Promise<void>;
}

interface LifetimeState {
  stopped: boolean;
  controllers: Set<AbortController>;
  pending: Set<Promise<void>>;
}

async function waitForRequest<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    const result = await Promise.race([operation(), cancelled]);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

async function delayForRequest(signal: AbortSignal, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await waitForRequest(
      signal,
      () =>
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ms);
        }),
    );
  } finally {
    clearTimeout(timer);
  }
}

function runRequest(
  state: LifetimeState,
  timeoutMs: number,
  operation: (request: TranscriptionRequest) => Promise<void>,
): Promise<void> {
  if (state.stopped) return Promise.resolve();
  const controller = new AbortController();
  state.controllers.add(controller);
  const timer = setTimeout(
    () => controller.abort(new DOMException('Transcription timed out', 'AbortError')),
    timeoutMs,
  );
  const work = Promise.resolve().then(async () => {
    try {
      controller.signal.throwIfAborted();
      await operation({
        signal: controller.signal,
        wait: (next) => waitForRequest(controller.signal, next),
        delay: (ms) => delayForRequest(controller.signal, ms),
      });
    } finally {
      clearTimeout(timer);
      state.controllers.delete(controller);
    }
  });
  state.pending.add(work);
  void work.then(
    () => state.pending.delete(work),
    () => state.pending.delete(work),
  );
  return work;
}

/** One service start owns its requests, deadlines and all observable output. */
export function createTranscriptionLifetime(bus: EventBusInterface): TranscriptionLifetime {
  const state: LifetimeState = { stopped: false, controllers: new Set(), pending: new Set() };
  return {
    run: (timeoutMs: number, operation: (request: TranscriptionRequest) => Promise<void>) =>
      runRequest(state, timeoutMs, operation),
    isActive: () => !state.stopped,
    emit: (event: RavenEvent): void => {
      if (!state.stopped) bus.emit(event);
    },
    stop: (): Promise<void> => {
      state.stopped = true;
      for (const controller of state.controllers) controller.abort();
      return Promise.allSettled([...state.pending]).then(() => {});
    },
  };
}
