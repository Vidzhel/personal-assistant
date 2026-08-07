import { Cron } from 'croner';
import { createLogger, generateId, type EventBusInterface, type RavenEvent } from '@raven/shared';
import type { ServiceContext, RavenService } from '../services/types.ts';
import type { Intent, IntentStore } from './intent-store.ts';

const log = createLogger('intent-matcher');

const TRIGGER_CONTEXT_MAX_LEN = 160;
// Minute sweep for kind='time' intents (their nextFireAt may arrive between
// any two inbound events) and for expiry — matches the plan's "no
// schedule-file churn for one-shots" preference over Task 1's
// scaffoldAndActivate-created cron-per-reminder approach.
const SWEEP_CRON = '* * * * *';

/**
 * Every RavenEvent type the matcher listens for, and — per event type — the
 * exact text field ALL of an event-kind intent's keywords must
 * case-insensitively match against. Curated to "user-facing inbound" events
 * (something arriving from outside Raven), not Raven's own internal state
 * transitions:
 *
 *   email:new                      -> `${subject} ${snippet}`
 *   financial:transaction:recorded -> description
 *   gdrive:new-file                -> name
 *   media:received                 -> `${fileName} ${caption ?? ''}`
 *   task:created / task:completed  -> title
 */
export const MATCHED_EVENT_TYPES = [
  'email:new',
  'financial:transaction:recorded',
  'gdrive:new-file',
  'media:received',
  'task:created',
  'task:completed',
] as const;

export function extractMatchText(event: RavenEvent): string | undefined {
  switch (event.type) {
    case 'email:new':
      return `${event.payload.subject} ${event.payload.snippet}`;
    case 'financial:transaction:recorded':
      return event.payload.description;
    case 'gdrive:new-file':
      return event.payload.name;
    case 'media:received':
      return [event.payload.fileName, event.payload.caption].filter(Boolean).join(' ');
    case 'task:created':
    case 'task:completed':
      return event.payload.title;
    default:
      return undefined;
  }
}

/** ALL keywords must appear (case-insensitive substring match). An intent
 * with zero keywords never matches anything — that shape should be
 * unreachable via create_intent (kind='event' requires >=1 keyword), but a
 * defensive false here is safer than "matches every event of this type." */
export function matchesAllKeywords(text: string, keywords: string[]): boolean {
  if (keywords.length === 0) return false;
  const haystack = text.toLowerCase();
  return keywords.every((k) => haystack.includes(k.toLowerCase()));
}

function truncate(text: string): string {
  return text.length > TRIGGER_CONTEXT_MAX_LEN
    ? `${text.slice(0, TRIGGER_CONTEXT_MAX_LEN)}…`
    : text;
}

function buildNotificationBody(intent: Intent, triggerContext: string): string {
  return `${intent.message}\n\n_(${triggerContext})_`;
}

const NOTIFICATION_SOURCE = 'intent-matcher';

function emitReminder(eventBus: EventBusInterface, intent: Intent, triggerContext: string): void {
  eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: NOTIFICATION_SOURCE,
    type: 'notification',
    payload: {
      channel: 'telegram',
      title: 'Reminder',
      body: buildNotificationBody(intent, triggerContext),
    },
  });
  log.info(
    `Intent ${intent.id} fired (${String(intent.firesUsed + 1)}/${String(intent.fireBudget)})`,
  );
}

export interface MatcherDeps {
  intentStore: IntentStore;
  eventBus: EventBusInterface;
}

/** Checks every active kind='event' intent declared against this event's
 * type; on an all-keywords match, attempts the guarded fire and — only if
 * that succeeded (budget/cooldown/expiry all passed) — emits the
 * notification. Exported for direct unit testing without a live event bus. */
export function checkEventIntents(deps: MatcherDeps, event: RavenEvent, nowMs = Date.now()): void {
  const { intentStore, eventBus } = deps;
  const text = extractMatchText(event);
  if (text === undefined) return;

  const candidates = intentStore
    .listActive()
    .filter((i) => i.kind === 'event' && i.eventTypes.includes(event.type));

  for (const intent of candidates) {
    if (!matchesAllKeywords(text, intent.keywords)) continue;
    if (!intentStore.tryFire(intent.id, nowMs)) continue;
    emitReminder(eventBus, intent, `${event.type}: ${truncate(text)}`);
  }
}

/** Minute sweep: fires any kind='time' intent whose nextFireAt has arrived,
 * then flips stale-expired rows. Exported for direct unit testing. */
export function runTimeSweep(deps: MatcherDeps, nowMs = Date.now()): void {
  const { intentStore, eventBus } = deps;
  for (const intent of intentStore.listDueTimeIntents(nowMs)) {
    if (!intentStore.tryFire(intent.id, nowMs)) continue;
    emitReminder(eventBus, intent, 'scheduled reminder');
  }

  const expiredCount = intentStore.expireStale(nowMs);
  if (expiredCount > 0) log.info(`${String(expiredCount)} intent(s) expired`);
}

let sweepJob: Cron | null = null;
let subscribedTypes: string[] = [];
let boundHandler: ((event: unknown) => void) | null = null;
let boundEventBus: EventBusInterface | null = null;

function readIntentStore(context: ServiceContext): IntentStore | undefined {
  return (context.config as { intentStore?: IntentStore }).intentStore;
}

const service: RavenService = {
  async start(context: ServiceContext): Promise<void> {
    const intentStore = readIntentStore(context);
    if (!intentStore) {
      log.error('intentStore not available in service config — intent matcher disabled');
      return;
    }

    const eventBus = context.eventBus;
    boundEventBus = eventBus;
    const matcherDeps: MatcherDeps = { intentStore, eventBus };

    const handler = (event: unknown): void => {
      checkEventIntents(matcherDeps, event as RavenEvent);
    };
    boundHandler = handler;
    subscribedTypes = [...MATCHED_EVENT_TYPES];
    for (const type of subscribedTypes) eventBus.on(type, handler);

    sweepJob = new Cron(SWEEP_CRON, () => {
      runTimeSweep(matcherDeps);
    });

    log.info(
      `Intent matcher started (listening: ${subscribedTypes.join(', ')}; minute sweep active)`,
    );
  },

  async stop(): Promise<void> {
    if (sweepJob) {
      sweepJob.stop();
      sweepJob = null;
    }
    if (boundEventBus && boundHandler) {
      for (const type of subscribedTypes) boundEventBus.off(type, boundHandler);
    }
    subscribedTypes = [];
    boundHandler = null;
    boundEventBus = null;
    log.info('Intent matcher stopped');
  },
};

export default service;
