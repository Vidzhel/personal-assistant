import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, getDb, createDbInterface } from '../db/database.ts';
import {
  enqueueNotification,
  getReadyNotifications,
  getPendingBatched,
  markDelivered,
  markBatched,
} from '../notification-engine/notification-queue.ts';
import type { DatabaseInterface } from '@raven/shared';

describe('notification-queue', () => {
  let tmpDir: string;
  let db: DatabaseInterface;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-notif-queue-test-'));
    const dbPath = join(tmpDir, 'test.db');
    initDatabase(dbPath);
    db = createDbInterface();
  });

  afterEach(() => {
    try {
      getDb().close();
    } catch {
      // ignore
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('enqueueNotification', () => {
    it('inserts a notification and returns an id', () => {
      const id = enqueueNotification(db, {
        source: 'test-source',
        title: 'Test Title',
        body: 'Test Body',
        urgencyTier: 'yellow',
        deliveryMode: 'tell-when-active',
        status: 'pending',
        scheduledFor: '2026-03-19T07:00:00Z',
      });

      expect(id).toBeTruthy();

      const row = db.get<any>('SELECT * FROM notification_queue WHERE id = ?', id);
      expect(row).toBeTruthy();
      expect(row.title).toBe('Test Title');
      expect(row.urgency_tier).toBe('yellow');
      expect(row.delivery_mode).toBe('tell-when-active');
      expect(row.status).toBe('pending');
    });

    it('stores optional fields when provided', () => {
      const id = enqueueNotification(db, {
        source: 'test',
        title: 'T',
        body: 'B',
        topicName: 'General',
        actionsJson: JSON.stringify([{ label: 'OK', action: 'ok' }]),
        urgencyTier: 'green',
        deliveryMode: 'save-for-later',
        status: 'batched',
      });

      const row = db.get<any>('SELECT * FROM notification_queue WHERE id = ?', id);
      expect(row.topic_name).toBe('General');
      expect(row.actions_json).toContain('OK');
      expect(row.status).toBe('batched');
    });
  });

  describe('getReadyNotifications', () => {
    it('returns tell-when-active items with scheduled_for <= now and status pending', () => {
      enqueueNotification(db, {
        source: 'src1',
        title: 'Ready',
        body: 'Ready body',
        urgencyTier: 'yellow',
        deliveryMode: 'tell-when-active',
        status: 'pending',
        scheduledFor: '2026-03-19T06:00:00Z',
      });

      enqueueNotification(db, {
        source: 'src2',
        title: 'Future',
        body: 'Future body',
        urgencyTier: 'yellow',
        deliveryMode: 'tell-when-active',
        status: 'pending',
        scheduledFor: '2026-03-20T06:00:00Z',
      });

      // Batched items should NOT appear
      enqueueNotification(db, {
        source: 'src3',
        title: 'Batched',
        body: 'Batched body',
        urgencyTier: 'green',
        deliveryMode: 'save-for-later',
        status: 'batched',
      });

      const ready = getReadyNotifications(db, '2026-03-19T08:00:00Z');
      expect(ready).toHaveLength(1);
      expect(ready[0].title).toBe('Ready');
    });

    it('returns empty when no items are ready', () => {
      const ready = getReadyNotifications(db, '2026-03-19T08:00:00Z');
      expect(ready).toHaveLength(0);
    });
  });

  describe('getPendingBatched', () => {
    it('returns items with status batched and delivery_mode save-for-later', () => {
      enqueueNotification(db, {
        source: 'src1',
        title: 'Batched 1',
        body: 'B1',
        urgencyTier: 'green',
        deliveryMode: 'save-for-later',
        status: 'batched',
      });

      enqueueNotification(db, {
        source: 'src2',
        title: 'Pending',
        body: 'P1',
        urgencyTier: 'yellow',
        deliveryMode: 'tell-when-active',
        status: 'pending',
        scheduledFor: '2026-03-19T07:00:00Z',
      });

      const batched = getPendingBatched(db);
      expect(batched).toHaveLength(1);
      expect(batched[0].title).toBe('Batched 1');
    });
  });

  describe('markDelivered', () => {
    it('updates status to delivered and sets delivered_at', () => {
      const id = enqueueNotification(db, {
        source: 'src',
        title: 'T',
        body: 'B',
        urgencyTier: 'yellow',
        deliveryMode: 'tell-when-active',
        status: 'pending',
        scheduledFor: '2026-03-19T07:00:00Z',
      });

      markDelivered(db, id);

      const row = db.get<any>('SELECT * FROM notification_queue WHERE id = ?', id);
      expect(row.status).toBe('delivered');
      expect(row.delivered_at).toBeTruthy();
    });
  });

  describe('markBatched', () => {
    it('marks multiple batched items as delivered', () => {
      const id1 = enqueueNotification(db, {
        source: 's1',
        title: 'B1',
        body: 'B1',
        urgencyTier: 'green',
        deliveryMode: 'save-for-later',
        status: 'batched',
      });

      const id2 = enqueueNotification(db, {
        source: 's2',
        title: 'B2',
        body: 'B2',
        urgencyTier: 'green',
        deliveryMode: 'save-for-later',
        status: 'batched',
      });

      markBatched(db, [id1, id2]);

      const r1 = db.get<any>('SELECT * FROM notification_queue WHERE id = ?', id1);
      const r2 = db.get<any>('SELECT * FROM notification_queue WHERE id = ?', id2);
      expect(r1.status).toBe('delivered');
      expect(r2.status).toBe('delivered');
    });

    it('does not modify non-batched items', () => {
      const id = enqueueNotification(db, {
        source: 'src',
        title: 'P',
        body: 'P',
        urgencyTier: 'yellow',
        deliveryMode: 'tell-when-active',
        status: 'pending',
        scheduledFor: '2026-03-19T07:00:00Z',
      });

      markBatched(db, [id]);

      const row = db.get<any>('SELECT * FROM notification_queue WHERE id = ?', id);
      expect(row.status).toBe('pending');
    });
  });
});
