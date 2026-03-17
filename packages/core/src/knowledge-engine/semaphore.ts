/** Lightweight Promise-based counting semaphore for concurrency control. */
export function createSemaphore(maxConcurrency: number): {
  acquire: <T>(fn: () => Promise<T>) => Promise<T>;
} {
  let running = 0;
  const queue: Array<() => void> = [];

  function release(): void {
    running--;
    const next = queue.shift();
    if (next) next();
  }

  async function acquire<T>(fn: () => Promise<T>): Promise<T> {
    if (running >= maxConcurrency) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    running++;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  return { acquire };
}
