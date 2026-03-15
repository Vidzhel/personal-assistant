import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseEmailResult,
  parseActionItems,
  retryQueue,
  processRetryQueue,
  MAX_RETRY_ATTEMPTS,
} from '../services/action-extractor.ts';

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

import service from '../services/action-extractor.ts';

const FULL_EMAIL_JSON = {
  from: 'boss@company.com',
  to: 'me@company.com',
  subject: 'Q1 Report',
  body: 'Please send the report by Friday and schedule a review meeting next week.',
  date: '2026-03-15',
  messageId: 'msg-001',
};

const SINGLE_ACTION_ITEMS = [
  {
    title: 'Send the Q1 report',
    dueDate: '2026-03-20',
    priority: 'high',
    context: 'Boss requested in Q1 Report email',
  },
];

const MULTI_ACTION_ITEMS = [
  {
    title: 'Send the Q1 report',
    dueDate: '2026-03-20',
    priority: 'high',
    context: 'Boss requested Q1 report by Friday',
  },
  {
    title: 'Schedule review meeting',
    dueDate: null,
    priority: 'medium',
    context: 'Boss wants a review meeting next week',
  },
  {
    title: 'Prepare presentation slides',
    dueDate: '2026-03-19',
    priority: 'medium',
    context: 'Needed for the review meeting',
  },
];

describe('action-extractor service', () => {
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

  function setupEmailFetchAndExtraction(
    emailJson: object,
    actionItemsJson: unknown[],
  ): void {
    mockAgentManager.executeApprovedAction
      .mockResolvedValueOnce({ success: true, result: JSON.stringify(emailJson) }) // gmail:get-email
      .mockResolvedValueOnce({ success: true, result: JSON.stringify(actionItemsJson) }); // gmail:search-emails (extraction)
  }

  function getEmittedEvents(type: string): unknown[] {
    return mockEventBus.emit.mock.calls
      .map((c: unknown[]) => c[0] as { type: string })
      .filter((e: { type: string }) => e.type === type);
  }

  // ─── Task 1: Service skeleton ───

  describe('Task 1: service skeleton', () => {
    it('subscribes to email:triage:action-items on start', async () => {
      await startService();
      expect(mockEventBus.on).toHaveBeenCalledWith(
        'email:triage:action-items',
        expect.any(Function),
      );
    });

    it('unsubscribes on stop', async () => {
      await startService();
      await service.stop();
      expect(mockEventBus.off).toHaveBeenCalledWith(
        'email:triage:action-items',
        expect.any(Function),
      );
    });

    it('validates event payload — skips invalid', async () => {
      await startService();
      await emitEventAsync('email:triage:action-items', { bad: 'data' });
      expect(mockAgentManager.executeApprovedAction).not.toHaveBeenCalled();
    });

    it('nulls out references on stop — double stop does not throw', async () => {
      await startService();
      await service.stop();
      await service.stop();
    });

    it('clears retry queue on stop', async () => {
      await startService();
      retryQueue.set('test-email', {
        emailId: 'test-email',
        items: [],
        emailMeta: { from: 'a', subject: 'b', date: '' },
        attempts: 1,
        lastAttempt: 0,
      });
      await service.stop();
      expect(retryQueue.size).toBe(0);
    });
  });

  // ─── Task 2: Fetch full email content ───

  describe('Task 2: fetch full email content', () => {
    it('fetches email via gmail:get-email on valid event', async () => {
      setupEmailFetchAndExtraction(FULL_EMAIL_JSON, []);
      await startService();
      await emitEventAsync('email:triage:action-items', { emailId: 'msg-001' });

      expect(mockAgentManager.executeApprovedAction).toHaveBeenCalledWith(
        expect.objectContaining({
          actionName: 'gmail:get-email',
          skillName: 'email',
          details: expect.stringContaining('msg-001'),
        }),
      );
    });

    it('emits failure event when email fetch fails', async () => {
      mockAgentManager.executeApprovedAction.mockResolvedValueOnce({
        success: false,
        error: 'Gmail API error',
      });
      await startService();
      await emitEventAsync('email:triage:action-items', { emailId: 'msg-fail' });

      const failedEvents = getEmittedEvents('email:action-extract:failed');
      expect(failedEvents).toHaveLength(1);
      expect(failedEvents[0]).toEqual(
        expect.objectContaining({
          type: 'email:action-extract:failed',
          payload: { emailId: 'msg-fail', error: expect.stringContaining('Gmail API error') },
        }),
      );
    });

    it('emits failure event when email fetch throws', async () => {
      mockAgentManager.executeApprovedAction.mockRejectedValueOnce(new Error('Network timeout'));
      await startService();
      await emitEventAsync('email:triage:action-items', { emailId: 'msg-throw' });

      const failedEvents = getEmittedEvents('email:action-extract:failed');
      expect(failedEvents).toHaveLength(1);
      expect(failedEvents[0]).toEqual(
        expect.objectContaining({
          payload: { emailId: 'msg-throw', error: 'Network timeout' },
        }),
      );
    });

    it('emits failure when email result is unparseable', async () => {
      mockAgentManager.executeApprovedAction.mockResolvedValueOnce({
        success: true,
        result: 'not json at all',
      });
      await startService();
      await emitEventAsync('email:triage:action-items', { emailId: 'msg-bad-json' });

      const failedEvents = getEmittedEvents('email:action-extract:failed');
      expect(failedEvents).toHaveLength(1);
    });
  });

  // ─── Task 3: AI-powered action item extraction ───

  describe('Task 3: AI-powered action item extraction', () => {
    it('calls gmail:search-emails with extraction prompt', async () => {
      setupEmailFetchAndExtraction(FULL_EMAIL_JSON, []);
      await startService();
      await emitEventAsync('email:triage:action-items', { emailId: 'msg-001' });

      const calls = mockAgentManager.executeApprovedAction.mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[1][0]).toEqual(
        expect.objectContaining({
          actionName: 'gmail:search-emails',
          skillName: 'email',
          details: expect.stringContaining('action items'),
        }),
      );
    });

    it('handles empty action items — emits completed with 0 tasks', async () => {
      setupEmailFetchAndExtraction(FULL_EMAIL_JSON, []);
      await startService();
      await emitEventAsync('email:triage:action-items', { emailId: 'msg-001' });

      const completedEvents = getEmittedEvents('email:action-extract:completed');
      expect(completedEvents).toHaveLength(1);
      expect(completedEvents[0]).toEqual(
        expect.objectContaining({
          payload: { emailId: 'msg-001', tasksCreated: 0, actionItems: [] },
        }),
      );
    });

    it('filters out items with empty titles', async () => {
      setupEmailFetchAndExtraction(FULL_EMAIL_JSON, [
        { title: '', dueDate: null, priority: 'low', context: 'empty' },
        { title: 'Real task', dueDate: null, priority: 'medium', context: 'valid' },
      ]);
      // Third call for ticktick:create-task
      mockAgentManager.executeApprovedAction.mockResolvedValueOnce({ success: true });

      await startService();
      await emitEventAsync('email:triage:action-items', { emailId: 'msg-001' });

      // Only 1 task creation call (3 total: fetch + extract + 1 create)
      expect(mockAgentManager.executeApprovedAction).toHaveBeenCalledTimes(3);
      expect(mockAgentManager.executeApprovedAction).toHaveBeenCalledWith(
        expect.objectContaining({ actionName: 'ticktick:create-task' }),
      );
    });

    it('handles malformed agent extraction response', async () => {
      mockAgentManager.executeApprovedAction
        .mockResolvedValueOnce({ success: true, result: JSON.stringify(FULL_EMAIL_JSON) })
        .mockResolvedValueOnce({ success: true, result: 'Sure! Here are the action items: not valid json' });

      await startService();
      await emitEventAsync('email:triage:action-items', { emailId: 'msg-001' });

      // Should emit completed with 0 (treated as empty)
      const completedEvents = getEmittedEvents('email:action-extract:completed');
      expect(completedEvents).toHaveLength(1);
      expect(completedEvents[0]).toEqual(
        expect.objectContaining({
          payload: { emailId: 'msg-001', tasksCreated: 0, actionItems: [] },
        }),
      );
    });

    it('emits failure when extraction agent throws', async () => {
      mockAgentManager.executeApprovedAction
        .mockResolvedValueOnce({ success: true, result: JSON.stringify(FULL_EMAIL_JSON) })
        .mockRejectedValueOnce(new Error('Agent crashed'));

      await startService();
      await emitEventAsync('email:triage:action-items', { emailId: 'msg-001' });

      const failedEvents = getEmittedEvents('email:action-extract:failed');
      expect(failedEvents).toHaveLength(1);
    });
  });

  // ─── Task 4: Create TickTick tasks ───

  describe('Task 4: create TickTick tasks', () => {
    it('creates one task for single action item (AC #1)', async () => {
      setupEmailFetchAndExtraction(FULL_EMAIL_JSON, SINGLE_ACTION_ITEMS);
      mockAgentManager.executeApprovedAction.mockResolvedValueOnce({ success: true }); // ticktick

      await startService();
      await emitEventAsync('email:triage:action-items', { emailId: 'msg-001' });

      expect(mockAgentManager.executeApprovedAction).toHaveBeenCalledWith(
        expect.objectContaining({
          actionName: 'ticktick:create-task',
          skillName: 'task-management',
          details: expect.stringContaining('Send the Q1 report'),
        }),
      );
    });

    it('creates multiple tasks for multiple action items (AC #2)', async () => {
      setupEmailFetchAndExtraction(FULL_EMAIL_JSON, MULTI_ACTION_ITEMS);
      // 3 task creation calls
      mockAgentManager.executeApprovedAction
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ success: true });

      await startService();
      await emitEventAsync('email:triage:action-items', { emailId: 'msg-001' });

      const ticktickCalls = mockAgentManager.executeApprovedAction.mock.calls.filter(
        (c: unknown[]) => (c[0] as { actionName: string }).actionName === 'ticktick:create-task',
      );
      expect(ticktickCalls).toHaveLength(3);
    });

    it('queues for retry when ALL task creations fail (AC #4)', async () => {
      setupEmailFetchAndExtraction(FULL_EMAIL_JSON, SINGLE_ACTION_ITEMS);
      mockAgentManager.executeApprovedAction.mockResolvedValueOnce({
        success: false,
        error: 'TickTick unavailable',
      });

      await startService();
      await emitEventAsync('email:triage:action-items', { emailId: 'msg-001' });

      expect(retryQueue.has('msg-001')).toBe(true);
      const entry = retryQueue.get('msg-001')!;
      expect(entry.attempts).toBe(1);
      expect(entry.items).toHaveLength(1);
      expect(entry.emailMeta).toEqual({ from: 'boss@company.com', subject: 'Q1 Report', date: '2026-03-15' });
    });

    it('queues only failed items on partial failure (H1 fix)', async () => {
      setupEmailFetchAndExtraction(FULL_EMAIL_JSON, MULTI_ACTION_ITEMS);
      // First task succeeds, second fails, third succeeds
      mockAgentManager.executeApprovedAction
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ success: false })
        .mockResolvedValueOnce({ success: true });

      await startService();
      await emitEventAsync('email:triage:action-items', { emailId: 'msg-001' });

      // Should queue only the 1 failed item
      expect(retryQueue.has('msg-001')).toBe(true);
      const entry = retryQueue.get('msg-001')!;
      expect(entry.items).toHaveLength(1);
      expect(entry.items[0].title).toBe('Schedule review meeting');

      // Should still emit notification for the 2 that succeeded
      const notifications = getEmittedEvents('notification');
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toEqual(
        expect.objectContaining({
          payload: expect.objectContaining({
            body: expect.stringContaining('Created 2 task(s)'),
          }),
        }),
      );

      // Should emit completed with only the succeeded items
      const completedEvents = getEmittedEvents('email:action-extract:completed');
      expect(completedEvents).toHaveLength(1);
      expect(completedEvents[0]).toEqual(
        expect.objectContaining({
          payload: {
            emailId: 'msg-001',
            tasksCreated: 2,
            actionItems: ['Send the Q1 report', 'Prepare presentation slides'],
          },
        }),
      );
    });

    it('includes email reference in task creation prompt', async () => {
      setupEmailFetchAndExtraction(FULL_EMAIL_JSON, SINGLE_ACTION_ITEMS);
      mockAgentManager.executeApprovedAction.mockResolvedValueOnce({ success: true });

      await startService();
      await emitEventAsync('email:triage:action-items', { emailId: 'msg-001' });

      const ticktickCall = mockAgentManager.executeApprovedAction.mock.calls.find(
        (c: unknown[]) => (c[0] as { actionName: string }).actionName === 'ticktick:create-task',
      );
      expect(ticktickCall[0].details).toContain('boss@company.com');
      expect(ticktickCall[0].details).toContain('Q1 Report');
    });
  });

  // ─── Task 5: Success notification ───

  describe('Task 5: success notification via Telegram (AC #3)', () => {
    it('emits notification after successful task creation', async () => {
      setupEmailFetchAndExtraction(FULL_EMAIL_JSON, SINGLE_ACTION_ITEMS);
      mockAgentManager.executeApprovedAction.mockResolvedValueOnce({ success: true });

      await startService();
      await emitEventAsync('email:triage:action-items', { emailId: 'msg-001' });

      const notifications = getEmittedEvents('notification');
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toEqual(
        expect.objectContaining({
          type: 'notification',
          payload: expect.objectContaining({
            title: 'Tasks from Email',
            body: expect.stringContaining('Created 1 task(s)'),
            topicName: 'general',
            actions: expect.arrayContaining([
              expect.objectContaining({ label: 'View Tasks', action: 't:l:' }),
            ]),
          }),
        }),
      );
    });

    it('includes sender and subject in notification body', async () => {
      setupEmailFetchAndExtraction(FULL_EMAIL_JSON, SINGLE_ACTION_ITEMS);
      mockAgentManager.executeApprovedAction.mockResolvedValueOnce({ success: true });

      await startService();
      await emitEventAsync('email:triage:action-items', { emailId: 'msg-001' });

      const notifications = getEmittedEvents('notification');
      const body = (notifications[0] as { payload: { body: string } }).payload.body;
      expect(body).toContain('boss@company.com');
      expect(body).toContain('Q1 Report');
    });

    it('emits email:action-extract:completed event with correct payload', async () => {
      setupEmailFetchAndExtraction(FULL_EMAIL_JSON, MULTI_ACTION_ITEMS);
      mockAgentManager.executeApprovedAction
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ success: true });

      await startService();
      await emitEventAsync('email:triage:action-items', { emailId: 'msg-001' });

      const completedEvents = getEmittedEvents('email:action-extract:completed');
      expect(completedEvents).toHaveLength(1);
      expect(completedEvents[0]).toEqual(
        expect.objectContaining({
          payload: {
            emailId: 'msg-001',
            tasksCreated: 3,
            actionItems: [
              'Send the Q1 report',
              'Schedule review meeting',
              'Prepare presentation slides',
            ],
          },
        }),
      );
    });

    it('does NOT emit notification when all tasks fail (queued for retry)', async () => {
      setupEmailFetchAndExtraction(FULL_EMAIL_JSON, SINGLE_ACTION_ITEMS);
      mockAgentManager.executeApprovedAction.mockResolvedValueOnce({ success: false });

      await startService();
      await emitEventAsync('email:triage:action-items', { emailId: 'msg-001' });

      const notifications = getEmittedEvents('notification');
      expect(notifications).toHaveLength(0);
    });
  });

  // ─── Task 6: Retry queue ───

  describe('Task 6: retry queue for TickTick failures (AC #4)', () => {
    it('retries after backoff period', async () => {
      await startService();

      retryQueue.set('msg-retry', {
        emailId: 'msg-retry',
        items: SINGLE_ACTION_ITEMS,
        emailMeta: { from: 'boss@company.com', subject: 'Q1 Report', date: '2026-03-15' },
        attempts: 1,
        lastAttempt: Date.now() - 120_000, // 2 min ago, past 60s backoff
      });

      mockAgentManager.executeApprovedAction.mockResolvedValueOnce({ success: true });
      await processRetryQueue();

      expect(retryQueue.has('msg-retry')).toBe(false);
      const notifications = getEmittedEvents('notification');
      expect(notifications.length).toBeGreaterThanOrEqual(1);
    });

    it('skips retry if within backoff window', async () => {
      await startService();

      retryQueue.set('msg-recent', {
        emailId: 'msg-recent',
        items: SINGLE_ACTION_ITEMS,
        emailMeta: { from: 'a', subject: 'b', date: '2026-03-15' },
        attempts: 1,
        lastAttempt: Date.now(), // just now — within backoff
      });

      await processRetryQueue();

      expect(retryQueue.has('msg-recent')).toBe(true); // still queued
      expect(mockAgentManager.executeApprovedAction).not.toHaveBeenCalled();
    });

    it('increments attempts on continued failure', async () => {
      await startService();

      retryQueue.set('msg-fail', {
        emailId: 'msg-fail',
        items: SINGLE_ACTION_ITEMS,
        emailMeta: { from: 'a', subject: 'b', date: '2026-03-15' },
        attempts: 1,
        lastAttempt: Date.now() - 120_000,
      });

      mockAgentManager.executeApprovedAction.mockResolvedValueOnce({ success: false });
      await processRetryQueue();

      expect(retryQueue.get('msg-fail')!.attempts).toBe(2);
    });

    it('emits manual review notification after max retries exhausted', async () => {
      await startService();

      retryQueue.set('msg-exhausted', {
        emailId: 'msg-exhausted',
        items: SINGLE_ACTION_ITEMS,
        emailMeta: { from: 'boss@company.com', subject: 'Urgent Report', date: '2026-03-15' },
        attempts: MAX_RETRY_ATTEMPTS, // already at max
        lastAttempt: Date.now() - 120_000,
      });

      await processRetryQueue();

      expect(retryQueue.has('msg-exhausted')).toBe(false);

      const notifications = getEmittedEvents('notification');
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toEqual(
        expect.objectContaining({
          payload: expect.objectContaining({
            title: 'Task Creation Failed',
            body: expect.stringContaining('Please review manually'),
          }),
        }),
      );

      const failedEvents = getEmittedEvents('email:action-extract:failed');
      expect(failedEvents).toHaveLength(1);
      expect(failedEvents[0]).toEqual(
        expect.objectContaining({
          payload: expect.objectContaining({
            emailId: 'msg-exhausted',
            error: expect.stringContaining('Max retry attempts'),
          }),
        }),
      );
    });

    it('removes from queue after successful retry', async () => {
      await startService();

      retryQueue.set('msg-success', {
        emailId: 'msg-success',
        items: SINGLE_ACTION_ITEMS,
        emailMeta: { from: 'a', subject: 'b', date: '2026-03-15' },
        attempts: 2,
        lastAttempt: Date.now() - 120_000,
      });

      mockAgentManager.executeApprovedAction.mockResolvedValueOnce({ success: true });
      await processRetryQueue();

      expect(retryQueue.has('msg-success')).toBe(false);

      const completedEvents = getEmittedEvents('email:action-extract:completed');
      expect(completedEvents).toHaveLength(1);
    });
  });

  // ─── Unit tests for parsers ───

  describe('parseEmailResult', () => {
    it('parses valid email JSON', () => {
      const result = parseEmailResult(JSON.stringify(FULL_EMAIL_JSON));
      expect(result).toBeTruthy();
      expect(result!.from).toBe('boss@company.com');
    });

    it('extracts JSON from mixed text', () => {
      const result = parseEmailResult(`Here is the email: ${JSON.stringify(FULL_EMAIL_JSON)} end.`);
      expect(result).toBeTruthy();
    });

    it('returns null for non-JSON', () => {
      expect(parseEmailResult('no json here')).toBeNull();
    });

    it('returns null for missing required fields', () => {
      expect(parseEmailResult(JSON.stringify({ to: 'x' }))).toBeNull();
    });
  });

  describe('parseActionItems', () => {
    it('parses valid action items array', () => {
      const items = parseActionItems(JSON.stringify(MULTI_ACTION_ITEMS));
      expect(items).toHaveLength(3);
    });

    it('filters out items without titles', () => {
      const items = parseActionItems(JSON.stringify([
        { title: '', priority: 'low', context: 'empty' },
        { title: 'Valid', priority: 'high', context: 'ok' },
      ]));
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe('Valid');
    });

    it('returns empty for non-array', () => {
      expect(parseActionItems('not json')).toEqual([]);
      expect(parseActionItems(JSON.stringify({ items: [] }))).toEqual([]);
    });

    it('extracts JSON array from surrounding text', () => {
      const items = parseActionItems(`Here are the items: ${JSON.stringify(SINGLE_ACTION_ITEMS)} done.`);
      expect(items).toHaveLength(1);
    });

    it('rejects items with invalid priority values', () => {
      const items = parseActionItems(JSON.stringify([
        { title: 'Valid task', priority: 'high', context: 'ok' },
        { title: 'Bad priority', priority: 'super-urgent', context: 'invalid' },
      ]));
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe('Valid task');
    });

    it('rejects items with invalid dueDate format', () => {
      const items = parseActionItems(JSON.stringify([
        { title: 'Good date', dueDate: '2026-03-20', priority: 'medium' },
        { title: 'Bad date', dueDate: 'next Friday', priority: 'medium' },
      ]));
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe('Good date');
    });

    it('defaults missing priority to medium and missing context to empty', () => {
      const items = parseActionItems(JSON.stringify([
        { title: 'Minimal item' },
      ]));
      expect(items).toHaveLength(1);
      expect(items[0].priority).toBe('medium');
      expect(items[0].context).toBe('');
      expect(items[0].dueDate).toBeNull();
    });
  });

  // ─── Edge cases ───

  describe('edge cases', () => {
    it('handles concurrent extraction events', async () => {
      // Use a generic mock that always returns valid email + empty action items
      mockAgentManager.executeApprovedAction.mockImplementation(
        (params: { actionName: string }) => {
          if (params.actionName === 'gmail:get-email') {
            return Promise.resolve({ success: true, result: JSON.stringify(FULL_EMAIL_JSON) });
          }
          // extraction returns empty
          return Promise.resolve({ success: true, result: JSON.stringify([]) });
        },
      );

      await startService();

      // Fire both events concurrently
      await Promise.all([
        emitEventAsync('email:triage:action-items', { emailId: 'msg-001' }),
        emitEventAsync('email:triage:action-items', { emailId: 'msg-002' }),
      ]);

      // Both should complete
      const completedEvents = getEmittedEvents('email:action-extract:completed');
      expect(completedEvents).toHaveLength(2);
    });

    it('does not process when agent manager is unavailable', async () => {
      await service.start({
        eventBus: mockEventBus,
        db: {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        config: {}, // No agent manager
      });

      await emitEventAsync('email:triage:action-items', { emailId: 'msg-001' });
      expect(mockEventBus.emit).not.toHaveBeenCalled();
    });
  });
});
