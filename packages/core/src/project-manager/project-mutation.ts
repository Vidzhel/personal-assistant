import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve } from 'node:path';

const active = new AsyncLocalStorage<string>();
const queues = new Map<string, Promise<unknown>>();

/** Synchronous record writes must not race an asynchronous project move or reload. */
export function assertProjectMutationAllowed(root: string): void {
  if (queues.has(resolve(root))) {
    throw new ProjectMutationError('Project definitions are being updated; retry the task change');
  }
}

/** Wait for a definition mutation, then run a synchronous record transition. */
export async function runAfterProjectMutations<T>(root: string, operation: () => T): Promise<T> {
  const key = resolve(root);
  while (queues.has(key)) {
    await (queues.get(key) ?? Promise.resolve()).catch(() => undefined);
  }
  return operation();
}

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
