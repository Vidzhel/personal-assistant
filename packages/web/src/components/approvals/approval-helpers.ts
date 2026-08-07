const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

const MINUTE_MS = SECONDS_PER_MINUTE * MS_PER_SECOND;
const HOUR_MS = MINUTES_PER_HOUR * MINUTE_MS;
const DAY_MS = HOURS_PER_DAY * HOUR_MS;

// Formats a PendingApproval.requestedAt (ISO string) as a short relative
// age for the inbox row — "just now", "5m ago", "3h ago", "2d ago".
// `now` is injectable for deterministic tests.
export function formatApprovalAge(requestedAt: string, now: number = Date.now()): string {
  const ms = Math.max(0, now - new Date(requestedAt).getTime());

  if (ms < MINUTE_MS) return 'just now';
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)}m ago`;
  if (ms < DAY_MS) return `${Math.floor(ms / HOUR_MS)}h ago`;
  return `${Math.floor(ms / DAY_MS)}d ago`;
}
