import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, getDb, createDbInterface } from '../db/database.ts';
import {
  enqueueNotification,
  getReadyNotifications,
  releaseSnoozed,
  queuedReplyContext,
  getPendingBatched,
  markDelivered,
  markIncludedInBriefing,
  beginDeliveryAttempt,
  claimNotificationDelivery,
  finishDeliveryAttempt,
  listDeliveryDiagnostics,
  markDeliveryOutcome,
  reconcileInterruptedDeliveries,
  getAcceptedTelegramRepliesMissingBinding,
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

  it.each(['tell-now', 'tell-when-active', 'save-for-later'] as const)(
    'releases snoozed %s work to a consumer with its original reply context',
    (deliveryMode) => {
      const origin = { transport: 'telegram' as const, chatId: '-123', topicId: 42, messageId: 91 };
      const id = enqueueNotification(db, {
        source: 'retrospective',
        title: 'Complete',
        body: 'Summary',
        channel: 'telegram',
        destination: { kind: 'project', projectId: 'course' },
        transportOrigin: origin,
        sessionId: 'session-original',
        taskId: 'task-original',
        urgencyTier: 'green',
        deliveryMode,
        status: 'snoozed',
      });
      releaseSnoozed(db, [id]);
      const available =
        deliveryMode === 'save-for-later'
          ? getPendingBatched(db)
          : getReadyNotifications(db, new Date(Date.now() + 1000).toISOString());
      expect(available.map((item) => item.id)).toEqual([id]);
      expect(queuedReplyContext(available[0])).toEqual({
        transportOrigin: origin,
        sessionId: 'session-original',
        taskId: 'task-original',
      });
    },
  );

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

  describe('markIncludedInBriefing', () => {
    it('marks multiple batched items included without claiming provider delivery', () => {
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

      markIncludedInBriefing(db, [id1, id2]);

      const r1 = db.get<any>('SELECT * FROM notification_queue WHERE id = ?', id1);
      const r2 = db.get<any>('SELECT * FROM notification_queue WHERE id = ?', id2);
      expect(r1.status).toBe('included');
      expect(r2.status).toBe('included');
      expect(r1.delivered_at).toBeNull();
      expect(r2.delivered_at).toBeNull();
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

      markIncludedInBriefing(db, [id]);

      const row = db.get<any>('SELECT * FROM notification_queue WHERE id = ?', id);
      expect(row.status).toBe('pending');
    });
  });

  describe('durable delivery evidence', () => {
    function enqueueProjectDelivery(dedupeKey = 'task:one'): string {
      return enqueueNotification(db, {
        source: 'agent-result',
        title: 'Raven',
        body: 'Done',
        channel: 'telegram',
        destination: { kind: 'project', projectId: 'project-one' },
        urgencyTier: 'green',
        deliveryMode: 'tell-now',
        status: 'pending',
        dedupeKey,
      });
    }

    it('deduplicates a logical delivery and allows only one active claim', () => {
      const firstId = enqueueProjectDelivery();
      expect(enqueueProjectDelivery()).toBe(firstId);
      expect(
        db.get<{ count: number }>('SELECT COUNT(*) AS count FROM notification_queue')?.count,
      ).toBe(1);

      const claimId = claimNotificationDelivery(db, firstId);
      expect(claimId).toBeTruthy();
      expect(claimNotificationDelivery(db, firstId)).toBeUndefined();
      expect(claimNotificationDelivery(db, firstId)).toBeUndefined();
    });

    it('records an attempt before acceptance and exposes destination/provider evidence', () => {
      const id = enqueueProjectDelivery();
      const claimId = claimNotificationDelivery(db, id);
      expect(claimId).toBeTruthy();
      const attempt = beginDeliveryAttempt(db, {
        notificationId: id,
        claimId: claimId!,
        channel: 'telegram',
        part: 'text',
        chatId: '-1001',
        topicId: 7,
      });

      expect(
        db.get<{ outcome: string }>(
          'SELECT outcome FROM notification_delivery_attempts WHERE id = ?',
          attempt.id,
        ),
      ).toEqual({ outcome: 'sending' });

      finishDeliveryAttempt(db, attempt.id, {
        outcome: 'accepted',
        providerMessageId: '991',
      });
      markDeliveryOutcome(db, { id, outcome: 'delivered' });

      expect(listDeliveryDiagnostics(db, 1)[0]).toMatchObject({
        id,
        status: 'delivered',
        destinationKind: 'project',
        destinationProjectId: 'project-one',
        attemptCount: 1,
        providerMessageId: '991',
        lastError: null,
      });
    });

    it('preserves accepted provider evidence when an attachment makes delivery partial', () => {
      const id = enqueueProjectDelivery();
      const claimId = claimNotificationDelivery(db, id)!;
      const text = beginDeliveryAttempt(db, {
        notificationId: id,
        claimId,
        channel: 'telegram',
        part: 'text',
        chatId: '-1001',
      });
      finishDeliveryAttempt(db, text.id, {
        outcome: 'accepted',
        providerMessageId: 'text-accepted',
      });
      const attachment = beginDeliveryAttempt(db, {
        notificationId: id,
        claimId,
        channel: 'telegram',
        part: 'attachment',
        chatId: '-1001',
      });
      finishDeliveryAttempt(db, attachment.id, {
        outcome: 'failed',
        error: 'attachment rejected',
      });
      markDeliveryOutcome(db, { id, outcome: 'partial', error: 'attachment rejected' });

      expect(listDeliveryDiagnostics(db, 1)[0]).toMatchObject({
        status: 'partial',
        providerMessageId: 'text-accepted',
        lastError: 'attachment rejected',
        attemptCount: 2,
      });
    });

    it('marks interrupted provider calls unknown and never makes them ready to retry', () => {
      const id = enqueueProjectDelivery();
      const claimId = claimNotificationDelivery(db, id)!;
      beginDeliveryAttempt(db, {
        notificationId: id,
        claimId,
        channel: 'telegram',
        part: 'text',
        chatId: '-1001',
      });

      reconcileInterruptedDeliveries(db);

      expect(listDeliveryDiagnostics(db, 1)[0]).toMatchObject({
        status: 'unknown',
        attemptCount: 1,
        lastError: 'Delivery interrupted before provider outcome was recorded',
      });
      expect(getReadyNotifications(db, '2999-01-01T00:00:00Z')).toEqual([]);
      expect(claimNotificationDelivery(db, id)).toBeUndefined();
    });

    it('reconciles accepted provider evidence instead of downgrading it to unknown', () => {
      const id = enqueueProjectDelivery();
      const claimId = claimNotificationDelivery(db, id)!;
      const attempt = beginDeliveryAttempt(db, {
        notificationId: id,
        claimId,
        channel: 'telegram',
        part: 'text',
        chatId: '-1001',
      });
      finishDeliveryAttempt(db, attempt.id, {
        outcome: 'accepted',
        providerMessageId: '817',
      });

      reconcileInterruptedDeliveries(db);

      expect(listDeliveryDiagnostics(db, 1)[0]).toMatchObject({
        status: 'delivered',
        providerMessageId: '817',
        lastError: null,
      });
    });

    it('returns an unattempted interrupted claim to pending without replaying attempted work', () => {
      const id = enqueueProjectDelivery();
      expect(claimNotificationDelivery(db, id)).toBeTruthy();

      reconcileInterruptedDeliveries(db);

      expect(listDeliveryDiagnostics(db, 1)[0]).toMatchObject({ status: 'pending' });
      expect(claimNotificationDelivery(db, id)).toBeTruthy();
    });

    it('finds an accepted chat reply whose durable message binding was interrupted', () => {
      const id = enqueueNotification(db, {
        source: 'telegram-chat-result',
        title: 'Raven',
        body: 'Done',
        channel: 'telegram',
        destination: { kind: 'project', projectId: 'project-one' },
        urgencyTier: 'green',
        deliveryMode: 'tell-now',
        status: 'pending',
        transportOrigin: { transport: 'telegram', chatId: '-1001', topicId: 7, messageId: 41 },
        sessionId: 'session-one',
        taskId: 'task-one',
      });
      const claimId = claimNotificationDelivery(db, id)!;
      const attempt = beginDeliveryAttempt(db, {
        notificationId: id,
        claimId,
        channel: 'telegram',
        part: 'text',
        chatId: '-1001',
        topicId: 7,
      });
      finishDeliveryAttempt(db, attempt.id, {
        outcome: 'accepted',
        providerMessageId: '818',
      });

      expect(getAcceptedTelegramRepliesMissingBinding(db)).toEqual([
        {
          chatId: '-1001',
          topicId: 7,
          messageId: 818,
          projectId: 'project-one',
          sessionId: 'session-one',
          taskId: 'task-one',
        },
      ]);
    });

    it('rejects attempt recording without the active claim', () => {
      const id = enqueueProjectDelivery();
      const claimId = claimNotificationDelivery(db, id)!;
      expect(() =>
        beginDeliveryAttempt(db, {
          notificationId: id,
          claimId: `${claimId}-other`,
          channel: 'telegram',
          part: 'text',
          chatId: '-1001',
        }),
      ).toThrow('Delivery claim is not active');
      expect(
        db.get<{ count: number }>('SELECT COUNT(*) AS count FROM notification_delivery_attempts')
          ?.count,
      ).toBe(0);
    });
  });
});
