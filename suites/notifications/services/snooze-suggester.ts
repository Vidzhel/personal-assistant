import { Cron } from 'croner';
import {
  createLogger,
  generateId,
  SUITE_NOTIFICATIONS,
  EVENT_SNOOZE_PROPOSAL,
  UNSNOOZABLE_CATEGORIES,
  SHORTCODE_FROM_CATEGORY,
  type EventBusInterface,
  type DatabaseInterface,
} from '@raven/shared';
import type { ServiceContext, SuiteService } from '@raven/core/suite-registry/service-runner.ts';
import { matchesPattern } from '@raven/core/notification-engine/urgency-classifier.ts';

const log = createLogger('snooze-suggester');

const DEFAULT_IGNORE_THRESHOLD = 10;
const DEFAULT_SUGGESTION_COOLDOWN_DAYS = 7;
const DEFAULT_CHECK_INTERVAL_MINUTES = 30;

let eventBus: EventBusInterface;
let db: DatabaseInterface;
let checkJob: Cron | null = null;
let ignoreThreshold = DEFAULT_IGNORE_THRESHOLD;
let suggestionCooldownDays = DEFAULT_SUGGESTION_COOLDOWN_DAYS;

interface CategoryStats {
  sourcePrefix: string;
  deliveredCount: number;
  respondedCount: number;
}

function getCategoryPrefix(source: string): string {
  const colonIdx = source.indexOf(':');
  return colonIdx === -1 ? source : source.substring(0, colonIdx);
}

function isUnsnoozableSource(source: string): boolean {
  return UNSNOOZABLE_CATEGORIES.some((pattern) => matchesPattern(source, pattern));
}

function hasRecentSuggestion(category: string): boolean {
  const cooldownCutoff = new Date(
    Date.now() - suggestionCooldownDays * 86_400_000,
  ).toISOString();

  // Check snooze_suggestions tracking table
  const row = db.get<{ count: number }>(
    `SELECT COUNT(*) as count FROM snooze_suggestions
     WHERE category = ? AND suggested_at > ?`,
    category,
    cooldownCutoff,
  );

  return (row?.count ?? 0) > 0;
}

function getIgnoredCategories(): CategoryStats[] {
  const stats = db.all<{ source: string; cnt: number }>(
    `SELECT source, COUNT(*) as cnt FROM notification_queue
     WHERE status IN ('delivered', 'batched')
     GROUP BY source
     HAVING cnt >= ?
     ORDER BY cnt DESC`,
    ignoreThreshold,
  );

  const categories: CategoryStats[] = [];

  for (const stat of stats) {
    const prefix = getCategoryPrefix(stat.source);

    // Skip unsnoozable sources
    if (isUnsnoozableSource(stat.source)) continue;

    // Get the last N notification IDs for this source
    const lastN = db.all<{ id: string }>(
      `SELECT id FROM notification_queue
       WHERE source = ?
         AND status IN ('delivered', 'batched')
       ORDER BY created_at DESC
       LIMIT ?`,
      stat.source,
      ignoreThreshold,
    );

    if (lastN.length < ignoreThreshold) continue;

    // Count engagement responses that match these specific notification IDs
    const ids = lastN.map((n) => n.id);
    const placeholders = ids.map(() => '?').join(',');
    const responseCount = db.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM engagement_metrics
       WHERE event_type = 'user_response'
         AND notification_id IN (${placeholders})`,
      ...ids,
    );

    const respondedCount = responseCount?.count ?? 0;

    // Only consider ignored if zero responses for the last N notifications
    if (respondedCount > 0) continue;

    categories.push({
      sourcePrefix: prefix,
      deliveredCount: stat.cnt,
      respondedCount,
    });
  }

  return categories;
}

function buildSnoozeCategory(prefix: string): string {
  // Map prefix to common wildcard pattern
  const wildcardMap: Record<string, string> = {
    pipeline: 'pipeline:*',
    email: 'email:triage:*',
    agent: 'agent:task:complete',
    insight: 'insight:*',
    schedule: 'schedule:triggered',
  };

  return wildcardMap[prefix] ?? `${prefix}:*`;
}

function getCategoryDisplayName(category: string): string {
  const nameMap: Record<string, string> = {
    'pipeline:*': 'pipeline status',
    'email:triage:*': 'email triage',
    'agent:task:complete': 'task completion',
    'insight:*': 'insights',
    'schedule:triggered': 'schedule',
  };
  return nameMap[category] ?? category;
}

function checkForIgnoredCategories(): void {
  try {
    const ignored = getIgnoredCategories();

    for (const cat of ignored) {
      const category = buildSnoozeCategory(cat.sourcePrefix);

      // Skip if already snoozed
      const existingSnooze = db.get<{ id: string }>(
        `SELECT id FROM notification_snooze WHERE category = ?`,
        category,
      );
      if (existingSnooze) continue;

      // Skip if recently suggested
      if (hasRecentSuggestion(category)) continue;

      const shortcode = SHORTCODE_FROM_CATEGORY[category] ?? cat.sourcePrefix;
      const displayName = getCategoryDisplayName(category);

      // Record suggestion time in dedicated tracking table
      db.run(
        `INSERT OR REPLACE INTO snooze_suggestions (category, suggested_at)
         VALUES (?, ?)`,
        category,
        new Date().toISOString(),
      );

      // Emit notification with snooze suggestion
      eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: 'system:snooze-suggestion',
        type: 'notification',
        payload: {
          channel: 'telegram' as const,
          title: 'Quiet category detected',
          body: `You've been ignoring ${displayName} notifications — snooze for a week?`,
          urgencyTier: 'green' as const,
          deliveryMode: 'tell-when-active' as const,
          actions: [
            { label: 'Snooze 1w', action: 'callback', data: `s:w:${shortcode}` },
            { label: 'Keep', action: 'callback', data: `s:k:${shortcode}` },
            { label: 'Mute', action: 'callback', data: `s:m:${shortcode}` },
          ],
        },
      });

      eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: SUITE_NOTIFICATIONS,
        type: EVENT_SNOOZE_PROPOSAL,
        payload: {
          category,
          ignoredCount: cat.deliveredCount,
        },
      });

      log.info(`Proposed snooze for "${category}" (${cat.deliveredCount} ignored notifications)`);
    }
  } catch (err) {
    log.error(`Snooze suggestion check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const service: SuiteService = {
  async start(context: ServiceContext): Promise<void> {
    eventBus = context.eventBus;
    db = context.db;

    const config = context.config as Record<string, unknown>;
    if (typeof config.snoozeIgnoreThreshold === 'number') {
      ignoreThreshold = config.snoozeIgnoreThreshold;
    }
    if (typeof config.snoozeSuggestionCooldownDays === 'number') {
      suggestionCooldownDays = config.snoozeSuggestionCooldownDays;
    }

    const checkInterval = (config.snoozeCheckIntervalMinutes as number) ?? DEFAULT_CHECK_INTERVAL_MINUTES;

    checkJob = new Cron(`*/${String(checkInterval)} * * * *`, () => {
      checkForIgnoredCategories();
    });

    log.info(`Snooze suggester started (threshold: ${ignoreThreshold}, cooldown: ${suggestionCooldownDays}d, check every ${checkInterval}m)`);
  },

  async stop(): Promise<void> {
    if (checkJob) {
      checkJob.stop();
      checkJob = null;
    }
    log.info('Snooze suggester stopped');
  },
};

export default service;

// Export for testing
export { checkForIgnoredCategories, getIgnoredCategories, buildSnoozeCategory, getCategoryPrefix };
