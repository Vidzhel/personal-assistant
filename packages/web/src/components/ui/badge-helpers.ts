export interface BadgeStyle {
  label: string;
  bg: string;
  fg: string;
}

type Tone = 'neutral' | 'info' | 'warning' | 'success' | 'error' | 'accent';

const TONE: Record<Tone, { bg: string; fg: string }> = {
  neutral: { bg: 'var(--bg-hover)', fg: 'var(--text-muted)' },
  info: { bg: 'rgba(59,130,246,0.2)', fg: 'rgb(96,165,250)' },
  warning: { bg: 'rgba(234,179,8,0.2)', fg: 'rgb(250,204,21)' },
  success: { bg: 'rgba(34,197,94,0.2)', fg: 'rgb(74,222,128)' },
  error: { bg: 'rgba(239,68,68,0.2)', fg: 'rgb(248,113,113)' },
  accent: { bg: 'rgba(168,85,247,0.2)', fg: 'rgb(192,132,252)' },
};

const STATUS: Record<string, { tone: Tone; label: string }> = {
  todo: { tone: 'neutral', label: 'To Do' },
  pending: { tone: 'neutral', label: 'Pending' },
  ready: { tone: 'info', label: 'Ready' },
  in_progress: { tone: 'warning', label: 'In Progress' },
  running: { tone: 'warning', label: 'Running' },
  validating: { tone: 'info', label: 'Validating' },
  completed: { tone: 'success', label: 'Completed' },
  failed: { tone: 'error', label: 'Failed' },
  blocked: { tone: 'error', label: 'Blocked' },
  skipped: { tone: 'neutral', label: 'Skipped' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
  archived: { tone: 'neutral', label: 'Archived' },
  pending_approval: { tone: 'accent', label: 'Needs Approval' },
  'waiting-approval': { tone: 'accent', label: 'Needs Approval' },
};

const SOURCE: Record<string, { tone: Tone; label: string }> = {
  manual: { tone: 'neutral', label: 'Manual' },
  agent: { tone: 'info', label: 'Agent' },
  template: { tone: 'accent', label: 'Template' },
  ticktick: { tone: 'info', label: 'TickTick' },
  pipeline: { tone: 'accent', label: 'Pipeline' },
  scheduled: { tone: 'warning', label: 'Scheduled' },
  schedule: { tone: 'warning', label: 'Scheduled' },
  plan: { tone: 'accent', label: 'Plan' },
};

function toStyle(entry: { tone: Tone; label: string } | undefined, raw: string): BadgeStyle {
  if (!entry) return { label: raw, bg: TONE.neutral.bg, fg: TONE.neutral.fg };
  return { label: entry.label, bg: TONE[entry.tone].bg, fg: TONE[entry.tone].fg };
}

export function statusBadgeProps(status: string): BadgeStyle {
  return toStyle(STATUS[status], status);
}

export function sourceBadgeProps(source: string): BadgeStyle {
  return toStyle(SOURCE[source], source);
}
