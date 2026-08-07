import { Cron } from 'croner';
import {
  createLogger,
  generateId,
  SUITE_NOTIFICATIONS,
  EVENT_NOTIFICATION_DELIVER,
  EVENT_NOTIFICATION_QUEUED,
  EVENT_NOTIFICATION_BATCHED,
  EVENT_NOTIFICATION_SNOOZED,
  UNSNOOZABLE_CATEGORIES,
  type EventBusInterface,
  type DatabaseInterface,
  type NotificationEvent,
  type UrgencyTier,
  type DeliveryMode,
  type NotificationSnoozedEvent,
  type NotificationDeliverEvent,
  type NotificationQueuedEvent,
  type NotificationBatchedEvent,
} from '@raven/shared';
import type { ServiceContext, RavenService } from '../types.ts';
import {
  classifyNotification,
  loadClassificationRules,
  matchesPattern,
} from '../../notification-engine/urgency-classifier.ts';
import {
  enqueueNotification,
  getReadyNotifications,
  getSnoozedByCategory,
  releaseSnoozed,
} from '../../notification-engine/notification-queue.ts';
import type { ClassificationRule } from '../../notification-engine/urgency-classifier.ts';
import {
  getSnoozeForCategory,
  incrementHeldCount,
  expireSnoozes,
} from '../../notification-engine/snooze-store.ts';
import { getEngagementState } from './engagement-tracker.ts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const log = createLogger('delivery-scheduler');

const DEFAULT_ACTIVE_HOURS = { start: '07:00', end: '23:00', timezone: 'America/New_York' };
const DEFAULT_FLUSH_INTERVAL_MINUTES = 5;
const ONE_DAY_MS = 86_400_000;

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

interface DateParts {
  year: string;
  month: string;
  day: string;
}

const FALLBACK_DATE_PARTS: DateParts = { year: '2026', month: '01', day: '01' };

function extractDateParts(formatter: Intl.DateTimeFormat, date: Date): DateParts {
  const parts = formatter.formatToParts(date);
  return {
    year: parts.find((p) => p.type === 'year')?.value ?? FALLBACK_DATE_PARTS.year,
    month: parts.find((p) => p.type === 'month')?.value ?? FALLBACK_DATE_PARTS.month,
    day: parts.find((p) => p.type === 'day')?.value ?? FALLBACK_DATE_PARTS.day,
  };
}

function formatWindowStart(parts: DateParts, startTime: string): string {
  return `${parts.year}-${parts.month}-${parts.day}T${startTime}:00`;
}

function getNextActiveWindowStart(now: Date, config: ActiveHoursConfig): string {
  // If currently in active hours, schedule for now (next flush cycle picks it up)
  if (isWithinActiveHours(now, config)) {
    return now.toISOString();
  }

  const dateFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour12: false,
  });

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
    return formatWindowStart(extractDateParts(dateFormatter, now), config.start);
  }

  // After today's end — schedule for tomorrow's start
  const tomorrow = new Date(now.getTime() + ONE_DAY_MS);
  return formatWindowStart(extractDateParts(dateFormatter, tomorrow), config.start);
}

function isUnsnoozable(source: string): boolean {
  return UNSNOOZABLE_CATEGORIES.some((pattern) => matchesPattern(source, pattern));
}

// Returns true if the notification was snoozed (held for later, caller should stop processing).
function trySnoozeNotification(notifEvent: NotificationEvent, source: string): boolean {
  if (isUnsnoozable(source)) return false;

  const snooze = getSnoozeForCategory(db, source);
  if (!snooze) return false;

  const queueId = enqueueNotification(db, {
    source,
    title: notifEvent.payload.title,
    body: notifEvent.payload.body,
    topicName: notifEvent.payload.topicName,
    actionsJson: notifEvent.payload.actions
      ? JSON.stringify(notifEvent.payload.actions)
      : undefined,
    channel: notifEvent.payload.channel,
    urgencyTier: notifEvent.payload.urgencyTier ?? 'green',
    deliveryMode: notifEvent.payload.deliveryMode ?? 'save-for-later',
    status: 'snoozed',
  });

  incrementHeldCount(db, snooze.id);

  eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: SUITE_NOTIFICATIONS,
    type: EVENT_NOTIFICATION_SNOOZED,
    payload: {
      category: snooze.category,
      snoozedUntil: snooze.snoozedUntil,
      notificationSource: source,
    },
  } as unknown as NotificationSnoozedEvent);

  log.info(
    `Snoozed: "${notifEvent.payload.title}" [${source}] → held (snooze ${snooze.id}, queue ${queueId})`,
  );
  return true;
}

function deliverTellNow(
  notifEvent: NotificationEvent,
  urgencyTier: UrgencyTier,
  deliveryMode: DeliveryMode,
): void {
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
  } as unknown as NotificationDeliverEvent);
  log.info(`tell-now: ${notifEvent.payload.title} [${urgencyTier}]`);
}

interface QueueContext {
  urgencyTier: UrgencyTier;
  deliveryMode: DeliveryMode;
  actionsStr: string | undefined;
}

function queueTellWhenActive(notifEvent: NotificationEvent, ctx: QueueContext): void {
  const { urgencyTier, deliveryMode, actionsStr } = ctx;
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
  } as unknown as NotificationQueuedEvent);

  log.info(`tell-when-active: queued ${queueId}, scheduled for ${scheduledFor}`);
}

function queueSaveForLater(notifEvent: NotificationEvent, ctx: QueueContext): void {
  const { urgencyTier, deliveryMode, actionsStr } = ctx;
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
  } as unknown as NotificationBatchedEvent);

  log.info(`save-for-later: batched ${queueId}`);
}

function handleNotification(event: unknown): void {
  try {
    const notifEvent = event as NotificationEvent;
    const source = notifEvent.source;

    // SNOOZE CHECK — must happen before classification
    if (trySnoozeNotification(notifEvent, source)) return;

    const classification = classifyNotification(notifEvent, classificationRules);
    const { urgencyTier } = classification;
    let { deliveryMode } = classification;

    // Throttle non-tell-now when engagement is low
    const engagementState = getEngagementState();
    if (engagementState === 'throttled' && deliveryMode !== 'tell-now') {
      deliveryMode = 'save-for-later';
      log.info(
        `Throttled: batching "${notifEvent.payload.title}" [${urgencyTier}/${classification.deliveryMode} → save-for-later]`,
      );
    }

    if (deliveryMode === 'tell-now') {
      deliverTellNow(notifEvent, urgencyTier, deliveryMode);
      return;
    }

    const actionsStr = notifEvent.payload.actions
      ? JSON.stringify(notifEvent.payload.actions)
      : undefined;

    if (deliveryMode === 'tell-when-active') {
      queueTellWhenActive(notifEvent, { urgencyTier, deliveryMode, actionsStr });
      return;
    }

    if (deliveryMode === 'save-for-later') {
      queueSaveForLater(notifEvent, { urgencyTier, deliveryMode, actionsStr });
    }
  } catch (err) {
    log.error(`Failed to handle notification: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function flushReadyNotifications(): void {
  try {
    const now = new Date().toISOString();

    // Check for expired snoozes and release held notifications
    checkSnoozeExpiry(now);

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
      } as unknown as NotificationDeliverEvent);
    }
  } catch (err) {
    log.error(`Flush failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function checkSnoozeExpiry(now: string): void {
  try {
    const expired = expireSnoozes(db, now);

    for (const snooze of expired) {
      const snoozed = getSnoozedByCategory(db, snooze.category);
      if (snoozed.length > 0) {
        releaseSnoozed(
          db,
          snoozed.map((n) => n.id),
        );
        log.info(
          `Released ${snoozed.length} held notification(s) for expired snooze "${snooze.category}"`,
        );
      }
    }
  } catch (err) {
    log.error(`Snooze expiry check failed: ${err instanceof Error ? err.message : String(err)}`);
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

const service: RavenService = {
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

    // Periodic flush of tell-when-active items + snooze expiry check
    flushJob = new Cron(
      `*/${String(flushInterval)} * * * *`,
      { timezone: activeHours.timezone },
      () => {
        flushReadyNotifications();
      },
    );

    log.info(
      `Delivery scheduler started (flush every ${flushInterval}m, active hours ${activeHours.start}-${activeHours.end} ${activeHours.timezone})`,
    );
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
export {
  isWithinActiveHours,
  getNextActiveWindowStart,
  handleNotification,
  flushReadyNotifications,
  checkSnoozeExpiry,
  isUnsnoozable,
};
