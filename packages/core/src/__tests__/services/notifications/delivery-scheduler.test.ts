import type * as RavenShared from '@raven/shared';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const cronState = vi.hoisted(() => ({
  callback: undefined as (() => void) | undefined,
}));

// Mock croner before any imports
vi.mock('croner', () => {
  return {
    Cron: class MockCron {
      stop = vi.fn();

      constructor(_expression: string, _options: unknown, callback: () => void) {
        cronState.callback = callback;
      }
    },
  };
});

vi.mock('@raven/shared', async () => {
  const actual = await vi.importActual<typeof RavenShared>('@raven/shared');
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };
});

let mockEngagementState = 'normal';
vi.mock('../../../services/notifications/engagement-tracker.ts', () => ({
  getEngagementState: () => mockEngagementState,
}));

import { initDatabase, getDb, createDbInterface } from '../../../db/database.ts';
import { createSnooze } from '../../../notification-engine/snooze-store.ts';
import type { DatabaseInterface, NotificationEvent } from '@raven/shared';

describe('delivery-scheduler service', () => {
  let tmpDir: string;
  let db: DatabaseInterface;
  let service: any;
  let eventHandlers: Record<string, Array<(event: any) => void>>;
  let mockEventBus: any;
  let emittedEvents: any[];

  beforeEach(async () => {
    mockEngagementState = 'normal';
    cronState.callback = undefined;
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-delivery-test-'));
    const dbPath = join(tmpDir, 'test.db');
    initDatabase(dbPath);
    db = createDbInterface();

    emittedEvents = [];
    eventHandlers = {};
    mockEventBus = {
      emit: vi.fn((event: any) => {
        emittedEvents.push(event);
      }),
      on: vi.fn((type: string, handler: any) => {
        if (!eventHandlers[type]) eventHandlers[type] = [];
        eventHandlers[type].push(handler);
      }),
      off: vi.fn(),
    };

    vi.resetModules();
    const mod = await import('../../../services/notifications/delivery-scheduler.ts');
    service = mod.default;
  });

  afterEach(() => {
    try {
      getDb().close();
    } catch {
      // ignore
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function startService() {
    await service.start({
      eventBus: mockEventBus,
      db,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      config: {
        activeHours: { start: '07:00', end: '23:00', timezone: 'America/New_York' },
        flushIntervalMinutes: 5,
      },
      projectRoot: tmpDir, // no notification-rules.json → defaults used
    });
  }

  function triggerNotification(event: NotificationEvent) {
    const handlers = eventHandlers['notification'] ?? [];
    for (const handler of handlers) {
      handler(event);
    }
  }

  function makeNotifEvent(
    source: string,
    overrides?: Partial<NotificationEvent['payload']>,
  ): NotificationEvent {
    return {
      id: 'test-id',
      timestamp: Date.now(),
      source,
      type: 'notification',
      payload: {
        channel: 'telegram',
        title: 'Test Notification',
        body: 'Test body content',
        ...overrides,
      },
    };
  }

  describe('tell-now events', () => {
    it('passes through immediately as notification:deliver', async () => {
      await startService();

      triggerNotification(makeNotifEvent('permission:blocked'));

      expect(emittedEvents.length).toBe(1);
      expect(emittedEvents[0].type).toBe('notification:deliver');
      expect(emittedEvents[0].payload.title).toBe('Test Notification');

      // Immediate Telegram sends are admitted durably before provider delivery.
      const rows = db.all<{ id: string }>('SELECT * FROM notification_queue');
      expect(rows).toHaveLength(1);
      expect(emittedEvents[0].payload.queueId).toBe(rows[0].id);
    });

    it('always delivers tell-now regardless of producer override', async () => {
      await startService();

      triggerNotification(
        makeNotifEvent('some:source', {
          urgencyTier: 'red',
          deliveryMode: 'tell-now',
        }),
      );

      expect(emittedEvents.length).toBe(1);
      expect(emittedEvents[0].type).toBe('notification:deliver');
    });
  });

  describe('tell-when-active events', () => {
    it('queues the notification and emits notification:queued', async () => {
      await startService();

      triggerNotification(makeNotifEvent('agent:task:complete'));

      // Should emit notification:queued
      expect(emittedEvents.length).toBe(1);
      expect(emittedEvents[0].type).toBe('notification:queued');
      expect(emittedEvents[0].payload.urgencyTier).toBe('yellow');
      expect(emittedEvents[0].payload.deliveryMode).toBe('tell-when-active');

      // Should be in database
      const rows = db.all<any>('SELECT * FROM notification_queue');
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('pending');
      expect(rows[0].delivery_mode).toBe('tell-when-active');
    });
  });

  describe('save-for-later events', () => {
    it('enqueues as batched and emits notification:batched', async () => {
      await startService();

      triggerNotification(makeNotifEvent('pipeline:complete'));

      expect(emittedEvents.length).toBe(1);
      expect(emittedEvents[0].type).toBe('notification:batched');
      expect(emittedEvents[0].payload.urgencyTier).toBe('green');

      const rows = db.all<any>('SELECT * FROM notification_queue');
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('batched');
      expect(rows[0].delivery_mode).toBe('save-for-later');
    });
  });

  describe('throttling behavior', () => {
    it('batches tell-when-active notifications when engagement is throttled', async () => {
      mockEngagementState = 'throttled';
      await startService();

      triggerNotification(makeNotifEvent('agent:task:complete'));

      // Should be batched instead of queued as tell-when-active
      expect(emittedEvents.length).toBe(1);
      expect(emittedEvents[0].type).toBe('notification:batched');

      const rows = db.all<any>('SELECT * FROM notification_queue');
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('batched');
      expect(rows[0].delivery_mode).toBe('save-for-later');
    });

    it('always passes tell-now through regardless of engagement state', async () => {
      mockEngagementState = 'throttled';
      await startService();

      triggerNotification(makeNotifEvent('permission:blocked'));

      expect(emittedEvents.length).toBe(1);
      expect(emittedEvents[0].type).toBe('notification:deliver');
      expect(emittedEvents[0].payload.title).toBe('Test Notification');
    });

    it('delivers normally when engagement is normal', async () => {
      mockEngagementState = 'normal';
      await startService();

      triggerNotification(makeNotifEvent('agent:task:complete'));

      // tell-when-active → queued (not batched)
      expect(emittedEvents.length).toBe(1);
      expect(emittedEvents[0].type).toBe('notification:queued');
    });
  });

  describe('snooze integration', () => {
    it('snoozed category notifications are held and not delivered', async () => {
      await startService();
      createSnooze(db, { category: 'pipeline:*', duration: '1d' });

      triggerNotification(makeNotifEvent('pipeline:complete'));

      // Should emit notification:snoozed, not deliver/queued/batched
      expect(emittedEvents.length).toBe(1);
      expect(emittedEvents[0].type).toBe('notification:snoozed');
      expect(emittedEvents[0].payload.category).toBe('pipeline:*');

      const rows = db.all<any>('SELECT * FROM notification_queue');
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('snoozed');
    });

    it('permission:blocked ALWAYS bypasses snooze (safety override)', async () => {
      await startService();
      // Even if someone creates a snooze for permission:blocked (shouldn't happen, but safety)
      createSnooze(db, { category: 'permission:blocked', duration: '1d' });

      triggerNotification(makeNotifEvent('permission:blocked'));

      // Should deliver immediately, NOT be snoozed
      expect(emittedEvents.length).toBe(1);
      expect(emittedEvents[0].type).toBe('notification:deliver');
    });

    it('system:health:alert ALWAYS bypasses snooze', async () => {
      await startService();
      createSnooze(db, { category: 'system:health:alert', duration: '1d' });

      triggerNotification(makeNotifEvent('system:health:alert'));

      expect(emittedEvents.length).toBe(1);
      expect(emittedEvents[0].type).toBe('notification:deliver');
    });

    it('increments held_count on snooze record', async () => {
      await startService();
      const snoozeRecord = createSnooze(db, { category: 'pipeline:*', duration: '1d' });

      triggerNotification(makeNotifEvent('pipeline:complete'));
      triggerNotification(makeNotifEvent('pipeline:failed'));

      const row = db.get<any>(
        'SELECT held_count FROM notification_snooze WHERE id = ?',
        snoozeRecord.id,
      );
      expect(row.held_count).toBe(2);
    });

    it('non-snoozed categories proceed through normal flow', async () => {
      await startService();
      createSnooze(db, { category: 'pipeline:*', duration: '1d' });

      // email:triage is NOT snoozed
      triggerNotification(makeNotifEvent('email:triage:summary'));

      expect(emittedEvents.length).toBe(1);
      expect(emittedEvents[0].type).toBe('notification:batched');
    });

    it('flushes deferred and released snoozed notifications with exact reply context', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-07T14:00:00.000Z'));
      try {
        await startService();
        expect(cronState.callback).toBeTypeOf('function');

        const deferredOrigin = {
          transport: 'telegram' as const,
          chatId: '-1001234567890',
          topicId: 7,
          messageId: 2001,
        };
        triggerNotification(
          makeNotifEvent('agent:task:complete', {
            destination: { kind: 'project', projectId: 'project-one' },
            transportOrigin: deferredOrigin,
            sessionId: 'deferred-session',
            taskId: 'deferred-task',
          }),
        );

        const snooze = createSnooze(db, { category: 'pipeline:*', duration: '1h' });
        const snoozedOrigin = {
          transport: 'telegram' as const,
          chatId: '-1001234567890',
          topicId: 8,
          messageId: 2002,
        };
        triggerNotification(
          makeNotifEvent('pipeline:complete', {
            destination: { kind: 'project', projectId: 'project-two' },
            transportOrigin: snoozedOrigin,
            sessionId: 'snoozed-session',
            taskId: 'snoozed-task',
            urgencyTier: 'yellow',
            deliveryMode: 'tell-when-active',
          }),
        );
        db.run(
          'UPDATE notification_snooze SET snoozed_until = ? WHERE id = ?',
          new Date().toISOString(),
          snooze.id,
        );
        emittedEvents.length = 0;

        cronState.callback!();

        const deliveries = emittedEvents.filter((event) => event.type === 'notification:deliver');
        expect(deliveries).toHaveLength(2);
        expect(
          deliveries.find((event) => event.payload.taskId === 'deferred-task')?.payload,
        ).toMatchObject({
          destination: { kind: 'project', projectId: 'project-one' },
          transportOrigin: deferredOrigin,
          sessionId: 'deferred-session',
          taskId: 'deferred-task',
          queueId: expect.any(String),
        });
        expect(
          deliveries.find((event) => event.payload.taskId === 'snoozed-task')?.payload,
        ).toMatchObject({
          destination: { kind: 'project', projectId: 'project-two' },
          transportOrigin: snoozedOrigin,
          sessionId: 'snoozed-session',
          taskId: 'snoozed-task',
          queueId: expect.any(String),
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('service lifecycle', () => {
    it('subscribes to notification event on start', async () => {
      await startService();
      expect(mockEventBus.on).toHaveBeenCalledWith('notification', expect.any(Function));
    });

    it('unsubscribes and stops cron on stop', async () => {
      await startService();
      await service.stop();
      expect(mockEventBus.off).toHaveBeenCalledWith('notification', expect.any(Function));
    });
  });
});
