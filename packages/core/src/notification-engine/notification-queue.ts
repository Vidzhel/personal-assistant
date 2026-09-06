import type { DatabaseInterface } from '@raven/shared';
import { generateId, createLogger } from '@raven/shared';
import type {
  ChatTransportOrigin,
  DeliveryMode,
  NotificationDestination,
  UrgencyTier,
} from '@raven/shared';

const log = createLogger('notification-queue');
const MAX_DIAGNOSTIC_LIMIT = 500;
const DEFAULT_DIAGNOSTIC_LIMIT = 100;

export interface QueuedNotification {
  id: string;
  source: string;
  title: string;
  body: string;
  filePath: string | null;
  topicName: string | null;
  actionsJson: string | null;
  channel: string | null;
  urgencyTier: UrgencyTier;
  deliveryMode: DeliveryMode;
  status:
    | 'pending'
    | 'sending'
    | 'delivered'
    | 'failed'
    | 'unknown'
    | 'partial'
    | 'batched'
    | 'expired'
    | 'escalated'
    | 'snoozed'
    | 'included';
  createdAt: string;
  scheduledFor: string | null;
  deliveredAt: string | null;
  destinationKind: 'project' | 'global' | null;
  destinationProjectId: string | null;
  destinationProjectName: string | null;
  destinationTopic: 'general' | 'system' | null;
  attemptCount: number;
  providerMessageId: string | null;
  lastError: string | null;
  lastAttemptAt: string | null;
  replyChatId: string | null;
  replyTopicId: number | null;
  replyMessageId: number | null;
  replySessionId: string | null;
  replyTaskId: string | null;
}

interface EnqueueParams {
  source: string;
  title: string;
  body: string;
  filePath?: string;
  topicName?: string;
  actionsJson?: string;
  channel?: string;
  urgencyTier: UrgencyTier;
  deliveryMode: DeliveryMode;
  status: 'pending' | 'batched' | 'snoozed';
  scheduledFor?: string;
  destination?: NotificationDestination;
  dedupeKey?: string;
  transportOrigin?: ChatTransportOrigin;
  sessionId?: string;
  taskId?: string;
}

function nullable(value: string | undefined): string | null {
  return value === undefined ? null : value;
}

function destinationFields(destination: NotificationDestination | undefined): {
  kind: 'project' | 'global' | null;
  projectId: string | null;
  topic: 'general' | 'system' | null;
} {
  if (destination?.kind === 'project') {
    return { kind: 'project', projectId: destination.projectId, topic: null };
  }
  if (destination?.kind === 'global') {
    return { kind: 'global', projectId: null, topic: destination.topic };
  }
  return { kind: null, projectId: null, topic: null };
}

function findDedupeId(db: DatabaseInterface, dedupeKey: string | undefined): string | undefined {
  if (!dedupeKey) return undefined;
  return db.get<{ id: string }>('SELECT id FROM notification_queue WHERE dedupe_key = ?', dedupeKey)
    ?.id;
}

export function enqueueNotification(db: DatabaseInterface, params: EnqueueParams): string {
  const id = generateId();
  const now = new Date().toISOString();

  const destination = destinationFields(params.destination);
  db.run(
    `INSERT INTO notification_queue
       (id, source, title, body, file_path, topic_name, actions_json, channel, destination_kind,
        destination_project_id, destination_topic, urgency_tier, delivery_mode, status,
        created_at, scheduled_for, dedupe_key, reply_chat_id, reply_topic_id,
        reply_message_id, reply_session_id, reply_task_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(dedupe_key) DO NOTHING`,
    id,
    params.source,
    params.title,
    params.body,
    nullable(params.filePath),
    nullable(params.topicName),
    nullable(params.actionsJson),
    nullable(params.channel),
    destination.kind,
    destination.projectId,
    destination.topic,
    params.urgencyTier,
    params.deliveryMode,
    params.status,
    now,
    nullable(params.scheduledFor),
    nullable(params.dedupeKey),
    nullable(params.transportOrigin?.chatId),
    params.transportOrigin?.topicId ?? null,
    params.transportOrigin?.messageId ?? null,
    nullable(params.sessionId),
    nullable(params.taskId),
  );

  const storedId = findDedupeId(db, params.dedupeKey);
  if (storedId) return storedId;

  log.debug(`Enqueued notification ${id} [${params.urgencyTier}/${params.deliveryMode}]`);
  return id;
}

export function queuedReplyContext(item: QueuedNotification): {
  transportOrigin?: ChatTransportOrigin;
  sessionId?: string;
  taskId?: string;
} {
  return {
    transportOrigin:
      item.replyChatId && item.replyMessageId != null
        ? {
            transport: 'telegram',
            chatId: item.replyChatId,
            topicId: item.replyTopicId ?? undefined,
            messageId: item.replyMessageId,
          }
        : undefined,
    sessionId: item.replySessionId ?? undefined,
    taskId: item.replyTaskId ?? undefined,
  };
}

export function getReadyNotifications(db: DatabaseInterface, now: string): QueuedNotification[] {
  return db.all<QueuedNotification>(
    `SELECT id, source, title, body, file_path AS filePath, topic_name AS topicName, actions_json AS actionsJson,
            channel, destination_kind AS destinationKind,
            destination_project_id AS destinationProjectId, destination_topic AS destinationTopic,
            urgency_tier AS urgencyTier, delivery_mode AS deliveryMode, status,
            created_at AS createdAt, scheduled_for AS scheduledFor, delivered_at AS deliveredAt,
            attempt_count AS attemptCount, provider_message_id AS providerMessageId,
            last_error AS lastError, last_attempt_at AS lastAttemptAt,
            reply_chat_id AS replyChatId, reply_topic_id AS replyTopicId,
            reply_message_id AS replyMessageId, reply_session_id AS replySessionId,
            reply_task_id AS replyTaskId
     FROM notification_queue
     WHERE status = 'pending'
       AND (delivery_mode = 'tell-now'
         OR (delivery_mode = 'tell-when-active' AND scheduled_for <= ?))
     ORDER BY created_at ASC`,
    now,
  );
}

export function getPendingBatched(db: DatabaseInterface): QueuedNotification[] {
  return db.all<QueuedNotification>(
    `SELECT id, source, title, body, file_path AS filePath, topic_name AS topicName, actions_json AS actionsJson,
            channel, destination_kind AS destinationKind,
            destination_project_id AS destinationProjectId, destination_topic AS destinationTopic,
            urgency_tier AS urgencyTier, delivery_mode AS deliveryMode, status,
            created_at AS createdAt, scheduled_for AS scheduledFor, delivered_at AS deliveredAt,
            attempt_count AS attemptCount, provider_message_id AS providerMessageId,
            last_error AS lastError, last_attempt_at AS lastAttemptAt,
            reply_chat_id AS replyChatId, reply_topic_id AS replyTopicId,
            reply_message_id AS replyMessageId, reply_session_id AS replySessionId,
            reply_task_id AS replyTaskId
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

export type DeliveryAttemptOutcome = 'accepted' | 'failed' | 'unknown';
export type DeliveryPart = 'text' | 'attachment';

export interface DeliveryAttempt {
  id: string;
  attemptNo: number;
}

export function claimNotificationDelivery(
  db: DatabaseInterface,
  notificationId: string,
): string | undefined {
  const claimId = generateId();
  db.run(
    `UPDATE notification_queue
     SET status = 'sending', delivery_claim_id = ?
     WHERE id = ? AND status = 'pending'`,
    claimId,
    notificationId,
  );
  return db.get<{ delivery_claim_id: string | null }>(
    'SELECT delivery_claim_id FROM notification_queue WHERE id = ?',
    notificationId,
  )?.delivery_claim_id === claimId
    ? claimId
    : undefined;
}

export function beginDeliveryAttempt(
  db: DatabaseInterface,
  params: {
    notificationId: string;
    claimId: string;
    channel: string;
    part: DeliveryPart;
    chatId: string;
    topicId?: number;
  },
): DeliveryAttempt {
  const owned = db.get<{ owned: number }>(
    `SELECT 1 AS owned FROM notification_queue
     WHERE id = ? AND status = 'sending' AND delivery_claim_id = ?`,
    params.notificationId,
    params.claimId,
  );
  if (!owned)
    throw new Error(`Delivery claim is not active for notification ${params.notificationId}`);
  const now = new Date().toISOString();
  db.run(
    `UPDATE notification_queue
     SET attempt_count = attempt_count + 1, last_attempt_at = ?
     WHERE id = ? AND status = 'sending'`,
    now,
    params.notificationId,
  );
  const attemptNo =
    db.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM notification_delivery_attempts WHERE notification_id = ? AND part = ?',
      params.notificationId,
      params.part,
    )?.count ?? 0;
  const id = generateId();
  db.run(
    `INSERT INTO notification_delivery_attempts
       (id, notification_id, channel, part, attempt_no, outcome, destination_chat_id,
        destination_topic_id, started_at)
     VALUES (?, ?, ?, ?, ?, 'sending', ?, ?, ?)`,
    id,
    params.notificationId,
    params.channel,
    params.part,
    attemptNo + 1,
    params.chatId,
    params.topicId ?? null,
    now,
  );
  return { id, attemptNo: attemptNo + 1 };
}

export function finishDeliveryAttempt(
  db: DatabaseInterface,
  attemptId: string,
  result: { outcome: DeliveryAttemptOutcome; providerMessageId?: string; error?: string },
): void {
  const completedAt = new Date().toISOString();
  db.run(
    `UPDATE notification_delivery_attempts
     SET outcome = ?, provider_message_id = ?, error = ?, completed_at = ? WHERE id = ?`,
    result.outcome,
    result.providerMessageId ?? null,
    result.error ?? null,
    completedAt,
    attemptId,
  );
  db.run(
    `UPDATE notification_queue
     SET provider_message_id = COALESCE(?, provider_message_id), last_error = ?
     WHERE id = (SELECT notification_id FROM notification_delivery_attempts WHERE id = ?)`,
    result.providerMessageId ?? null,
    result.error ?? null,
    attemptId,
  );
}

export function markDeliveryOutcome(
  db: DatabaseInterface,
  params: {
    id: string;
    outcome: 'delivered' | 'failed' | 'unknown' | 'partial';
    error?: string;
  },
): void {
  db.run(
    `UPDATE notification_queue
     SET status = ?, delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE NULL END,
         last_error = COALESCE(?, last_error), delivery_claim_id = NULL
     WHERE id = ?`,
    params.outcome,
    params.outcome,
    new Date().toISOString(),
    params.error ?? null,
    params.id,
  );
}

export function reconcileInterruptedDeliveries(db: DatabaseInterface): void {
  const now = new Date().toISOString();
  db.run(
    `UPDATE notification_delivery_attempts
     SET outcome = 'unknown', error = 'Delivery interrupted before provider outcome was recorded',
         completed_at = ?
     WHERE outcome = 'sending'`,
    now,
  );
  const interrupted = db.all<{ id: string; file_path: string | null }>(
    `SELECT id, file_path FROM notification_queue WHERE status = 'sending'`,
  );
  for (const row of interrupted) reconcileInterruptedNotification(db, row);
}

function reconcileInterruptedNotification(
  db: DatabaseInterface,
  notification: { id: string; file_path: string | null },
): void {
  const attempts = db.all<InterruptedAttempt>(
    `SELECT part, outcome, provider_message_id, error
     FROM notification_delivery_attempts WHERE notification_id = ? ORDER BY attempt_no`,
    notification.id,
  );
  if (attempts.length === 0) {
    resetUnattemptedNotification(db, notification.id);
    return;
  }

  const outcome = deriveInterruptedOutcome(notification.file_path, attempts);
  updateInterruptedNotification(db, { id: notification.id, outcome, attempts });
}

interface InterruptedAttempt {
  part: DeliveryPart;
  outcome: 'accepted' | 'failed' | 'unknown';
  provider_message_id: string | null;
  error: string | null;
}

type ReconciledOutcome = 'delivered' | 'failed' | 'unknown' | 'partial';

function resetUnattemptedNotification(db: DatabaseInterface, id: string): void {
  db.run(
    `UPDATE notification_queue SET status = 'pending', delivery_claim_id = NULL WHERE id = ?`,
    id,
  );
}

function deriveInterruptedOutcome(
  filePath: string | null,
  attempts: InterruptedAttempt[],
): ReconciledOutcome {
  const acceptedText = attempts.some((a) => a.part === 'text' && a.outcome === 'accepted');
  const acceptedAttachment = attempts.some(
    (a) => a.part === 'attachment' && a.outcome === 'accepted',
  );
  const hasUnknown = attempts.some((a) => a.outcome === 'unknown');
  return acceptedText
    ? filePath && !acceptedAttachment
      ? 'partial'
      : 'delivered'
    : acceptedAttachment
      ? 'partial'
      : hasUnknown
        ? 'unknown'
        : 'failed';
}

function updateInterruptedNotification(
  db: DatabaseInterface,
  params: { id: string; outcome: ReconciledOutcome; attempts: InterruptedAttempt[] },
): void {
  const evidence = [...params.attempts].reverse().find((a) => a.provider_message_id || a.error);
  db.run(
    `UPDATE notification_queue
     SET status = ?, delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE NULL END,
         provider_message_id = COALESCE(?, provider_message_id),
         last_error = ?, delivery_claim_id = NULL
     WHERE id = ?`,
    params.outcome,
    params.outcome,
    new Date().toISOString(),
    evidence?.provider_message_id ?? null,
    params.outcome === 'delivered'
      ? null
      : (evidence?.error ?? 'Delivery interrupted with incomplete provider evidence'),
    params.id,
  );
}

export function getPendingTellNowNotifications(db: DatabaseInterface): QueuedNotification[] {
  return db.all<QueuedNotification>(
    `SELECT id, source, title, body, file_path AS filePath, topic_name AS topicName,
            actions_json AS actionsJson, channel,
            destination_kind AS destinationKind, destination_project_id AS destinationProjectId,
            destination_topic AS destinationTopic, urgency_tier AS urgencyTier,
            delivery_mode AS deliveryMode, status, created_at AS createdAt,
            scheduled_for AS scheduledFor, delivered_at AS deliveredAt,
            attempt_count AS attemptCount, provider_message_id AS providerMessageId,
            last_error AS lastError, last_attempt_at AS lastAttemptAt,
            reply_chat_id AS replyChatId, reply_topic_id AS replyTopicId,
            reply_message_id AS replyMessageId, reply_session_id AS replySessionId,
            reply_task_id AS replyTaskId
     FROM notification_queue
     WHERE status = 'pending' AND delivery_mode = 'tell-now'
       AND channel IN ('telegram', 'all')
     ORDER BY created_at ASC`,
  );
}

export interface AcceptedTelegramReply {
  chatId: string;
  topicId: number | null;
  messageId: number;
  projectId: string;
  sessionId: string;
  taskId: string | null;
}

export function getAcceptedTelegramRepliesMissingBinding(
  db: DatabaseInterface,
): AcceptedTelegramReply[] {
  return db.all<AcceptedTelegramReply>(
    `SELECT nq.reply_chat_id AS chatId, nq.reply_topic_id AS topicId,
            CAST(nda.provider_message_id AS INTEGER) AS messageId,
            nq.destination_project_id AS projectId, nq.reply_session_id AS sessionId,
            nq.reply_task_id AS taskId
     FROM notification_queue nq
     JOIN notification_delivery_attempts nda
       ON nda.notification_id = nq.id AND nda.part = 'text' AND nda.outcome = 'accepted'
     WHERE nq.reply_chat_id IS NOT NULL AND nq.reply_session_id IS NOT NULL
       AND nq.destination_kind = 'project' AND nq.destination_project_id IS NOT NULL
       AND nda.provider_message_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM telegram_message_bindings tmb
         WHERE tmb.chat_id = nq.reply_chat_id
           AND tmb.message_id = CAST(nda.provider_message_id AS INTEGER)
       )
     ORDER BY nda.completed_at ASC`,
  );
}

export function listDeliveryDiagnostics(
  db: DatabaseInterface,
  limit = DEFAULT_DIAGNOSTIC_LIMIT,
): QueuedNotification[] {
  const safeLimit = Number.isFinite(limit)
    ? Math.max(1, Math.min(Math.floor(limit), MAX_DIAGNOSTIC_LIMIT))
    : DEFAULT_DIAGNOSTIC_LIMIT;
  return db.all<QueuedNotification>(
    `SELECT nq.id, nq.source, nq.title, nq.body, nq.file_path AS filePath,
            nq.topic_name AS topicName, nq.actions_json AS actionsJson, nq.channel,
            nq.destination_kind AS destinationKind,
            nq.destination_project_id AS destinationProjectId, p.name AS destinationProjectName,
            nq.destination_topic AS destinationTopic, nq.urgency_tier AS urgencyTier,
            nq.delivery_mode AS deliveryMode, nq.status, nq.created_at AS createdAt,
            nq.scheduled_for AS scheduledFor, nq.delivered_at AS deliveredAt,
            nq.attempt_count AS attemptCount, nq.provider_message_id AS providerMessageId,
            nq.last_error AS lastError, nq.last_attempt_at AS lastAttemptAt
     FROM notification_queue nq
     LEFT JOIN projects p ON p.id = nq.destination_project_id
     WHERE nq.channel IN ('telegram', 'all')
     ORDER BY nq.created_at DESC LIMIT ?`,
    safeLimit,
  );
}

export function getEscalationCandidates(
  db: DatabaseInterface,
  cutoffIso: string,
): QueuedNotification[] {
  return db.all<QueuedNotification>(
    `SELECT id, source, title, body, file_path AS filePath, topic_name AS topicName, actions_json AS actionsJson,
            channel, destination_kind AS destinationKind,
            destination_project_id AS destinationProjectId, destination_topic AS destinationTopic,
            urgency_tier AS urgencyTier, delivery_mode AS deliveryMode, status,
            created_at AS createdAt, scheduled_for AS scheduledFor, delivered_at AS deliveredAt,
            attempt_count AS attemptCount, provider_message_id AS providerMessageId,
            last_error AS lastError, last_attempt_at AS lastAttemptAt,
            reply_chat_id AS replyChatId, reply_topic_id AS replyTopicId,
            reply_message_id AS replyMessageId, reply_session_id AS replySessionId,
            reply_task_id AS replyTaskId
     FROM notification_queue
     WHERE delivery_mode = 'tell-when-active'
       AND status = 'pending'
       AND created_at < ?
       AND urgency_tier IN ('red', 'yellow')
     ORDER BY created_at ASC`,
    cutoffIso,
  );
}

export function getSnoozedByCategory(
  db: DatabaseInterface,
  category: string,
): QueuedNotification[] {
  return db.all<QueuedNotification>(
    `SELECT id, source, title, body, topic_name AS topicName, actions_json AS actionsJson,
            channel, urgency_tier AS urgencyTier, delivery_mode AS deliveryMode, status,
            created_at AS createdAt, scheduled_for AS scheduledFor, delivered_at AS deliveredAt
     FROM notification_queue
     WHERE status = 'snoozed' AND source LIKE ?
     ORDER BY created_at ASC`,
    category.endsWith(':*') ? `${category.slice(0, -1)}%` : category,
  );
}

export function releaseSnoozed(db: DatabaseInterface, ids: string[]): void {
  for (const id of ids) {
    db.run(
      `UPDATE notification_queue
       SET status = CASE WHEN delivery_mode = 'save-for-later' THEN 'batched' ELSE 'pending' END,
           scheduled_for = CASE WHEN delivery_mode = 'save-for-later' THEN NULL ELSE ? END
       WHERE id = ? AND status = 'snoozed'`,
      new Date().toISOString(),
      id,
    );
  }
}

export function markIncludedInBriefing(db: DatabaseInterface, ids: string[]): void {
  for (const id of ids) {
    db.run(
      `UPDATE notification_queue SET status = 'included' WHERE id = ? AND status = 'batched'`,
      id,
    );
  }
}

export function releaseBatchedForDelivery(db: DatabaseInterface, id: string): void {
  db.run(
    `UPDATE notification_queue
     SET status = 'pending', delivery_mode = 'tell-when-active', scheduled_for = ?
     WHERE id = ? AND status = 'batched'`,
    new Date().toISOString(),
    id,
  );
}
