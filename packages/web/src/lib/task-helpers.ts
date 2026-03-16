const STATUS_COLOR_MAP: Record<string, string> = {
  queued: 'var(--text-muted)',
  running: 'var(--warning)',
  completed: 'var(--success)',
  failed: 'var(--error)',
  blocked: 'var(--accent)',
  cancelled: 'var(--text-muted)',
};

export function getTaskStatusColor(status: string): string {
  return STATUS_COLOR_MAP[status] ?? 'var(--text-muted)';
}

const STATUS_ICON_MAP: Record<string, string> = {
  queued: '.',
  running: '~',
  completed: '+',
  failed: 'x',
  blocked: '!',
  cancelled: '-',
};

export function getTaskStatusIcon(status: string): string {
  return STATUS_ICON_MAP[status] ?? '?';
}

const PRIORITY_LABEL_MAP: Record<string, string> = {
  urgent: 'URGENT',
  high: 'High',
  normal: 'Normal',
  low: 'Low',
};

export function getTaskPriorityLabel(priority: string): string {
  return PRIORITY_LABEL_MAP[priority] ?? priority;
}

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MS_PER_MINUTE = MS_PER_SECOND * SECONDS_PER_MINUTE;

export function formatTaskDuration(ms?: number): string {
  if (ms == null) return '';
  if (ms < MS_PER_SECOND) return `${ms}ms`;
  if (ms < MS_PER_MINUTE) return `${(ms / MS_PER_SECOND).toFixed(1)}s`;
  const minutes = Math.floor(ms / MS_PER_MINUTE);
  const seconds = Math.round((ms % MS_PER_MINUTE) / MS_PER_SECOND);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

const DEFAULT_TRUNCATE_LEN = 80;

export function truncatePrompt(prompt: string, maxLen = DEFAULT_TRUNCATE_LEN): string {
  if (prompt.length <= maxLen) return prompt;
  return prompt.slice(0, maxLen) + '…';
}

export function isHighPriority(priority: string): boolean {
  return priority === 'urgent' || priority === 'high';
}

const PRIORITY_COLOR_MAP: Record<string, string> = {
  urgent: 'var(--error)',
  high: 'var(--warning)',
  normal: 'var(--text-muted)',
  low: 'var(--text-muted)',
};

export function getTaskPriorityColor(priority: string): string {
  return PRIORITY_COLOR_MAP[priority] ?? 'var(--text-muted)';
}
