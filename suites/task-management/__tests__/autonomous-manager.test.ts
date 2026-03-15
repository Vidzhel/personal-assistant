import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseRecommendations,
  buildAnalysisPrompt,
  handleScheduleTrigger,
  handleManageRequest,
} from '../services/autonomous-manager.ts';

vi.mock('@raven/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@raven/shared')>();
  return {
    ...actual,
    generateId: vi.fn(() => 'test-uuid-1234'),
    createLogger: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  };
});

vi.mock('@raven/core/suite-registry/service-runner.ts', () => ({}));

import service from '../services/autonomous-manager.ts';

const TASK_LIST_JSON = JSON.stringify([
  {
    id: 'task-1',
    projectId: 'proj-1',
    title: 'Buy groceries',
    content: '',
    priority: 1,
    dueDate: '2026-03-10T00:00:00Z',
    tags: [],
    status: 0,
  },
  {
    id: 'task-2',
    projectId: 'proj-1',
    title: 'Prepare presentation',
    content: '',
    priority: 3,
    dueDate: '2026-03-20T00:00:00Z',
    tags: [],
    status: 0,
  },
]);

const RECOMMENDATIONS_JSON = JSON.stringify([
  {
    action: 'update-task',
    taskId: 'task-1',
    projectId: 'proj-1',
    taskTitle: 'Buy groceries',
    reason: 'Overdue task — increasing priority',
    confidence: 'high',
    changes: { priority: 5 },
  },
  {
    action: 'complete-task',
    taskId: 'task-2',
    projectId: 'proj-1',
    taskTitle: 'Prepare presentation',
    reason: 'Task title indicates done',
    confidence: 'medium',
  },
  {
    action: 'delete-task',
    taskId: 'task-3',
    projectId: 'proj-1',
    taskTitle: 'Old duplicate',
    reason: 'Exact duplicate of task-1',
    confidence: 'low',
  },
]);

describe('autonomous-manager service', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockEventBus: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockAgentManager: any;
  let eventHandlers: Record<string, ((event: unknown) => void)[]>;

  beforeEach(() => {
    eventHandlers = {};

    mockAgentManager = {
      executeApprovedAction: vi.fn().mockResolvedValue({ success: true, result: '{}' }),
    };

    mockEventBus = {
      emit: vi.fn(),
      on: vi.fn((type: string, handler: (event: unknown) => void) => {
        if (!eventHandlers[type]) eventHandlers[type] = [];
        eventHandlers[type].push(handler);
      }),
      off: vi.fn(),
    };
  });

  afterEach(async () => {
    try {
      await service.stop();
    } catch {
      // Service may not have been started
    }
  });

  async function startService(): Promise<void> {
    await service.start({
      eventBus: mockEventBus,
      db: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      config: { agentManager: mockAgentManager },
    });
  }

  async function emitEventAsync(type: string, payload: unknown): Promise<void> {
    const handlers = eventHandlers[type] ?? [];
    for (const handler of handlers) {
      await handler({ id: 'evt1', timestamp: Date.now(), source: 'test', type, payload });
    }
  }

  function getEmittedEvents(type: string): unknown[] {
    return mockEventBus.emit.mock.calls
      .map((c: unknown[]) => c[0] as { type: string })
      .filter((e: { type: string }) => e.type === type);
  }

  // ─── Task 1: Service skeleton ───

  describe('Task 1: service skeleton', () => {
    it('subscribes to schedule:triggered and manage-request on start', async () => {
      await startService();
      expect(mockEventBus.on).toHaveBeenCalledWith(
        'schedule:triggered',
        expect.any(Function),
      );
      expect(mockEventBus.on).toHaveBeenCalledWith(
        'task-management:manage-request',
        expect.any(Function),
      );
    });

    it('unsubscribes on stop', async () => {
      await startService();
      await service.stop();
      expect(mockEventBus.off).toHaveBeenCalledWith(
        'schedule:triggered',
        expect.any(Function),
      );
      expect(mockEventBus.off).toHaveBeenCalledWith(
        'task-management:manage-request',
        expect.any(Function),
      );
    });

    it('filters schedule events — only responds to taskType: autonomous-task-management', async () => {
      await startService();
      // Trigger with wrong taskType
      await emitEventAsync('schedule:triggered', {
        scheduleId: 's1',
        scheduleName: 'Morning Digest',
        taskType: 'morning-digest',
      });
      expect(mockAgentManager.executeApprovedAction).not.toHaveBeenCalled();
    });

    it('nulls out references on stop — double stop does not throw', async () => {
      await startService();
      await service.stop();
      await service.stop();
    });
  });

  // ─── Task 2: Fetch and analyze tasks ───

  describe('Task 2: fetch and analyze tasks', () => {
    it('fetches all open tasks via ticktick:get-tasks on schedule trigger', async () => {
      mockAgentManager.executeApprovedAction
        .mockResolvedValueOnce({ success: true, result: TASK_LIST_JSON }) // fetch
        .mockResolvedValueOnce({ success: true, result: '[]' }); // analysis returns empty

      await startService();
      await emitEventAsync('schedule:triggered', {
        scheduleId: 's1',
        scheduleName: 'Autonomous Task Management',
        taskType: 'autonomous-task-management',
      });

      expect(mockAgentManager.executeApprovedAction).toHaveBeenCalledWith(
        expect.objectContaining({
          actionName: 'ticktick:get-tasks',
          skillName: 'task-management',
          details: expect.stringContaining('Get all open tasks'),
        }),
      );
    });

    it('emits failure event when task fetch fails', async () => {
      mockAgentManager.executeApprovedAction.mockResolvedValueOnce({
        success: false,
        error: 'TickTick API error',
      });

      await startService();
      await emitEventAsync('schedule:triggered', {
        scheduleId: 's1',
        scheduleName: 'Autonomous Task Management',
        taskType: 'autonomous-task-management',
      });

      const failedEvents = getEmittedEvents('task-management:autonomous:failed');
      expect(failedEvents).toHaveLength(1);
      expect(failedEvents[0]).toEqual(
        expect.objectContaining({
          payload: { error: expect.stringContaining('TickTick API error') },
        }),
      );
    });

    it('emits completion with all counts=0 when task list is empty', async () => {
      mockAgentManager.executeApprovedAction.mockResolvedValueOnce({
        success: true,
        result: '[]',
      });

      await startService();
      await emitEventAsync('schedule:triggered', {
        scheduleId: 's1',
        scheduleName: 'Autonomous Task Management',
        taskType: 'autonomous-task-management',
      });

      const completedEvents = getEmittedEvents('task-management:autonomous:completed');
      expect(completedEvents).toHaveLength(1);
      expect(completedEvents[0]).toEqual(
        expect.objectContaining({
          payload: {
            executedCount: 0,
            queuedCount: 0,
            failedCount: 0,
            actions: [],
          },
        }),
      );

      // No notification for 0-action runs
      const notifications = getEmittedEvents('notification');
      expect(notifications).toHaveLength(0);
    });

    it('emits failure when AI analysis returns invalid JSON', async () => {
      mockAgentManager.executeApprovedAction
        .mockResolvedValueOnce({ success: true, result: TASK_LIST_JSON })
        .mockResolvedValueOnce({ success: true, result: 'I cannot produce valid JSON' });

      await startService();
      await emitEventAsync('schedule:triggered', {
        scheduleId: 's1',
        scheduleName: 'Autonomous Task Management',
        taskType: 'autonomous-task-management',
      });

      // Invalid JSON → failure event emitted
      const failedEvents = getEmittedEvents('task-management:autonomous:failed');
      expect(failedEvents).toHaveLength(1);
      expect(failedEvents[0]).toEqual(
        expect.objectContaining({
          payload: { error: expect.stringContaining('parse') },
        }),
      );
    });

    it('emits failure event when task fetch throws', async () => {
      mockAgentManager.executeApprovedAction.mockRejectedValueOnce(
        new Error('Network timeout'),
      );

      await startService();
      await emitEventAsync('schedule:triggered', {
        scheduleId: 's1',
        scheduleName: 'Autonomous Task Management',
        taskType: 'autonomous-task-management',
      });

      const failedEvents = getEmittedEvents('task-management:autonomous:failed');
      expect(failedEvents).toHaveLength(1);
      expect(failedEvents[0]).toEqual(
        expect.objectContaining({
          payload: { error: 'Network timeout' },
        }),
      );
    });
  });

  // ─── Task 3: Execute actions through permission gates ───

  describe('Task 3: execute actions through permission gates', () => {
    function setupFetchAndAnalysis(recommendations: string): void {
      mockAgentManager.executeApprovedAction
        .mockResolvedValueOnce({ success: true, result: TASK_LIST_JSON }) // fetch
        .mockResolvedValueOnce({ success: true, result: recommendations }); // analysis
    }

    it('executes yellow-tier update-task and notifies', async () => {
      const recs = JSON.stringify([
        {
          action: 'update-task',
          taskId: 'task-1',
          projectId: 'proj-1',
          taskTitle: 'Buy groceries',
          reason: 'Overdue — priority bump',
          confidence: 'high',
          changes: { priority: 5 },
        },
      ]);
      setupFetchAndAnalysis(recs);
      mockAgentManager.executeApprovedAction.mockResolvedValueOnce({ success: true }); // update

      await startService();
      await emitEventAsync('schedule:triggered', {
        scheduleId: 's1',
        scheduleName: 'Autonomous Task Management',
        taskType: 'autonomous-task-management',
      });

      // Verify ticktick:update-task was called
      const updateCall = mockAgentManager.executeApprovedAction.mock.calls[2];
      expect(updateCall[0]).toEqual(
        expect.objectContaining({
          actionName: 'ticktick:update-task',
          skillName: 'task-management',
        }),
      );

      // Notification emitted
      const notifications = getEmittedEvents('notification');
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toEqual(
        expect.objectContaining({
          payload: expect.objectContaining({
            title: 'Autonomous Task Management',
            body: expect.stringContaining('1 updates'),
          }),
        }),
      );
    });

    it('counts red-tier delete-task as queued (not failed)', async () => {
      const recs = JSON.stringify([
        {
          action: 'delete-task',
          taskId: 'task-3',
          projectId: 'proj-1',
          taskTitle: 'Duplicate task',
          reason: 'Exact duplicate',
          confidence: 'high',
        },
      ]);
      setupFetchAndAnalysis(recs);
      // Red-tier returns success: false with "queued" in error
      mockAgentManager.executeApprovedAction.mockResolvedValueOnce({
        success: false,
        error: 'Action queued-for-approval (red tier)',
      });

      await startService();
      await emitEventAsync('schedule:triggered', {
        scheduleId: 's1',
        scheduleName: 'Autonomous Task Management',
        taskType: 'autonomous-task-management',
      });

      const completedEvents = getEmittedEvents('task-management:autonomous:completed');
      expect(completedEvents).toHaveLength(1);
      expect(completedEvents[0]).toEqual(
        expect.objectContaining({
          payload: expect.objectContaining({
            executedCount: 0,
            queuedCount: 1,
            failedCount: 0,
          }),
        }),
      );

      // Queued actions should still trigger notification
      const notifications = getEmittedEvents('notification');
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toEqual(
        expect.objectContaining({
          payload: expect.objectContaining({
            body: expect.stringContaining('queued for approval'),
          }),
        }),
      );
    });

    it('handles partial action failure correctly', async () => {
      const recs = JSON.stringify([
        {
          action: 'update-task',
          taskId: 'task-1',
          projectId: 'proj-1',
          taskTitle: 'Task A',
          reason: 'priority bump',
          confidence: 'high',
          changes: { priority: 5 },
        },
        {
          action: 'complete-task',
          taskId: 'task-2',
          projectId: 'proj-1',
          taskTitle: 'Task B',
          reason: 'already done',
          confidence: 'medium',
        },
        {
          action: 'update-task',
          taskId: 'task-3',
          projectId: 'proj-1',
          taskTitle: 'Task C',
          reason: 'tag update',
          confidence: 'high',
          changes: { tags: ['urgent'] },
        },
      ]);
      setupFetchAndAnalysis(recs);
      mockAgentManager.executeApprovedAction
        .mockResolvedValueOnce({ success: true }) // task-1 succeeds
        .mockResolvedValueOnce({ success: false, error: 'Agent failed' }) // task-2 fails
        .mockResolvedValueOnce({ success: true }); // task-3 succeeds

      await startService();
      await emitEventAsync('schedule:triggered', {
        scheduleId: 's1',
        scheduleName: 'Autonomous Task Management',
        taskType: 'autonomous-task-management',
      });

      const completedEvents = getEmittedEvents('task-management:autonomous:completed');
      expect(completedEvents).toHaveLength(1);
      expect(completedEvents[0]).toEqual(
        expect.objectContaining({
          payload: expect.objectContaining({
            executedCount: 2,
            queuedCount: 0,
            failedCount: 1,
          }),
        }),
      );
    });

    it('filters out low-confidence recommendations', async () => {
      // 3 recommendations: 1 low (filtered), 1 medium, 1 high → only 2 executed
      setupFetchAndAnalysis(RECOMMENDATIONS_JSON);
      mockAgentManager.executeApprovedAction
        .mockResolvedValueOnce({ success: true }) // update-task (high)
        .mockResolvedValueOnce({ success: true }); // complete-task (medium)
      // delete-task (low) should be filtered out — no 3rd action call

      await startService();
      await emitEventAsync('schedule:triggered', {
        scheduleId: 's1',
        scheduleName: 'Autonomous Task Management',
        taskType: 'autonomous-task-management',
      });

      // 2 fetch/analysis + 2 actions = 4 total calls (not 5)
      expect(mockAgentManager.executeApprovedAction).toHaveBeenCalledTimes(4);

      const completedEvents = getEmittedEvents('task-management:autonomous:completed');
      expect(completedEvents[0]).toEqual(
        expect.objectContaining({
          payload: expect.objectContaining({
            executedCount: 2,
            failedCount: 0,
          }),
        }),
      );
    });
  });

  // ─── Task 4: Summary notification ───

  describe('Task 4: summary notification', () => {
    it('includes View Tasks inline keyboard action', async () => {
      const recs = JSON.stringify([
        {
          action: 'update-task',
          taskId: 'task-1',
          projectId: 'proj-1',
          taskTitle: 'Test task',
          reason: 'Priority bump',
          confidence: 'high',
          changes: { priority: 5 },
        },
      ]);
      mockAgentManager.executeApprovedAction
        .mockResolvedValueOnce({ success: true, result: TASK_LIST_JSON })
        .mockResolvedValueOnce({ success: true, result: recs })
        .mockResolvedValueOnce({ success: true });

      await startService();
      await emitEventAsync('schedule:triggered', {
        scheduleId: 's1',
        scheduleName: 'Autonomous Task Management',
        taskType: 'autonomous-task-management',
      });

      const notifications = getEmittedEvents('notification');
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toEqual(
        expect.objectContaining({
          payload: expect.objectContaining({
            actions: [{ label: 'View Tasks', action: 't:l:' }],
          }),
        }),
      );
    });

    it('skips notification when 0 actions executed or queued', async () => {
      mockAgentManager.executeApprovedAction
        .mockResolvedValueOnce({ success: true, result: TASK_LIST_JSON })
        .mockResolvedValueOnce({ success: true, result: '[]' });

      await startService();
      await emitEventAsync('schedule:triggered', {
        scheduleId: 's1',
        scheduleName: 'Autonomous Task Management',
        taskType: 'autonomous-task-management',
      });

      const notifications = getEmittedEvents('notification');
      expect(notifications).toHaveLength(0);
    });

    it('emits task-management:autonomous:completed with full details', async () => {
      const recs = JSON.stringify([
        {
          action: 'update-task',
          taskId: 'task-1',
          projectId: 'proj-1',
          taskTitle: 'Buy groceries',
          reason: 'Overdue',
          confidence: 'high',
          changes: { priority: 5 },
        },
      ]);
      mockAgentManager.executeApprovedAction
        .mockResolvedValueOnce({ success: true, result: TASK_LIST_JSON })
        .mockResolvedValueOnce({ success: true, result: recs })
        .mockResolvedValueOnce({ success: true });

      await startService();
      await emitEventAsync('schedule:triggered', {
        scheduleId: 's1',
        scheduleName: 'Autonomous Task Management',
        taskType: 'autonomous-task-management',
      });

      const completedEvents = getEmittedEvents('task-management:autonomous:completed');
      expect(completedEvents).toHaveLength(1);
      const evt = completedEvents[0] as { payload: { actions: unknown[] } };
      expect(evt.payload.actions).toHaveLength(1);
      expect(evt.payload.actions[0]).toEqual({
        action: 'update-task',
        taskTitle: 'Buy groceries',
        reason: 'Overdue',
        outcome: 'executed',
      });
    });
  });

  // ─── Concurrent run guard ───

  describe('concurrent run guard', () => {
    it('skips second trigger while already running', async () => {
      // First call: slow fetch that takes time
      let resolveFirst: (v: unknown) => void;
      const slowPromise = new Promise((resolve) => {
        resolveFirst = resolve;
      });
      mockAgentManager.executeApprovedAction.mockReturnValueOnce(slowPromise);

      await startService();

      // Start first run (won't complete yet)
      const firstRun = emitEventAsync('schedule:triggered', {
        scheduleId: 's1',
        scheduleName: 'Autonomous Task Management',
        taskType: 'autonomous-task-management',
      });

      // Immediately trigger second run
      await emitEventAsync('schedule:triggered', {
        scheduleId: 's2',
        scheduleName: 'Autonomous Task Management',
        taskType: 'autonomous-task-management',
      });

      // Complete first run
      resolveFirst!({ success: true, result: '[]' });
      await firstRun;

      // Only 1 call to executeApprovedAction (the first run)
      expect(mockAgentManager.executeApprovedAction).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Manual trigger ───

  describe('manual trigger via manage-request', () => {
    it('runs same flow as schedule trigger', async () => {
      mockAgentManager.executeApprovedAction.mockResolvedValueOnce({
        success: true,
        result: '[]',
      });

      await startService();
      await emitEventAsync('task-management:manage-request', {
        source: 'telegram',
      });

      expect(mockAgentManager.executeApprovedAction).toHaveBeenCalledWith(
        expect.objectContaining({
          actionName: 'ticktick:get-tasks',
        }),
      );
    });

    it('rejects invalid manage-request payload', async () => {
      await startService();
      await emitEventAsync('task-management:manage-request', {
        source: 'invalid-source',
      });

      expect(mockAgentManager.executeApprovedAction).not.toHaveBeenCalled();
    });
  });

  // ─── Unit tests for parsers ───

  describe('parseRecommendations', () => {
    it('parses valid recommendation array', () => {
      const recs = parseRecommendations(RECOMMENDATIONS_JSON);
      expect(recs).toHaveLength(3);
      expect(recs[0].action).toBe('update-task');
      expect(recs[0].confidence).toBe('high');
    });

    it('extracts JSON array from surrounding text', () => {
      const recs = parseRecommendations(`Here are my recommendations: ${RECOMMENDATIONS_JSON} End.`);
      expect(recs).toHaveLength(3);
    });

    it('returns null for unparseable text', () => {
      expect(parseRecommendations('not json')).toBeNull();
    });

    it('returns empty array when valid JSON array is empty', () => {
      expect(parseRecommendations('[]')).toEqual([]);
    });

    it('filters out items with missing required fields', () => {
      const recs = parseRecommendations(
        JSON.stringify([
          { action: 'update-task', taskId: 'x', projectId: 'y', taskTitle: 'T', reason: 'R', confidence: 'high' },
          { action: 'update-task' }, // missing required fields
        ]),
      );
      expect(recs).toHaveLength(1);
    });

    it('rejects items with invalid action type', () => {
      const recs = parseRecommendations(
        JSON.stringify([
          { action: 'move-task', taskId: 'x', projectId: 'y', taskTitle: 'T', reason: 'R', confidence: 'high' },
        ]),
      );
      expect(recs).toHaveLength(0);
    });

    it('rejects items with invalid confidence level', () => {
      const recs = parseRecommendations(
        JSON.stringify([
          { action: 'update-task', taskId: 'x', projectId: 'y', taskTitle: 'T', reason: 'R', confidence: 'very-high' },
        ]),
      );
      expect(recs).toHaveLength(0);
    });
  });

  describe('buildAnalysisPrompt', () => {
    it('includes task data and current date', () => {
      const prompt = buildAnalysisPrompt('[{"id":"task-1"}]');
      expect(prompt).toContain('[{"id":"task-1"}]');
      expect(prompt).toContain('Current date:');
      expect(prompt).toMatch(/\d{4}-\d{2}-\d{2}/);
    });

    it('includes action type instructions', () => {
      const prompt = buildAnalysisPrompt('[]');
      expect(prompt).toContain('update-task');
      expect(prompt).toContain('complete-task');
      expect(prompt).toContain('delete-task');
    });
  });

  // ─── Green-tier silent read ───

  describe('green-tier silent read', () => {
    it('ticktick:get-tasks called with correct params, no notification for the read', async () => {
      mockAgentManager.executeApprovedAction.mockResolvedValueOnce({
        success: true,
        result: '[]',
      });

      await startService();
      await emitEventAsync('schedule:triggered', {
        scheduleId: 's1',
        scheduleName: 'Autonomous Task Management',
        taskType: 'autonomous-task-management',
      });

      // Verify get-tasks was called
      expect(mockAgentManager.executeApprovedAction).toHaveBeenCalledWith(
        expect.objectContaining({
          actionName: 'ticktick:get-tasks',
          skillName: 'task-management',
        }),
      );

      // No notification event for the read itself
      const notifications = getEmittedEvents('notification');
      expect(notifications).toHaveLength(0);
    });
  });

  // ─── No-op when agent manager unavailable ───

  describe('agent manager unavailable', () => {
    it('does not process when agent manager is unavailable', async () => {
      await service.start({
        eventBus: mockEventBus,
        db: {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        config: {}, // No agent manager
      });

      await emitEventAsync('schedule:triggered', {
        scheduleId: 's1',
        scheduleName: 'Autonomous Task Management',
        taskType: 'autonomous-task-management',
      });

      expect(mockEventBus.emit).not.toHaveBeenCalled();
    });
  });
});
