import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve } from 'node:path';

const active = new AsyncLocalStorage<string>();
const queues = new Map<string, Promise<unknown>>();

/** Serialize complete project operations across API, scaffold, sync and Telegram callers. */
export async function withProjectMutation<T>(
  root: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = resolve(root);
  if (active.getStore() === key) return operation();
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => active.run(key, operation));
  queues.set(key, next);
  try {
    return await next;
  } finally {
    if (queues.get(key) === next) queues.delete(key);
  }
}

export class ProjectMutationError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 409) {
    super(message);
    this.name = 'ProjectMutationError';
    this.statusCode = statusCode;
  }
}
