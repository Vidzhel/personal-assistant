import { Cron } from 'croner';
import {
  createLogger,
  generateId,
  SUITE_NOTIFICATIONS,
  EVENT_NOTIFICATION_DELIVER,
  EVENT_NOTIFICATION_QUEUED,
  EVENT_NOTIFICATION_BATCHED,
  type EventBusInterface,
  type DatabaseInterface,
  type NotificationEvent,
} from '@raven/shared';
import type { ServiceContext, SuiteService } from '@raven/core/suite-registry/service-runner.ts';
import { classifyNotification, loadClassificationRules } from '@raven/core/notification-engine/urgency-classifier.ts';
import {
  enqueueNotification,
  getReadyNotifications,
} from '@raven/core/notification-engine/notification-queue.ts';
import type { ClassificationRule } from '@raven/core/notification-engine/urgency-classifier.ts';
import { getEngagementState } from './engagement-tracker.ts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const log = createLogger('delivery-scheduler');

const DEFAULT_ACTIVE_HOURS = { start: '07:00', end: '23:00', timezone: 'America/New_York' };
const DEFAULT_FLUSH_INTERVAL_MINUTES = 5;

interface ActiveHoursConfig {
  start: string;
  end: string;
  timezone: string;
}

let eventBus: EventBusInterface;
let db: DatabaseInterface;
let flushJob: Cron | null = null;
let activeHours: ActiveHoursConfig = DEFAULT_ACTIVE_HOURS;
let classificationRules: ClassificationRule[] | undefined;

function isWithinActiveHours(now: Date, config: ActiveHoursConfig): boolean {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: config.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const timeStr = formatter.format(now);
  return timeStr >= config.start && timeStr < config.end;
}

function getNextActiveWindowStart(now: Date, config: ActiveHoursConfig): string {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const year = parts.find((p) => p.type === 'year')?.value ?? '2026';
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  const day = parts.find((p) => p.type === 'day')?.value ?? '01';

  // If currently in active hours, schedule for now (next flush cycle picks it up)
  if (isWithinActiveHours(now, config)) {
    return now.toISOString();
  }

  // Check if we're before today's start time
  const timeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: config.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const currentTime = timeFormatter.format(now);

  if (currentTime < config.start) {
    // Before today's start — schedule for today's start
    return `${year}-${month}-${day}T${config.start}:00`;
  }

  // After today's end — schedule for tomorrow's start
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const tmParts = formatter.formatToParts(tomorrow);
  const tmYear = tmParts.find((p) => p.type === 'year')?.value ?? '2026';
  const tmMonth = tmParts.find((p) => p.type === 'month')?.value ?? '01';
  const tmDay = tmParts.find((p) => p.type === 'day')?.value ?? '01';
  return `${tmYear}-${tmMonth}-${tmDay}T${config.start}:00`;
}

function handleNotification(event: unknown): void {
  try {
    const notifEvent = event as NotificationEvent;
    const classification = classifyNotification(notifEvent, classificationRules);
    const { urgencyTier } = classification;
    let { deliveryMode } = classification;

    // Throttle non-tell-now when engagement is low
    const engagementState = getEngagementState();
    if (engagementState === 'throttled' && deliveryMode !== 'tell-now') {
      deliveryMode = 'save-for-later';
      log.info(`Throttled: batching "${notifEvent.payload.title}" [${urgencyTier}/${classification.deliveryMode} → save-for-later]`);
    }

    if (deliveryMode === 'tell-now') {
      // Immediate passthrough — re-emit as notification:deliver
      eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: SUITE_NOTIFICATIONS,
        type: EVENT_NOTIFICATION_DELIVER,
        payload: {
          ...notifEvent.payload,
          urgencyTier,
          deliveryMode,
        },
      } as unknown as import('@raven/shared').NotificationDeliverEvent);
      log.info(`tell-now: ${notifEvent.payload.title} [${urgencyTier}]`);
      return;
    }

    const actionsStr = notifEvent.payload.actions
      ? JSON.stringify(notifEvent.payload.actions)
      : undefined;

    if (deliveryMode === 'tell-when-active') {
      const scheduledFor = getNextActiveWindowStart(new Date(), activeHours);
      const queueId = enqueueNotification(db, {
        source: notifEvent.source,
        title: notifEvent.payload.title,
        body: notifEvent.payload.body,
        topicName: notifEvent.payload.topicName,
        actionsJson: actionsStr,
        channel: notifEvent.payload.channel,
        urgencyTier,
        deliveryMode,
        status: 'pending',
        scheduledFor,
      });

      eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: SUITE_NOTIFICATIONS,
        type: EVENT_NOTIFICATION_QUEUED,
        payload: { queueId, urgencyTier, deliveryMode, scheduledFor },
      } as unknown as import('@raven/shared').NotificationQueuedEvent);

      log.info(`tell-when-active: queued ${queueId}, scheduled for ${scheduledFor}`);
      return;
    }

    if (deliveryMode === 'save-for-later') {
      const queueId = enqueueNotification(db, {
        source: notifEvent.source,
        title: notifEvent.payload.title,
        body: notifEvent.payload.body,
        topicName: notifEvent.payload.topicName,
        actionsJson: actionsStr,
        channel: notifEvent.payload.channel,
        urgencyTier,
        deliveryMode,
        status: 'batched',
      });

      eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: SUITE_NOTIFICATIONS,
        type: EVENT_NOTIFICATION_BATCHED,
        payload: { queueId, urgencyTier },
      } as unknown as import('@raven/shared').NotificationBatchedEvent);

      log.info(`save-for-later: batched ${queueId}`);
    }
  } catch (err) {
    log.error(`Failed to handle notification: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function flushReadyNotifications(): void {
  try {
    const now = new Date().toISOString();
    const ready = getReadyNotifications(db, now);

    if (ready.length === 0) return;

    log.info(`Flushing ${ready.length} ready notification(s)`);

    for (const item of ready) {
      const actions = item.actionsJson ? JSON.parse(item.actionsJson) : undefined;

      eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: SUITE_NOTIFICATIONS,
        type: EVENT_NOTIFICATION_DELIVER,
        payload: {
          channel: (item.channel ?? 'telegram') as 'telegram' | 'web' | 'all',
          title: item.title,
          body: item.body,
          topicName: item.topicName ?? undefined,
          actions,
          urgencyTier: item.urgencyTier,
          deliveryMode: item.deliveryMode,
          queueId: item.id,
        },
      } as unknown as import('@raven/shared').NotificationDeliverEvent);
    }
  } catch (err) {
    log.error(`Flush failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function loadRulesFromFile(projectRoot: string): ClassificationRule[] | undefined {
  try {
    const rulesPath = resolve(projectRoot, 'config', 'notification-rules.json');
    const content = readFileSync(rulesPath, 'utf-8');
    const parsed = JSON.parse(content);
    const rules = loadClassificationRules(parsed);
    log.info(`Loaded ${rules.length} classification rules from config`);
    return rules;
  } catch {
    log.info('No custom classification rules found, using defaults');
    return undefined;
  }
}

const service: SuiteService = {
  async start(context: ServiceContext): Promise<void> {
    eventBus = context.eventBus;
    db = context.db;

    // Load active hours config
    const config = context.config as Record<string, unknown>;
    const ahConfig = config.activeHours as ActiveHoursConfig | undefined;
    if (ahConfig) {
      activeHours = { ...DEFAULT_ACTIVE_HOURS, ...ahConfig };
    }

    const flushInterval = (config.flushIntervalMinutes as number) ?? DEFAULT_FLUSH_INTERVAL_MINUTES;

    // Load classification rules from config file
    classificationRules = loadRulesFromFile(context.projectRoot);

    // Subscribe to notification events
    eventBus.on('notification', handleNotification);

    // Periodic flush of tell-when-active items
    flushJob = new Cron(`*/${String(flushInterval)} * * * *`, { timezone: activeHours.timezone }, () => {
      flushReadyNotifications();
    });

    log.info(`Delivery scheduler started (flush every ${flushInterval}m, active hours ${activeHours.start}-${activeHours.end} ${activeHours.timezone})`);
  },

  async stop(): Promise<void> {
    eventBus.off('notification', handleNotification);
    if (flushJob) {
      flushJob.stop();
      flushJob = null;
    }
    log.info('Delivery scheduler stopped');
  },
};

export default service;

// Export for testing
export { isWithinActiveHours, getNextActiveWindowStart, handleNotification, flushReadyNotifications };
