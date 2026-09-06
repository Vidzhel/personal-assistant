import type * as RavenShared from '@raven/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJobRegistry } from '../../../scheduler/job-registry.ts';
import {
  buildActionPrompt,
  buildAnalysisPrompt,
  parseRecommendations,
} from '../../../services/task-management/autonomous-manager.ts';

vi.mock('@raven/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof RavenShared>();
  return {
    ...actual,
    generateId: vi.fn(() => 'test-id'),
    createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  };
});

import service from '../../../services/task-management/autonomous-manager.ts';

interface ActionCall {
  actionName: string;
  skillName: string;
  details: string;
}

interface ActionResult {
  success: boolean;
  result?: string;
  error?: string;
}

interface EmittedEvent {
  type: string;
  payload: Record<string, unknown>;
}

const PROJECTS = [{ id: 'p1', name: 'Work' }];
const TASK = { id: 't1', projectId: 'p1', title: 'Prepare report', priority: 1 };
const RECOMMENDATION = {
  action: 'update-task' as const,
  taskId: 't1',
  projectId: 'p1',
  taskTitle: 'Prepare report',
  reason: 'Raise priority',
  confidence: 'high' as const,
  changes: { priority: 5 },
};

function projectEnvelope(): string {
  return JSON.stringify({ projects: PROJECTS, complete: true, nextCursor: null });
}

function taskEnvelope(tasks: unknown[] = []): string {
  return JSON.stringify({ tasks, complete: true, nextCursor: null });
}

describe('autonomous-manager service', () => {
  const handlers = new Map<string, (event: unknown) => Promise<void>>();
  const emitted: EmittedEvent[] = [];
  const executeAction = vi.fn<(params: ActionCall) => Promise<ActionResult>>();
  let jobRegistry: ReturnType<typeof createJobRegistry>;

  beforeEach(() => {
    handlers.clear();
    emitted.length = 0;
    executeAction.mockReset();
    jobRegistry = createJobRegistry();
  });

  afterEach(async () => {
    await service.stop();
  });

  async function start(
    agentManager: { executeAction: typeof executeAction } | null = { executeAction },
  ): Promise<void> {
    const eventBus = {
      emit: vi.fn((event: EmittedEvent) => emitted.push(event)),
      on: vi.fn((type: string, handler: (event: unknown) => Promise<void>) =>
        handlers.set(type, handler),
      ),
      off: vi.fn((type: string) => handlers.delete(type)),
    };
    await service.start({
      eventBus,
      jobRegistry,
      config: { agentManager: agentManager ?? undefined },
    } as never);
  }

  async function run(): Promise<void> {
    const job = jobRegistry.get('autonomous-task-management');
    await job?.({ scheduleName: 'autonomous-task-management', params: {} });
  }

  function mockCompleteCoverage(tasks: unknown[] = []): void {
    executeAction.mockImplementation(async (call) => {
      if (call.actionName === 'ticktick:list-projects') {
        return { success: true, result: projectEnvelope() };
      }
      if (call.actionName === 'ticktick:get-project-with-undone-tasks') {
        return { success: true, result: taskEnvelope(tasks) };
      }
      return { success: true, result: taskEnvelope() };
    });
  }

  it('registers and releases the manual job and event listener', async () => {
    await start();
    expect(jobRegistry.has('autonomous-task-management')).toBe(true);
    expect(handlers.has('task-management:manage-request')).toBe(true);
    await service.stop();
    expect(jobRegistry.has('autonomous-task-management')).toBe(false);
    expect(handlers.has('task-management:manage-request')).toBe(false);
  });

  it('uses every required official workload scope and no removed alias', async () => {
    mockCompleteCoverage();
    await start();
    await run();

    const calls = executeAction.mock.calls.map(([call]) => call);
    expect(calls.map((call) => call.actionName)).toEqual([
      'ticktick:list-projects',
      'ticktick:get-project-with-undone-tasks',
      'ticktick:list-undone-tasks-by-date',
      'ticktick:filter-tasks',
      'ticktick:filter-tasks',
      'ticktick:filter-tasks',
    ]);
    expect(JSON.stringify(calls)).not.toContain('get_all_tasks');
    expect(JSON.stringify(calls)).not.toContain('ticktick:get-tasks');
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: 'task-management:autonomous:completed',
        payload: expect.objectContaining({ executedCount: 0 }),
      }),
    );
  });

  it('makes partial coverage visible and blocks analysis and mutation', async () => {
    executeAction.mockImplementation(async (call) => {
      if (call.actionName === 'ticktick:list-projects') {
        return { success: true, result: projectEnvelope() };
      }
      if (call.actionName === 'ticktick:get-project-with-undone-tasks') {
        return { success: false, error: 'project unavailable' };
      }
      return { success: true, result: taskEnvelope() };
    });
    await start();

    await expect(run()).rejects.toThrow('Autonomous task management failed');
    expect(
      executeAction.mock.calls.some(([call]) => call.details.startsWith('You are analyzing')),
    ).toBe(false);
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: 'task-management:autonomous:failed',
        payload: expect.objectContaining({ error: expect.stringContaining('partial') }),
      }),
    );
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: 'notification',
        payload: expect.objectContaining({ title: 'TickTick coverage incomplete' }),
      }),
    );
  });

  it('analyzes an observed snapshot then performs an official verified mutation', async () => {
    executeAction.mockImplementation(async (call) => {
      if (call.actionName === 'ticktick:list-projects') {
        return { success: true, result: projectEnvelope() };
      }
      if (call.actionName === 'ticktick:get-project-with-undone-tasks') {
        return { success: true, result: taskEnvelope([TASK]) };
      }
      if (call.details.startsWith('You are analyzing')) {
        return { success: true, result: JSON.stringify([RECOMMENDATION]) };
      }
      if (call.actionName === 'ticktick:update-task') {
        return {
          success: true,
          result: JSON.stringify({
            operation: 'update-task',
            outcome: 'verified',
            taskId: 't1',
            projectId: 'p1',
          }),
        };
      }
      return { success: true, result: taskEnvelope() };
    });
    await start();
    await run();

    const mutation = executeAction.mock.calls
      .map(([call]) => call)
      .find((call) => call.actionName === 'ticktick:update-task');
    expect(mutation?.details).toContain('get_task_by_id');
    expect(mutation?.details).toContain('Action: update-task');
    expect(mutation?.details).toContain('Read the task back');
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: 'task-management:autonomous:completed',
        payload: expect.objectContaining({ executedCount: 1, failedCount: 0 }),
      }),
    );
  });

  it('does not count generic SDK success as verified TickTick mutation evidence', async () => {
    executeAction.mockImplementation(async (call) => {
      if (call.actionName === 'ticktick:list-projects') {
        return { success: true, result: projectEnvelope() };
      }
      if (call.actionName === 'ticktick:get-project-with-undone-tasks') {
        return { success: true, result: taskEnvelope([TASK]) };
      }
      if (call.details.startsWith('You are analyzing')) {
        return { success: true, result: JSON.stringify([RECOMMENDATION]) };
      }
      if (call.actionName === 'ticktick:update-task') return { success: true };
      return { success: true, result: taskEnvelope() };
    });
    await start();
    await expect(run()).rejects.toThrow('Autonomous task management failed');
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: 'task-management:autonomous:completed',
        payload: expect.objectContaining({ executedCount: 0, failedCount: 1 }),
      }),
    );
  });

  it('rejects recommendations outside the observed snapshot before any mutation', async () => {
    const invented = { ...RECOMMENDATION, taskId: 'other' };
    executeAction.mockImplementation(async (call) => {
      if (call.actionName === 'ticktick:list-projects') {
        return { success: true, result: projectEnvelope() };
      }
      if (call.actionName === 'ticktick:get-project-with-undone-tasks') {
        return { success: true, result: taskEnvelope([TASK]) };
      }
      if (call.details.startsWith('You are analyzing')) {
        return { success: true, result: JSON.stringify([invented]) };
      }
      return { success: true, result: taskEnvelope() };
    });
    await start();
    await expect(run()).rejects.toThrow('Autonomous task management failed');
    expect(
      executeAction.mock.calls.some(([call]) => call.actionName === 'ticktick:update-task'),
    ).toBe(false);
  });

  it('manual requests use the same official coverage workflow', async () => {
    mockCompleteCoverage();
    await start();
    await handlers.get('task-management:manage-request')?.({ payload: { source: 'api' } });
    expect(executeAction).toHaveBeenCalledWith(
      expect.objectContaining({ actionName: 'ticktick:list-projects' }),
    );
  });

  it('fails without an agent manager instead of claiming an empty workload', async () => {
    await start(null);
    await expect(run()).rejects.toThrow('Autonomous task management failed');
    expect(emitted).toHaveLength(0);
  });
});

describe('autonomous task prompts', () => {
  it('rejects mixed-validity or duplicate recommendation arrays', () => {
    expect(parseRecommendations(JSON.stringify([RECOMMENDATION, { bad: true }]))).toBeNull();
    expect(parseRecommendations(JSON.stringify([RECOMMENDATION, RECOMMENDATION]))).toBeNull();
  });

  it('does not describe the supplied snapshot as the complete account', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-05T22:30:00.000Z'));
    const prompt = buildAnalysisPrompt('{"tasks":[]}', 'Europe/Kyiv');
    vi.useRealTimers();
    expect(prompt).toContain('bounded TickTick workload snapshot');
    expect(prompt).toContain('Current date: 2026-09-06');
    expect(prompt).toContain('Do not claim this snapshot proves the whole account is complete');
  });

  it('requires exact lookup, one mutation, read-back, and uncertain-outcome handling', () => {
    const prompt = buildActionPrompt(RECOMMENDATION);
    expect(prompt).toContain('get_task_by_id');
    expect(prompt).toContain('official mutation tool exactly once');
    expect(prompt).toContain('do not blindly retry');
    expect(prompt).toContain('Report success only after the requested final state is verified');
  });
});
