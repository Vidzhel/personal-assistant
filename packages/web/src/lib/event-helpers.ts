import type { EventRecord } from './api-client.ts';

const SUBJECT_TRUNCATE_LEN = 60;

const ICON_MAP: Array<[string, string]> = [
  ['email:', '@'],
  ['pipeline:', '|'],
  ['agent:', '>'],
  ['schedule:', '#'],
  ['permission:', '!'],
  ['task-management:', '+'],
  ['voice:', '~'],
  ['media:', '*'],
  ['notification', '^'],
  ['config:', '%'],
  ['system:', '&'],
];

/** Maps event type prefix to a display character icon */
export function getEventIcon(type: string): string {
  return ICON_MAP.find(([prefix]) => type.startsWith(prefix))?.[1] ?? '?';
}

const EXACT_COLOR_MAP: Record<string, string> = {
  'pipeline:complete': 'var(--success)',
  'pipeline:failed': 'var(--error)',
  'pipeline:step:failed': 'var(--error)',
  'agent:task:complete': 'var(--success)',
  'permission:denied': 'var(--error)',
  'system:health:alert': 'var(--error)',
};

const PREFIX_COLOR_MAP: Array<[string, string]> = [
  ['pipeline:', 'var(--warning)'],
  ['agent:', 'var(--accent-hover)'],
  ['permission:', 'var(--warning)'],
  ['email:', 'var(--accent)'],
];

/** Maps event type to a CSS variable color */
export function getEventColor(type: string): string {
  return (
    EXACT_COLOR_MAP[type] ??
    PREFIX_COLOR_MAP.find(([prefix]) => type.startsWith(prefix))?.[1] ??
    'var(--text-muted)'
  );
}

/** Safely access a property from an unknown payload */
function p(payload: unknown, key: string): string {
  if (payload && typeof payload === 'object' && key in payload) {
    return String((payload as Record<string, unknown>)[key] ?? '');
  }
  return '';
}

/** Truncate string to max length */
function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + '…' : str;
}

type DescriptionFormatter = (payload: unknown) => string;

const DESCRIPTION_MAP: Record<string, DescriptionFormatter> = {
  'email:new': (pl) =>
    `New email from ${p(pl, 'from')}: ${truncate(p(pl, 'subject'), SUBJECT_TRUNCATE_LEN)}`,
  'email:triage:processed': (pl) => `Email triaged: ${p(pl, 'category')}`,
  'email:triage:action-items': () => 'Action items extracted from email',
  'email:action-extract:completed': () => 'Email action extraction completed',
  'email:reply:send': () => 'Email reply sent',
  'pipeline:started': (pl) => `Pipeline '${p(pl, 'pipelineName')}' started`,
  'pipeline:complete': (pl) => `Pipeline '${p(pl, 'pipelineName')}' completed`,
  'pipeline:failed': (pl) => `Pipeline '${p(pl, 'pipelineName')}' failed: ${p(pl, 'error')}`,
  'pipeline:step:complete': (pl) => `Pipeline step completed: ${p(pl, 'stepName')}`,
  'pipeline:step:failed': (pl) => `Pipeline step failed: ${p(pl, 'stepName')}`,
  'agent:task:complete': (pl) => `Agent task completed (${p(pl, 'skillName')})`,
  'agent:task:request': (pl) => `Agent task requested (${p(pl, 'skillName')})`,
  'agent:message': (pl) => `Agent message from ${p(pl, 'skillName')}`,
  'permission:denied': (pl) => `Permission denied: ${p(pl, 'actionName')}`,
  'permission:approved': (pl) => `Permission approved: ${p(pl, 'actionName')}`,
  'permission:blocked': (pl) => `Permission blocked: ${p(pl, 'actionName')}`,
  'task-management:autonomous:completed': (pl) =>
    `Task management: ${p(pl, 'summary') || p(pl, 'action')}`,
  'task-management:autonomous:failed': (pl) =>
    `Task management failed: ${p(pl, 'error') || p(pl, 'action')}`,
  'schedule:triggered': (pl) => `Schedule triggered: ${p(pl, 'scheduleName')}`,
  'config:reloaded': (pl) => `Configuration reloaded: ${p(pl, 'configType')}`,
  'config:pipelines:reloaded': () => 'Pipeline configuration reloaded',
  'voice:received': () => 'Voice message received',
  'media:received': () => 'Media file received',
  notification: (pl) => `Notification: ${p(pl, 'message') || p(pl, 'summary')}`,
  'system:health:alert': (pl) => `System health alert: ${p(pl, 'message')}`,
};

/** Produces a human-readable one-line description from event type + payload */
export function formatEventDescription(event: EventRecord): string {
  const formatter = DESCRIPTION_MAP[event.type];
  return formatter ? formatter(event.payload) : `${event.type} from ${event.source}`;
}

const SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MINUTE = SECONDS_PER_MINUTE * SECOND;
const HOUR = MINUTES_PER_HOUR * MINUTE;
const DAY = HOURS_PER_DAY * HOUR;
const TWO_DAYS = 2 * DAY;

/** Human-friendly relative time from Unix ms timestamp */
export function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;

  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < TWO_DAYS) return 'yesterday';

  return new Date(timestamp).toLocaleString();
}
