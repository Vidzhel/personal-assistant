import type { RavenEvent } from '@raven/shared';
import type { EventBus } from '../event-bus/event-bus.ts';

/** Dispose the local completion wait; the requested external task is not cancelled. */
export function waitForAgentTask(params: {
  eventBus: EventBus;
  taskId: string;
  timeoutMs: number;
  signal: AbortSignal;
  dispatch: () => void;
}): Promise<{ result?: string; error?: string }> {
  const { eventBus, taskId, timeoutMs, signal } = params;
  return new Promise((resolve, reject) => {
    function cleanup(): void {
      clearTimeout(timer);
      eventBus.off('agent:task:complete', handler);
      signal.removeEventListener('abort', abort);
    }
    function abort(): void {
      cleanup();
      reject(new Error('Knowledge processor stopped while awaiting agent completion'));
    }
    function handler(event: RavenEvent): void {
      if (event.type !== 'agent:task:complete' || event.payload.taskId !== taskId) return;
      cleanup();
      resolve(
        event.payload.success
          ? { result: event.payload.result }
          : { error: event.payload.errors?.join('; ') ?? 'Agent task failed' },
      );
    }
    if (signal.aborted) {
      reject(new Error('Knowledge processor is stopped'));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Knowledge agent timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    try {
      eventBus.on('agent:task:complete', handler);
      params.dispatch();
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}
