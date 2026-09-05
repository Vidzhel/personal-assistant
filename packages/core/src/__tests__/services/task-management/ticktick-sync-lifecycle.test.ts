import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJobRegistry } from '../../../scheduler/job-registry.ts';
import { ticktickSync } from '../../../services/task-management/ticktick-sync.ts';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('ticktick sync service lifetime', () => {
  let eventBus: { emit: ReturnType<typeof vi.fn> };
  let taskStore: {
    createTask: ReturnType<typeof vi.fn>;
    completeTask: ReturnType<typeof vi.fn>;
    queryTasks: ReturnType<typeof vi.fn>;
  };
  let agentManager: { executeAction: ReturnType<typeof vi.fn> };
  let registry: ReturnType<typeof createJobRegistry>;

  beforeEach(() => {
    eventBus = { emit: vi.fn() };
    taskStore = {
      createTask: vi.fn((input) => ({
        id: 'local-1',
        externalId: input.externalId,
        status: input.status,
      })),
      completeTask: vi.fn((id) => ({
        id,
        externalId: 'remote-1',
        status: 'completed',
      })),
      queryTasks: vi.fn(() => []),
    };
    agentManager = { executeAction: vi.fn() };
    registry = createJobRegistry();
  });

  afterEach(async () => {
    await ticktickSync.stop();
  });

  async function start(): Promise<ReturnType<typeof registry.get>> {
    await ticktickSync.start({
      eventBus,
      jobRegistry: registry,
      config: { taskStore, agentManager },
    } as never);
    return registry.get('ticktick-task-sync');
  }

  it('does not write when the fetched array contains an invalid record', async () => {
    agentManager.executeAction.mockResolvedValue({
      success: true,
      result: JSON.stringify([
        { id: 'remote-1', title: 'Valid', status: 0, projectId: 'remote-project' },
        { id: 'remote-2', title: '', status: 0 },
      ]),
    });
    const job = await start();

    await expect(job!({ scheduleName: 'ticktick-task-sync', params: {} })).rejects.toThrow(
      'TickTick sync failed',
    );
    expect(taskStore.createTask).not.toHaveBeenCalled();
  });

  it('keeps remote project ids out of Raven task ownership', async () => {
    agentManager.executeAction.mockResolvedValue({
      success: true,
      result: JSON.stringify([
        { id: 'remote-1', title: 'Valid', status: 0, projectId: 'remote-project' },
      ]),
    });
    const job = await start();

    await job!({ scheduleName: 'ticktick-task-sync', params: {} });

    expect(taskStore.createTask).toHaveBeenCalledWith({
      title: 'Valid',
      description: undefined,
      status: 'todo',
      source: 'ticktick',
      externalId: 'remote-1',
    });
  });

  it('deduplicates duplicate remote records in one response', async () => {
    agentManager.executeAction.mockResolvedValue({
      success: true,
      result: JSON.stringify([
        { id: 'remote-1', title: 'Valid', status: 0 },
        { id: 'remote-1', title: 'Valid again', status: 2 },
        { id: 'remote-1', title: 'Valid once more', status: 2 },
      ]),
    });
    const job = await start();

    await job!({ scheduleName: 'ticktick-task-sync', params: {} });

    expect(taskStore.createTask).toHaveBeenCalledTimes(1);
    expect(taskStore.completeTask).toHaveBeenCalledWith('local-1');
  });

  it('loads the complete local history before matching remote ids', async () => {
    const records = Array.from({ length: 1001 }, (_, index) => ({
      id: `local-${index}`,
      externalId: `remote-${index}`,
      status: 'todo',
    }));
    taskStore.queryTasks.mockImplementation((filters: { limit?: number }) =>
      records.slice(0, filters.limit ?? 50),
    );
    agentManager.executeAction.mockResolvedValue({
      success: true,
      result: JSON.stringify([{ id: 'remote-1000', title: 'Already synced', status: 0 }]),
    });
    const job = await start();

    await job!({ scheduleName: 'ticktick-task-sync', params: {} });

    expect(taskStore.queryTasks).toHaveBeenCalledWith({
      source: 'ticktick',
      includeArchived: true,
      limit: Number.MAX_SAFE_INTEGER,
    });
    expect(taskStore.createTask).not.toHaveBeenCalled();
  });

  it('releases the job and suppresses a late fetch after stop and restart', async () => {
    const pending = deferred<unknown>();
    agentManager.executeAction.mockReturnValueOnce(pending.promise);
    const oldJob = await start();
    const oldRun = oldJob!({ scheduleName: 'ticktick-task-sync', params: {} });

    await ticktickSync.stop();
    expect(registry.has('ticktick-task-sync')).toBe(false);
    await start();

    pending.resolve({
      success: true,
      result: JSON.stringify([{ id: 'remote-1', title: 'Late', status: 0 }]),
    });
    await expect(oldRun).rejects.toThrow('TickTick sync stopped');
    expect(taskStore.createTask).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('observes a late fetch rejection after cancellation', async () => {
    const pending = deferred<unknown>();
    agentManager.executeAction.mockReturnValueOnce(pending.promise);
    const job = await start();
    const run = job!({ scheduleName: 'ticktick-task-sync', params: {} });

    await ticktickSync.stop();
    pending.reject(new Error('late provider failure'));
    await expect(run).rejects.toThrow('TickTick sync stopped');
    expect(taskStore.createTask).not.toHaveBeenCalled();
  });
});
