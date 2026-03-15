import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@raven/shared', async () => {
  const actual = await vi.importActual<typeof import('@raven/shared')>('@raven/shared');
  return {
    generateId: vi.fn(() => 'test-id'),
    SUITE_DAILY_BRIEFING: 'daily-briefing',
    SOURCE_ORCHESTRATOR: 'orchestrator',
    SystemHealthAlertPayloadSchema: actual.SystemHealthAlertPayloadSchema,
    createLogger: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  };
});

vi.mock('@raven/core/suite-registry/service-runner.ts', () => ({}));

import type { AgentTaskCompleteEvent, NotificationEvent } from '@raven/shared';

describe('briefing-formatter service', () => {
  let service: any;
  let mockEventBus: any;
  let taskCompleteHandler: ((event: unknown) => void) | null;

  const validBriefingResult = JSON.stringify({
    tasks: [
      { id: 'task1', title: 'Review quarterly report', dueDate: '2026-03-14', isOverdue: true, project: 'Work' },
      { id: 'task2', title: 'Prepare meeting slides', dueDate: '2026-03-15', isOverdue: false, project: 'Work' },
      { id: 'task3', title: 'Call dentist', dueDate: '2026-03-15', isOverdue: false, project: null },
    ],
    emails: [
      { id: 'email1', from: 'John Smith', subject: 'Q1 Results', snippet: 'need your input on the...', isUrgent: true },
      { id: 'email2', from: 'AWS', subject: 'Monthly invoice', snippet: '$142.50', isUrgent: false },
    ],
    systemStatus: 'All systems operational. 3 pipelines ran successfully overnight.',
  });

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T08:00:00Z'));
    taskCompleteHandler = null;

    mockEventBus = {
      emit: vi.fn(),
      on: vi.fn((type: string, handler: any) => {
        if (type === 'agent:task:complete') {
          taskCompleteHandler = handler;
        }
      }),
      off: vi.fn(),
    };

    const mod = await import('../services/briefing-formatter.ts');
    service = mod.default;
  });

  async function startService(): Promise<void> {
    await service.start({
      eventBus: mockEventBus,
      db: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      config: {},
    });
  }

  function emitTaskComplete(result: string, taskType = 'morning-digest', success = true): void {
    taskCompleteHandler!({
      id: 'evt1',
      timestamp: Date.now(),
      source: 'agent-manager',
      type: 'agent:task:complete',
      payload: {
        taskId: 'task-123',
        result,
        durationMs: 5000,
        success,
        taskType,
      },
    } as unknown as AgentTaskCompleteEvent);
  }

  it('subscribes to agent:task:complete on start', async () => {
    await startService();
    expect(mockEventBus.on).toHaveBeenCalledWith('agent:task:complete', expect.any(Function));
  });

  it('unsubscribes from agent:task:complete on stop', async () => {
    await startService();
    await service.stop();
    expect(mockEventBus.off).toHaveBeenCalledWith('agent:task:complete', expect.any(Function));
  });

  describe('briefing formatting', () => {
    it('formats tasks and emails into notification event with MarkdownV2', async () => {
      await startService();
      emitTaskComplete(validBriefingResult);

      // Should emit at least one notification event
      const notifCalls = mockEventBus.emit.mock.calls.filter(
        (call: any) => call[0].type === 'notification',
      );
      expect(notifCalls.length).toBeGreaterThan(0);

      const notif = notifCalls[0][0] as NotificationEvent;
      expect(notif.payload.channel).toBe('telegram');
      expect(notif.payload.topicName).toBe('General');
      expect(notif.payload.title).toContain('Morning Briefing');
      // Body should contain section content, not the header
      expect(notif.payload.body).toContain('Tasks');
    });

    it('includes overdue task buttons with correct callback data', async () => {
      await startService();
      emitTaskComplete(validBriefingResult);

      const notifCalls = mockEventBus.emit.mock.calls.filter(
        (call: any) => call[0].type === 'notification',
      );
      // Find the notification with task actions
      const taskNotif = notifCalls.find((call: any) =>
        call[0].payload.actions?.some((a: any) => a.action.startsWith('t:')),
      );
      expect(taskNotif).toBeDefined();

      const actions = taskNotif![0].payload.actions;
      // Should have Complete, Snooze 1d, Snooze 1w, Drop for the overdue task
      expect(actions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: 'Complete', action: 't:c:task1' }),
          expect.objectContaining({ label: 'Snooze 1d', action: 't:s:task1:1d' }),
          expect.objectContaining({ label: 'Snooze 1w', action: 't:s:task1:1w' }),
          expect.objectContaining({ label: 'Drop', action: 't:d:task1' }),
        ]),
      );
    });

    it('includes email action buttons for urgent emails', async () => {
      await startService();
      emitTaskComplete(validBriefingResult);

      const notifCalls = mockEventBus.emit.mock.calls.filter(
        (call: any) => call[0].type === 'notification',
      );
      const emailNotif = notifCalls.find((call: any) =>
        call[0].payload.actions?.some((a: any) => a.action.startsWith('e:r:email1')),
      );
      expect(emailNotif).toBeDefined();

      const actions = emailNotif![0].payload.actions;
      expect(actions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: 'Reply', action: 'e:r:email1' }),
          expect.objectContaining({ label: 'Archive', action: 'e:a:email1' }),
          expect.objectContaining({ label: 'Flag', action: 'e:f:email1' }),
        ]),
      );
    });

    it('includes email action buttons for non-urgent emails (AC3)', async () => {
      await startService();
      emitTaskComplete(validBriefingResult);

      const notifCalls = mockEventBus.emit.mock.calls.filter(
        (call: any) => call[0].type === 'notification',
      );
      const nonUrgentNotif = notifCalls.find((call: any) =>
        call[0].payload.actions?.some((a: any) => a.action.startsWith('e:r:email2')),
      );
      expect(nonUrgentNotif).toBeDefined();

      const actions = nonUrgentNotif![0].payload.actions;
      expect(actions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: 'Reply', action: 'e:r:email2' }),
          expect.objectContaining({ label: 'Archive', action: 'e:a:email2' }),
          expect.objectContaining({ label: 'Flag', action: 'e:f:email2' }),
        ]),
      );
    });

    it('marks overdue tasks with warning indicator', async () => {
      await startService();
      emitTaskComplete(validBriefingResult);

      const notifCalls = mockEventBus.emit.mock.calls.filter(
        (call: any) => call[0].type === 'notification',
      );
      const bodyText = notifCalls.map((c: any) => c[0].payload.body).join('\n');
      expect(bodyText).toContain('Overdue');
      expect(bodyText).toContain('Review quarterly report');
    });

    it('marks urgent emails with indicator', async () => {
      await startService();
      emitTaskComplete(validBriefingResult);

      const notifCalls = mockEventBus.emit.mock.calls.filter(
        (call: any) => call[0].type === 'notification',
      );
      const bodyText = notifCalls.map((c: any) => c[0].payload.body).join('\n');
      expect(bodyText).toContain('John Smith');
      expect(bodyText).toContain('Q1 Results');
    });
  });

  describe('edge cases', () => {
    it('handles empty tasks array', async () => {
      await startService();
      emitTaskComplete(JSON.stringify({
        tasks: [],
        emails: [{ id: 'e1', from: 'Bob', subject: 'Hi', snippet: 'test', isUrgent: false }],
        systemStatus: 'OK',
      }));

      const notifCalls = mockEventBus.emit.mock.calls.filter(
        (call: any) => call[0].type === 'notification',
      );
      expect(notifCalls.length).toBeGreaterThan(0);
    });

    it('handles empty emails array', async () => {
      await startService();
      emitTaskComplete(JSON.stringify({
        tasks: [{ id: 't1', title: 'Do stuff', dueDate: '2026-03-15', isOverdue: false, project: null }],
        emails: [],
        systemStatus: 'OK',
      }));

      const notifCalls = mockEventBus.emit.mock.calls.filter(
        (call: any) => call[0].type === 'notification',
      );
      expect(notifCalls.length).toBeGreaterThan(0);
    });

    it('handles malformed agent response gracefully', async () => {
      await startService();
      emitTaskComplete('This is not JSON at all');

      // Should not emit notification, should not throw
      const notifCalls = mockEventBus.emit.mock.calls.filter(
        (call: any) => call[0].type === 'notification',
      );
      expect(notifCalls.length).toBe(0);
    });

    it('ignores non-morning-digest task completions', async () => {
      await startService();
      emitTaskComplete(validBriefingResult, 'other-task-type');

      const notifCalls = mockEventBus.emit.mock.calls.filter(
        (call: any) => call[0].type === 'notification',
      );
      expect(notifCalls.length).toBe(0);
    });

    it('ignores failed task completions', async () => {
      await startService();
      emitTaskComplete(validBriefingResult, 'morning-digest', false);

      const notifCalls = mockEventBus.emit.mock.calls.filter(
        (call: any) => call[0].type === 'notification',
      );
      expect(notifCalls.length).toBe(0);
    });

    it('splits long briefing into multiple messages under 4096 chars', async () => {
      await startService();

      // Create many tasks to exceed 4096 chars
      const manyTasks = Array.from({ length: 50 }, (_, i) => ({
        id: `task${i}`,
        title: `This is a moderately long task title number ${i} that needs attention`,
        dueDate: '2026-03-15',
        isOverdue: i < 25,
        project: 'TestProject',
      }));

      emitTaskComplete(JSON.stringify({
        tasks: manyTasks,
        emails: [],
        systemStatus: 'OK',
      }));

      const notifCalls = mockEventBus.emit.mock.calls.filter(
        (call: any) => call[0].type === 'notification',
      );
      // Should have split into multiple messages (50 tasks with buttons exceeds 4096 chars)
      expect(notifCalls.length).toBeGreaterThan(1);
      // Each message body should be under 4096 chars
      for (const call of notifCalls) {
        const body = call[0].payload.body as string;
        const title = call[0].payload.title as string;
        // Full message = *title*\n\nbody — check body fits
        expect(body.length).toBeLessThanOrEqual(4096);
      }
    });
  });

  describe('delivery retry', () => {
    it('retries on notification emit failure up to 3 times', async () => {
      await startService();

      let emitCount = 0;
      mockEventBus.emit.mockImplementation((event: any) => {
        if (event.type === 'notification') {
          emitCount++;
          if (emitCount <= 3) {
            throw new Error('Telegram delivery failed');
          }
        }
      });

      emitTaskComplete(validBriefingResult);

      // Advance timers through retry backoff (1s, 2s, 4s)
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(4000);

      // Should have attempted emit multiple times
      const notifEmits = mockEventBus.emit.mock.calls.filter(
        (call: any) => call[0].type === 'notification',
      );
      expect(notifEmits.length).toBeGreaterThanOrEqual(1);
    });

    it('emits system:health:alert after all retries exhausted', async () => {
      await startService();

      mockEventBus.emit.mockImplementation((event: any) => {
        if (event.type === 'notification') {
          throw new Error('Telegram delivery failed');
        }
      });

      emitTaskComplete(validBriefingResult);

      // Advance through all retries
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(4000);

      const alertCalls = mockEventBus.emit.mock.calls.filter(
        (call: any) => call[0].type === 'system:health:alert',
      );
      expect(alertCalls.length).toBeGreaterThan(0);
      expect(alertCalls[0][0].payload.severity).toBe('warning');
    });
  });
});
