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

import { initDatabase, getDb, createDbInterface } from '@raven/core/db/database.ts';
import type { DatabaseInterface } from '@raven/shared';

describe('snooze-suggester service', () => {
  let tmpDir: string;
  let db: DatabaseInterface;
  let service: any;
  let emittedEvents: any[];
  let mockEventBus: any;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-snooze-suggest-test-'));
    const dbPath = join(tmpDir, 'test.db');
    initDatabase(dbPath);
    db = createDbInterface();

    emittedEvents = [];
    mockEventBus = {
      emit: vi.fn((event: any) => {
        emittedEvents.push(event);
      }),
      on: vi.fn(),
      off: vi.fn(),
    };

    vi.resetModules();
    const mod = await import('../services/snooze-suggester.ts');
    service = mod;
  });

  afterEach(() => {
    try {
      getDb().close();
    } catch {
      // ignore
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function startService(overrides?: Record<string, unknown>): Promise<void> {
    await service.default.start({
      eventBus: mockEventBus,
      db,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      config: {
        snoozeIgnoreThreshold: 3, // low threshold for testing
        snoozeSuggestionCooldownDays: 7,
        snoozeCheckIntervalMinutes: 30,
        ...overrides,
      },
      projectRoot: tmpDir,
    });
  }

  function seedNotifications(source: string, count: number): void {
    for (let i = 0; i < count; i++) {
      db.run(
        `INSERT INTO notification_queue (id, source, title, body, urgency_tier, delivery_mode, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        `notif-${source}-${i}`,
        source,
        `Test ${i}`,
        'Test body',
        'green',
        'save-for-later',
        'delivered',
        new Date(Date.now() - i * 60_000).toISOString(),
      );
    }
  }

  describe('getIgnoredCategories', () => {
    it('detects categories with no engagement responses', async () => {
      await startService();
      seedNotifications('pipeline:complete', 5);

      const ignored = service.getIgnoredCategories();
      expect(ignored.length).toBe(1);
      expect(ignored[0].sourcePrefix).toBe('pipeline');
      expect(ignored[0].respondedCount).toBe(0);
    });

    it('excludes categories where user has responded', async () => {
      await startService();
      seedNotifications('pipeline:complete', 5);

      // Add engagement response for one of the notification IDs
      db.run(
        `INSERT INTO engagement_metrics (id, event_type, notification_id, created_at)
         VALUES (?, ?, ?, ?)`,
        'eng-1',
        'user_response',
        'notif-pipeline:complete-0',
        new Date().toISOString(),
      );

      const ignored = service.getIgnoredCategories();
      expect(ignored.length).toBe(0);
    });

    it('skips unsnoozable sources like permission:blocked', async () => {
      await startService();
      seedNotifications('permission:blocked', 5);

      const ignored = service.getIgnoredCategories();
      expect(ignored.length).toBe(0);
    });

    it('skips sources below the ignore threshold', async () => {
      await startService();
      seedNotifications('pipeline:complete', 2); // below threshold of 3

      const ignored = service.getIgnoredCategories();
      expect(ignored.length).toBe(0);
    });
  });

  describe('checkForIgnoredCategories', () => {
    it('emits notification and snooze proposal for ignored categories', async () => {
      await startService();
      seedNotifications('pipeline:complete', 5);

      service.checkForIgnoredCategories();

      // Should emit: 1 notification event + 1 snooze proposal event
      expect(emittedEvents.length).toBe(2);
      expect(emittedEvents[0].type).toBe('notification');
      expect(emittedEvents[0].source).toBe('system:snooze-suggestion');
      expect(emittedEvents[0].payload.title).toBe('Quiet category detected');
      expect(emittedEvents[0].payload.body).toContain('pipeline status');
      expect(emittedEvents[0].payload.actions).toHaveLength(3);

      expect(emittedEvents[1].type).toBe('notification:snooze-proposal');
      expect(emittedEvents[1].payload.category).toBe('pipeline:*');
    });

    it('respects suggestion cooldown — does not re-suggest within 7 days', async () => {
      await startService();
      seedNotifications('pipeline:complete', 5);

      // First check — should suggest
      service.checkForIgnoredCategories();
      expect(emittedEvents.length).toBe(2);

      // Clear emitted events
      emittedEvents.length = 0;

      // Second check — should NOT suggest again (cooldown)
      service.checkForIgnoredCategories();
      expect(emittedEvents.length).toBe(0);
    });

    it('skips categories that are already snoozed', async () => {
      await startService();
      seedNotifications('pipeline:complete', 5);

      // Create an existing snooze for pipeline:*
      db.run(
        `INSERT INTO notification_snooze (id, category, snoozed_until, held_count, created_at)
         VALUES (?, ?, ?, 0, ?)`,
        'existing-snooze',
        'pipeline:*',
        new Date(Date.now() + 86_400_000).toISOString(),
        new Date().toISOString(),
      );

      service.checkForIgnoredCategories();
      expect(emittedEvents.length).toBe(0);
    });

    it('does not suggest for system:health:alert', async () => {
      await startService();
      seedNotifications('system:health:alert', 5);

      service.checkForIgnoredCategories();
      expect(emittedEvents.length).toBe(0);
    });
  });

  describe('buildSnoozeCategory', () => {
    it('maps known prefixes to wildcard patterns', () => {
      expect(service.buildSnoozeCategory('pipeline')).toBe('pipeline:*');
      expect(service.buildSnoozeCategory('email')).toBe('email:triage:*');
      expect(service.buildSnoozeCategory('agent')).toBe('agent:task:complete');
      expect(service.buildSnoozeCategory('insight')).toBe('insight:*');
      expect(service.buildSnoozeCategory('schedule')).toBe('schedule:triggered');
    });

    it('falls back to prefix:* for unknown prefixes', () => {
      expect(service.buildSnoozeCategory('custom')).toBe('custom:*');
    });
  });

  describe('getCategoryPrefix', () => {
    it('extracts first segment before colon', () => {
      expect(service.getCategoryPrefix('pipeline:complete')).toBe('pipeline');
      expect(service.getCategoryPrefix('email:triage:summary')).toBe('email');
    });

    it('returns full string if no colon', () => {
      expect(service.getCategoryPrefix('standalone')).toBe('standalone');
    });
  });
});
