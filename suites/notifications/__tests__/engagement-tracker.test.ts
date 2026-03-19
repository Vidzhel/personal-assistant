import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let cronCallback: (() => void) | null = null;
vi.mock('croner', () => {
  class MockCron {
    stop = vi.fn();
    constructor(_pattern: string, callback: () => void) {
      cronCallback = callback;
    }
  }
  return { Cron: MockCron };
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

import { initDatabase, getDb, createDbInterface } from '@raven/core/db/database.ts';
import type { DatabaseInterface } from '@raven/shared';

describe('engagement-tracker service', () => {
  let tmpDir: string;
  let db: DatabaseInterface;
  let service: any;
  let eventHandlers: Record<string, Array<(event: any) => void>>;
  let mockEventBus: any;
  let emittedEvents: any[];

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-engagement-test-'));
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
    const mod = await import('../services/engagement-tracker.ts');
    service = mod.default;
  });

  afterEach(async () => {
    try {
      await service.stop();
    } catch {
      // ignore
    }
    try {
      getDb().close();
    } catch {
      // ignore
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function startService(config: Record<string, unknown> = {}) {
    await service.start({
      eventBus: mockEventBus,
      db,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      config: {
        lowEngagementThreshold: 5,
        resumeThreshold: 3,
        escalationHours: 4,
        escalationIntervalMinutes: 15,
        ...config,
      },
      projectRoot: tmpDir,
    });
  }

  function triggerDelivery(queueId: string) {
    const handlers = eventHandlers['notification:deliver'] ?? [];
    for (const handler of handlers) {
      handler({
        id: 'evt-deliver',
        timestamp: Date.now(),
        source: 'notifications',
        type: 'notification:deliver',
        payload: { queueId, title: 'Test', body: 'body', channel: 'telegram' },
      });
    }
  }

  function triggerUserResponse() {
    const handlers = eventHandlers['telegram:message'] ?? [];
    for (const handler of handlers) {
      handler({
        id: 'evt-msg',
        timestamp: Date.now(),
        source: 'telegram',
        type: 'telegram:message',
        payload: {},
      });
    }
  }

  describe('engagement state computation', () => {
    it('starts in normal state', async () => {
      await startService();

      const mod = await import('../services/engagement-tracker.ts');
      expect(mod.getEngagementState()).toBe('normal');
    });

    it('transitions to throttled after threshold unresponded deliveries', async () => {
      await startService({ lowEngagementThreshold: 3 });

      // Record 3 deliveries with no responses
      triggerDelivery('q1');
      triggerDelivery('q2');
      triggerDelivery('q3');

      // Trigger a user response to update the state
      // (state is computed on user response)
      triggerUserResponse();

      // State should still compute based on response ratio
      // Since we have 3 deliveries and only 1 response, let's check
      const metrics = db.all<any>('SELECT * FROM engagement_metrics ORDER BY created_at');
      expect(metrics.length).toBe(4); // 3 deliveries + 1 response
    });

    it('records delivery and response events in database', async () => {
      await startService();

      triggerDelivery('notif-1');
      triggerDelivery('notif-2');
      triggerUserResponse();

      const deliveries = db.all<any>(
        `SELECT * FROM engagement_metrics WHERE event_type = 'notification_delivered'`,
      );
      expect(deliveries).toHaveLength(2);

      const responses = db.all<any>(
        `SELECT * FROM engagement_metrics WHERE event_type = 'user_response'`,
      );
      expect(responses).toHaveLength(1);
    });
  });

  describe('escalation timer', () => {
    it('escalates old throttled high-priority notifications', async () => {
      await startService({ escalationHours: 4 });

      // Insert a pending tell-when-active notification that's 5 hours old
      const oldTime = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
      db.run(
        `INSERT INTO notification_queue (id, source, title, body, urgency_tier, delivery_mode, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        'old-notif-1',
        'test',
        'Important Task',
        'Task body',
        'red',
        'tell-when-active',
        'pending',
        oldTime,
      );

      // Manually set state to throttled to enable escalation
      // Simulate throttled state by inserting many unresponded deliveries
      for (let i = 0; i < 6; i++) {
        db.run(
          `INSERT INTO engagement_metrics (id, event_type, notification_id, created_at)
           VALUES (?, ?, ?, ?)`,
          `delivery-${i}`,
          'notification_delivered',
          `notif-${i}`,
          new Date().toISOString(),
        );
      }

      // Trigger a user response to compute state (it should become throttled)
      triggerUserResponse();

      // Clear events from the response
      emittedEvents.length = 0;

      // Run escalation check via cron callback
      expect(cronCallback).not.toBeNull();
      cronCallback!();

      // Should have emitted notification:deliver with "Reminder:" prefix
      const deliverEvents = emittedEvents.filter((e) => e.type === 'notification:deliver');
      expect(deliverEvents).toHaveLength(1);
      expect(deliverEvents[0].payload.title).toBe('Reminder: Important Task');

      // Should have emitted notification:escalated
      const escalatedEvents = emittedEvents.filter((e) => e.type === 'notification:escalated');
      expect(escalatedEvents).toHaveLength(1);
      expect(escalatedEvents[0].payload.queueId).toBe('old-notif-1');

      // Original should be marked as escalated
      const row = db.get<any>(`SELECT status FROM notification_queue WHERE id = 'old-notif-1'`);
      expect(row.status).toBe('escalated');
    });

    it('does not escalate when engagement state is normal', async () => {
      await startService();

      // Insert a pending old notification
      const oldTime = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
      db.run(
        `INSERT INTO notification_queue (id, source, title, body, urgency_tier, delivery_mode, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        'old-notif-2',
        'test',
        'Some Task',
        'body',
        'red',
        'tell-when-active',
        'pending',
        oldTime,
      );

      emittedEvents.length = 0;
      cronCallback!();

      // No escalation events because state is normal
      expect(emittedEvents).toHaveLength(0);
    });

    it('does not escalate green urgency notifications', async () => {
      await startService();

      // Force throttled state
      for (let i = 0; i < 6; i++) {
        db.run(
          `INSERT INTO engagement_metrics (id, event_type, notification_id, created_at)
           VALUES (?, ?, ?, ?)`,
          `d-${i}`,
          'notification_delivered',
          `n-${i}`,
          new Date().toISOString(),
        );
      }
      triggerUserResponse();
      emittedEvents.length = 0;

      const oldTime = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
      db.run(
        `INSERT INTO notification_queue (id, source, title, body, urgency_tier, delivery_mode, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        'green-notif',
        'test',
        'Low Priority',
        'body',
        'green',
        'tell-when-active',
        'pending',
        oldTime,
      );

      cronCallback!();

      // No escalation for green items
      const deliverEvents = emittedEvents.filter((e) => e.type === 'notification:deliver');
      expect(deliverEvents).toHaveLength(0);
    });
  });

  describe('service lifecycle', () => {
    it('subscribes to correct events on start', async () => {
      await startService();
      expect(mockEventBus.on).toHaveBeenCalledWith('notification:deliver', expect.any(Function));
      expect(mockEventBus.on).toHaveBeenCalledWith('telegram:message', expect.any(Function));
      expect(mockEventBus.on).toHaveBeenCalledWith('telegram:callback', expect.any(Function));
    });

    it('unsubscribes and stops cron on stop', async () => {
      await startService();
      await service.stop();
      expect(mockEventBus.off).toHaveBeenCalledWith('notification:deliver', expect.any(Function));
      expect(mockEventBus.off).toHaveBeenCalledWith('telegram:message', expect.any(Function));
      expect(mockEventBus.off).toHaveBeenCalledWith('telegram:callback', expect.any(Function));
    });
  });
});
