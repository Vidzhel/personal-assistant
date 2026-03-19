import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock croner before any imports
vi.mock('croner', () => {
  return {
    Cron: class MockCron {
      stop = vi.fn();
    },
  };
});

vi.mock('@raven/shared', async () => {
  const actual = await vi.importActual<typeof import('@raven/shared')>('@raven/shared');
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
vi.mock('../services/engagement-tracker.ts', () => ({
  getEngagementState: () => mockEngagementState,
}));

import { initDatabase, getDb, createDbInterface } from '@raven/core/db/database.ts';
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
    const mod = await import('../services/delivery-scheduler.ts');
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

  function makeNotifEvent(source: string, overrides?: Partial<NotificationEvent['payload']>): NotificationEvent {
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

      // Should NOT be in database
      const rows = db.all('SELECT * FROM notification_queue');
      expect(rows).toHaveLength(0);
    });

    it('always delivers tell-now regardless of producer override', async () => {
      await startService();

      triggerNotification(makeNotifEvent('some:source', {
        urgencyTier: 'red',
        deliveryMode: 'tell-now',
      }));

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
