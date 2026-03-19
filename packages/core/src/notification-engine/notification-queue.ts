import type { DatabaseInterface } from '@raven/shared';
import { generateId, createLogger } from '@raven/shared';
import type { DeliveryMode, UrgencyTier } from '@raven/shared';

const log = createLogger('notification-queue');

export interface QueuedNotification {
  id: string;
  source: string;
  title: string;
  body: string;
  topicName: string | null;
  actionsJson: string | null;
  channel: string | null;
  urgencyTier: UrgencyTier;
  deliveryMode: DeliveryMode;
  status: 'pending' | 'delivered' | 'batched' | 'expired';
  createdAt: string;
  scheduledFor: string | null;
  deliveredAt: string | null;
}

interface EnqueueParams {
  source: string;
  title: string;
  body: string;
  topicName?: string;
  actionsJson?: string;
  channel?: string;
  urgencyTier: UrgencyTier;
  deliveryMode: DeliveryMode;
  status: 'pending' | 'batched';
  scheduledFor?: string;
}

export function enqueueNotification(db: DatabaseInterface, params: EnqueueParams): string {
  const id = generateId();
  const now = new Date().toISOString();

  db.run(
    `INSERT INTO notification_queue (id, source, title, body, topic_name, actions_json, channel, urgency_tier, delivery_mode, status, created_at, scheduled_for)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    params.source,
    params.title,
    params.body,
    params.topicName ?? null,
    params.actionsJson ?? null,
    params.channel ?? null,
    params.urgencyTier,
    params.deliveryMode,
    params.status,
    now,
    params.scheduledFor ?? null,
  );

  log.debug(`Enqueued notification ${id} [${params.urgencyTier}/${params.deliveryMode}]`);
  return id;
}

export function getReadyNotifications(db: DatabaseInterface, now: string): QueuedNotification[] {
  return db.all<QueuedNotification>(
    `SELECT id, source, title, body, topic_name AS topicName, actions_json AS actionsJson,
            channel, urgency_tier AS urgencyTier, delivery_mode AS deliveryMode, status,
            created_at AS createdAt, scheduled_for AS scheduledFor, delivered_at AS deliveredAt
     FROM notification_queue
     WHERE delivery_mode = 'tell-when-active' AND status = 'pending' AND scheduled_for <= ?
     ORDER BY created_at ASC`,
    now,
  );
}

export function getPendingBatched(db: DatabaseInterface): QueuedNotification[] {
  return db.all<QueuedNotification>(
    `SELECT id, source, title, body, topic_name AS topicName, actions_json AS actionsJson,
            channel, urgency_tier AS urgencyTier, delivery_mode AS deliveryMode, status,
            created_at AS createdAt, scheduled_for AS scheduledFor, delivered_at AS deliveredAt
     FROM notification_queue
     WHERE status = 'batched' AND delivery_mode = 'save-for-later'
     ORDER BY created_at ASC`,
  );
}

export function markDelivered(db: DatabaseInterface, id: string): void {
  const now = new Date().toISOString();
  db.run(
    `UPDATE notification_queue SET status = 'delivered', delivered_at = ? WHERE id = ?`,
    now,
    id,
  );
}

export function markBatched(db: DatabaseInterface, ids: string[]): void {
  const now = new Date().toISOString();
  for (const id of ids) {
    db.run(
      `UPDATE notification_queue SET status = 'delivered', delivered_at = ? WHERE id = ? AND status = 'batched'`,
      now,
      id,
    );
  }
}
