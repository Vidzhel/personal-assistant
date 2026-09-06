import type { RavenService } from './types.ts';
import maintenanceRunner from './orchestrator/maintenance-runner.ts';
import briefingFormatter from './daily-briefing/briefing-formatter.ts';
import imapWatcher from './email/imap-watcher.ts';
import replyComposer from './email/reply-composer.ts';
import emailTriage from './email/email-triage.ts';
import actionExtractor from './email/action-extractor.ts';
import transactionSync from './financial-tracking/transaction-sync.ts';
import voiceTranscriber from './gemini-transcription/voice-transcriber.ts';
import emailWatcher from './google-workspace/email-watcher.ts';
import driveWatcher from './google-workspace/drive-watcher.ts';
import deliveryScheduler from './notifications/delivery-scheduler.ts';
import engagementTracker from './notifications/engagement-tracker.ts';
import snoozeSuggester from './notifications/snooze-suggester.ts';
import telegramBot from './notifications/telegram-bot.ts';
import mediaRouter from './notifications/media-router.ts';
import dataCollector from './proactive-intelligence/data-collector.ts';
import insightProcessor from './proactive-intelligence/insight-processor.ts';
import crossDomainDetector from './proactive-intelligence/cross-domain-detector.ts';
import autonomousManager from './task-management/autonomous-manager.ts';
import intentMatcher from '../intents/intent-matcher.ts';

/**
 * A background service Raven starts at boot. Replaces the former
 * suite-declared `services: [...]` + dynamic `import()` — every service is
 * now a compiled, type-checked, statically-imported module. `requiresEnv`
 * gates startup declaratively (see `services/runner.ts`): all listed vars
 * must be present in `process.env` or the service is skipped with a log
 * line, exactly as suites with missing env vars failed to load today.
 *
 * `RAVEN_DISABLED_SERVICES` (comma-separated `name`s, checked BEFORE
 * `requiresEnv`) is an operator kill switch for disabling one service by
 * name — e.g. `RAVEN_DISABLED_SERVICES=autonomous-manager,drive-watcher` —
 * without having to unset env vars that other services also depend on (see
 * `services/runner.ts`'s `createServiceRunner`).
 */
export interface ServiceDefinition {
  name: string;
  description: string;
  requiresEnv: string[];
  start: RavenService['start'];
  stop: RavenService['stop'];
}

const GMAIL_ENV = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'];
const TELEGRAM_ENV = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
const TICKTICK_ENV = ['TICKTICK_MCP_TOKEN'];

function fromService(def: {
  name: string;
  description: string;
  requiresEnv: string[];
  service: RavenService;
}): ServiceDefinition {
  return {
    name: def.name,
    description: def.description,
    requiresEnv: def.requiresEnv,
    start: def.service.start,
    stop: def.service.stop,
  };
}

/** Every background service Raven can run, declarative env-gating included. */
export const SERVICE_DEFINITIONS: ServiceDefinition[] = [
  fromService({
    name: 'maintenance-runner',
    description: 'Scheduled system maintenance report (logs, dependencies, resources, conventions)',
    requiresEnv: [],
    service: maintenanceRunner,
  }),
  fromService({
    name: 'briefing-formatter',
    description: 'Formats the daily morning briefing (tasks, emails, suggestions)',
    requiresEnv: [],
    service: briefingFormatter,
  }),
  fromService({
    name: 'imap-watcher',
    description: 'Watches Gmail via IMAP for new mail',
    requiresEnv: ['GMAIL_IMAP_USER', 'GMAIL_IMAP_PASSWORD'],
    service: imapWatcher,
  }),
  fromService({
    name: 'reply-composer',
    description: 'Composes and sends email reply drafts',
    requiresEnv: GMAIL_ENV,
    service: replyComposer,
  }),
  fromService({
    name: 'email-triage',
    description: 'Rule-based triage and categorization of incoming email',
    requiresEnv: GMAIL_ENV,
    service: emailTriage,
  }),
  fromService({
    name: 'action-extractor',
    description: 'Extracts actionable follow-ups from email threads',
    requiresEnv: GMAIL_ENV,
    service: actionExtractor,
  }),
  fromService({
    name: 'transaction-sync',
    description: 'Syncs bank transactions (Monobank, PrivatBank) to YNAB',
    requiresEnv: ['YNAB_ACCESS_TOKEN'],
    service: transactionSync,
  }),
  fromService({
    name: 'voice-transcriber',
    description: 'Transcribes voice messages and files via Google Gemini',
    requiresEnv: ['GOOGLE_API_KEY'],
    service: voiceTranscriber,
  }),
  fromService({
    name: 'email-watcher',
    description: 'Watches Gmail via the Google Workspace CLI',
    requiresEnv: ['GWS_PRIMARY_CREDENTIALS_FILE'],
    service: emailWatcher,
  }),
  fromService({
    name: 'drive-watcher',
    description: 'Watches Google Drive folders for new files',
    requiresEnv: ['GWS_PRIMARY_CREDENTIALS_FILE'],
    service: driveWatcher,
  }),
  fromService({
    name: 'delivery-scheduler',
    description: 'Batches and schedules notification delivery windows',
    requiresEnv: TELEGRAM_ENV,
    service: deliveryScheduler,
  }),
  fromService({
    name: 'engagement-tracker',
    description: 'Tracks notification engagement to detect low-engagement periods',
    requiresEnv: TELEGRAM_ENV,
    service: engagementTracker,
  }),
  fromService({
    name: 'snooze-suggester',
    description: 'Suggests snoozing noisy notification categories',
    requiresEnv: TELEGRAM_ENV,
    service: snoozeSuggester,
  }),
  fromService({
    name: 'telegram-bot',
    description: 'Telegram bot: inline commands, replies, and delivery',
    requiresEnv: TELEGRAM_ENV,
    service: telegramBot,
  }),
  fromService({
    name: 'media-router',
    description: 'Routes received photos/documents to the right handler',
    requiresEnv: TELEGRAM_ENV,
    service: mediaRouter,
  }),
  fromService({
    name: 'data-collector',
    description: 'Collects cross-service data points for pattern analysis',
    requiresEnv: [],
    service: dataCollector,
  }),
  fromService({
    name: 'insight-processor',
    description: 'Processes collected data into proactive insights',
    requiresEnv: [],
    service: insightProcessor,
  }),
  fromService({
    name: 'cross-domain-detector',
    description: 'Detects cross-domain knowledge links above an adaptive confidence threshold',
    requiresEnv: [],
    service: crossDomainDetector,
  }),
  fromService({
    name: 'autonomous-manager',
    description: 'Autonomous TickTick task triage and cleanup recommendations',
    requiresEnv: TICKTICK_ENV,
    service: autonomousManager,
  }),
  fromService({
    name: 'intent-matcher',
    description:
      'Deterministic prospective-memory matcher: fires owner-created intents (event keyword matches, time sweeps) with budget/cooldown/expiry — zero model calls',
    requiresEnv: [],
    service: intentMatcher,
  }),
];
