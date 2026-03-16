const STATUS_COLOR_MAP: Record<string, string> = {
  completed: 'var(--success)',
  failed: 'var(--error)',
  running: 'var(--warning)',
  cancelled: 'var(--text-muted)',
};

export function getPipelineStatusColor(status: string): string {
  return STATUS_COLOR_MAP[status] ?? 'var(--text-muted)';
}

const STATUS_ICON_MAP: Record<string, string> = {
  completed: '+',
  failed: 'x',
  running: '~',
  cancelled: '-',
  pending: '.',
  skipped: '/',
};

export function getPipelineStatusIcon(status: string): string {
  return STATUS_ICON_MAP[status] ?? '?';
}

export function getTriggerLabel(trigger: {
  type: string;
  schedule?: string;
  event?: string;
}): string {
  if (trigger.type === 'cron' && trigger.schedule) return `Cron: ${trigger.schedule}`;
  if (trigger.type === 'event' && trigger.event) return `Event: ${trigger.event}`;
  if (trigger.type === 'webhook') return 'Webhook';
  if (trigger.type === 'manual') return 'Manual';
  return trigger.type;
}

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MS_PER_MINUTE = MS_PER_SECOND * SECONDS_PER_MINUTE;

export function formatDuration(ms: number): string {
  if (ms < MS_PER_SECOND) return `${ms}ms`;
  if (ms < MS_PER_MINUTE) return `${(ms / MS_PER_SECOND).toFixed(1)}s`;
  const minutes = Math.floor(ms / MS_PER_MINUTE);
  const seconds = Math.round((ms % MS_PER_MINUTE) / MS_PER_SECOND);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export interface NodeResult {
  name: string;
  status: string;
  output?: unknown;
  error?: string;
  durationMs?: number;
}

export function parseNodeResults(nodeResultsJson: string | null): NodeResult[] {
  if (!nodeResultsJson) return [];
  try {
    const parsed = JSON.parse(nodeResultsJson) as Record<
      string,
      { status: string; output?: unknown; error?: string; durationMs?: number }
    >;
    return Object.entries(parsed).map(([name, data]) => ({
      name,
      status: data.status,
      output: data.output,
      error: data.error,
      durationMs: data.durationMs,
    }));
  } catch {
    return [];
  }
}
