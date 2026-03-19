import { Cron } from 'croner';
import {
  createLogger,
  generateId,
  SUITE_NOTIFICATIONS,
  EVENT_ENGAGEMENT_STATE_CHANGED,
  EVENT_NOTIFICATION_DELIVER,
  EVENT_NOTIFICATION_ESCALATED,
  DEFAULT_LOW_ENGAGEMENT_THRESHOLD,
  DEFAULT_RESUME_THRESHOLD,
  DEFAULT_ESCALATION_HOURS,
  type EventBusInterface,
  type DatabaseInterface,
  type EngagementState,
} from '@raven/shared';
import type { ServiceContext, SuiteService } from '@raven/core/suite-registry/service-runner.ts';
import {
  getEscalationCandidates,
  markEscalated,
} from '@raven/core/notification-engine/notification-queue.ts';

const log = createLogger('engagement-tracker');

const MS_PER_HOUR = 3_600_000;

let eventBus: EventBusInterface;
let db: DatabaseInterface;
let escalationJob: Cron | null = null;

let currentState: EngagementState = 'normal';
let lowEngagementThreshold = DEFAULT_LOW_ENGAGEMENT_THRESHOLD;
let resumeThreshold = DEFAULT_RESUME_THRESHOLD;
let escalationHours = DEFAULT_ESCALATION_HOURS;

export function getEngagementState(): EngagementState {
  return currentState;
}

export function recordDelivery(
  database: DatabaseInterface,
  notificationId: string,
): void {
  const id = generateId();
  database.run(
    `INSERT INTO engagement_metrics (id, event_type, notification_id, created_at)
     VALUES (?, ?, ?, ?)`,
    id,
    'notification_delivered',
    notificationId,
    new Date().toISOString(),
  );
}

export function recordResponse(
  database: DatabaseInterface,
  notificationId: string | null,
): void {
  const id = generateId();
  database.run(
    `INSERT INTO engagement_metrics (id, event_type, notification_id, created_at)
     VALUES (?, ?, ?, ?)`,
    id,
    'user_response',
    notificationId,
    new Date().toISOString(),
  );
}

interface EngagementConfig {
  lowEngagementThreshold?: number;
  resumeThreshold?: number;
  escalationHours?: number;
  escalationIntervalMinutes?: number;
}

function computeEngagementState(database: DatabaseInterface): EngagementState {
  const deliveryCount = database.get<{ count: number }>(
    `SELECT COUNT(*) as count FROM engagement_metrics
     WHERE event_type = 'notification_delivered'
       AND created_at > datetime('now', '-2 hours')`,
  );

  const deliveries = deliveryCount?.count ?? 0;
  if (deliveries < lowEngagementThreshold) {
    return 'normal';
  }

  const responseCount = database.get<{ count: number }>(
    `SELECT COUNT(*) as count FROM engagement_metrics
     WHERE event_type = 'user_response'
       AND created_at > datetime('now', '-2 hours')`,
  );

  const responses = responseCount?.count ?? 0;
  const unresponded = deliveries - responses;

  if (unresponded >= lowEngagementThreshold) {
    return 'throttled';
  }

  return 'normal';
}

function checkResumeCondition(database: DatabaseInterface): boolean {
  const recentResponses = database.get<{ count: number }>(
    `SELECT COUNT(*) as count FROM engagement_metrics
     WHERE event_type = 'user_response'
       AND created_at > datetime('now', '-1 hour')`,
  );

  return (recentResponses?.count ?? 0) >= resumeThreshold;
}

function updateEngagementState(database: DatabaseInterface): void {
  const previousState = currentState;

  if (currentState === 'throttled') {
    if (checkResumeCondition(database)) {
      currentState = 'normal';
    }
  } else {
    const computed = computeEngagementState(database);
    currentState = computed;
  }

  if (previousState !== currentState) {
    const recentDeliveries = database.get<{ total: number }>(
      `SELECT COUNT(*) as total FROM engagement_metrics
       WHERE event_type = 'notification_delivered'
         AND created_at > datetime('now', '-2 hours')`,
    );
    const recentResponses = database.get<{ total: number }>(
      `SELECT COUNT(*) as total FROM engagement_metrics
       WHERE event_type = 'user_response'
         AND created_at > datetime('now', '-2 hours')`,
    );

    const delivered = recentDeliveries?.total ?? 0;
    const responded = recentResponses?.total ?? 0;
    const ratio = delivered > 0 ? responded / delivered : 1;

    eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: SUITE_NOTIFICATIONS,
      type: EVENT_ENGAGEMENT_STATE_CHANGED,
      payload: {
        previousState,
        newState: currentState,
        responseRatio: ratio,
      },
    });

    log.info(`Engagement state changed: ${previousState} → ${currentState} (ratio: ${ratio.toFixed(2)})`);
  }
}

function handleNotificationDeliver(event: unknown): void {
  try {
    const e = event as Record<string, unknown>;
    const payload = e.payload as Record<string, unknown>;
    const title = payload.title as string | undefined;

    // Skip recording escalation re-deliveries to avoid inflating delivery count
    if (title?.startsWith('Reminder: ')) return;

    const queueId = payload.queueId as string | undefined;

    if (queueId) {
      recordDelivery(db, queueId);
    } else {
      recordDelivery(db, e.id as string);
    }

    updateEngagementState(db);
  } catch (err) {
    log.error(`Failed to record delivery: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function handleUserResponse(): void {
  try {
    recordResponse(db, null);
    updateEngagementState(db);
  } catch (err) {
    log.error(`Failed to record response: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function runEscalationCheck(): void {
  try {
    if (currentState !== 'throttled') return;

    const cutoff = new Date(Date.now() - escalationHours * MS_PER_HOUR).toISOString();
    const candidates = getEscalationCandidates(db, cutoff);

    if (candidates.length === 0) return;

    log.info(`Escalating ${candidates.length} throttled notification(s)`);

    for (const item of candidates) {
      markEscalated(db, item.id);

      const actions = item.actionsJson ? JSON.parse(item.actionsJson) : undefined;

      eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: SUITE_NOTIFICATIONS,
        type: EVENT_NOTIFICATION_DELIVER,
        payload: {
          channel: (item.channel ?? 'telegram') as 'telegram' | 'web' | 'all',
          title: `Reminder: ${item.title}`,
          body: item.body,
          topicName: item.topicName ?? undefined,
          actions,
          urgencyTier: item.urgencyTier,
          deliveryMode: item.deliveryMode,
          queueId: item.id,
        },
      } as unknown as import('@raven/shared').NotificationDeliverEvent);

      eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: SUITE_NOTIFICATIONS,
        type: EVENT_NOTIFICATION_ESCALATED,
        payload: {
          queueId: item.id,
          originalTitle: item.title,
          urgencyTier: item.urgencyTier,
        },
      } as unknown as import('@raven/shared').NotificationEscalatedEvent);
    }
  } catch (err) {
    log.error(`Escalation check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const service: SuiteService = {
  async start(context: ServiceContext): Promise<void> {
    eventBus = context.eventBus;
    db = context.db;

    const config = context.config as EngagementConfig;
    if (typeof config.lowEngagementThreshold === 'number') {
      lowEngagementThreshold = config.lowEngagementThreshold;
    }
    if (typeof config.resumeThreshold === 'number') {
      resumeThreshold = config.resumeThreshold;
    }
    if (typeof config.escalationHours === 'number') {
      escalationHours = config.escalationHours;
    }

    const escalationInterval = config.escalationIntervalMinutes ?? 15;

    eventBus.on('notification:deliver', handleNotificationDeliver);
    eventBus.on('telegram:message', handleUserResponse);
    eventBus.on('telegram:callback', handleUserResponse);

    escalationJob = new Cron(
      `*/${String(escalationInterval)} * * * *`,
      () => {
        runEscalationCheck();
      },
    );

    log.info(
      `Engagement tracker started (threshold: ${lowEngagementThreshold}, resume: ${resumeThreshold}, escalation: ${escalationHours}h every ${escalationInterval}m)`,
    );
  },

  async stop(): Promise<void> {
    eventBus.off('notification:deliver', handleNotificationDeliver);
    eventBus.off('telegram:message', handleUserResponse);
    eventBus.off('telegram:callback', handleUserResponse);

    if (escalationJob) {
      escalationJob.stop();
      escalationJob = null;
    }

    currentState = 'normal';
    log.info('Engagement tracker stopped');
  },
};

export default service;

export {
  computeEngagementState,
  checkResumeCondition,
  updateEngagementState,
  runEscalationCheck,
  handleNotificationDeliver,
  handleUserResponse,
};
