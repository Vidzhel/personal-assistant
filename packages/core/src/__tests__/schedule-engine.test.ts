import { describe, it, expect, vi } from 'vitest';
import { runScheduledJob } from '../scheduler/schedule-engine.ts';
import { createJobRegistry } from '../scheduler/job-registry.ts';
import type { ScheduleYaml } from '@raven/shared';

function fakeTaskStore() {
  const calls: Array<{ kind: string; arg: any }> = [];
  return {
    calls,
    createTask: vi.fn((input: any) => {
      calls.push({ kind: 'create', arg: input });
      return { id: 'task-1', ...input };
    }),
    updateTask: vi.fn((id: string, patch: any) => {
      calls.push({ kind: 'update', arg: { id, patch } });
      return { id, ...patch };
    }),
  };
}

const jobDef: ScheduleYaml = {
  name: 'task-archival',
  cron: '0 * * * *',
  timezone: 'UTC',
  enabled: true,
  params: {},
  run: { kind: 'job', ref: 'task-archival' },
};

describe('runScheduledJob', () => {
  it('creates a scheduled task, runs the handler, marks it completed', async () => {
    const reg = createJobRegistry();
    reg.register('task-archival', async () => ({ summary: 'archived 3' }));
    const taskStore = fakeTaskStore();

    await runScheduledJob(jobDef, { jobRegistry: reg, taskStore: taskStore as any });

    const create = taskStore.calls.find((c) => c.kind === 'create');
    expect(create?.arg.source).toBe('scheduled');
    expect(create?.arg.scheduleId).toBe('task-archival');
    expect(create?.arg.status).toBe('in_progress');

    const update = taskStore.calls.find((c) => c.kind === 'update');
    expect(update?.arg.patch.status).toBe('completed');
  });

  it('marks the task blocked when the handler throws', async () => {
    const reg = createJobRegistry();
    reg.register('task-archival', async () => {
      throw new Error('boom');
    });
    const taskStore = fakeTaskStore();

    await runScheduledJob(jobDef, { jobRegistry: reg, taskStore: taskStore as any });

    const update = taskStore.calls.find((c) => c.kind === 'update');
    expect(update?.arg.patch.status).toBe('blocked');
  });

  it('marks the task blocked when no handler is registered', async () => {
    const taskStore = fakeTaskStore();
    await runScheduledJob(jobDef, {
      jobRegistry: createJobRegistry(),
      taskStore: taskStore as any,
    });
    const update = taskStore.calls.find((c) => c.kind === 'update');
    expect(update?.arg.patch.status).toBe('blocked');
  });
});
