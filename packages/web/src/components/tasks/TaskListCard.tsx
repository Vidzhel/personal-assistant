'use client';

import type { RavenTaskRecord } from '@/lib/api-client';

const MS_PER_MINUTE = 60000;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

const STATUS_COLORS: Record<string, string> = {
  todo: 'var(--text-muted)',
  in_progress: 'var(--warning)',
  completed: 'var(--success)',
  archived: 'var(--text-muted)',
};

const SOURCE_LABELS: Record<string, string> = {
  manual: 'Manual',
  agent: 'Agent',
  template: 'Template',
  ticktick: 'TickTick',
  pipeline: 'Pipeline',
};

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / MS_PER_MINUTE);
  if (mins < 1) return 'just now';
  if (mins < MINUTES_PER_HOUR) return `${mins}m ago`;
  const hrs = Math.floor(mins / MINUTES_PER_HOUR);
  if (hrs < HOURS_PER_DAY) return `${hrs}h ago`;
  const days = Math.floor(hrs / HOURS_PER_DAY);
  return `${days}d ago`;
}

interface TaskListCardProps {
  task: RavenTaskRecord;
  onSelect: (id: string) => void;
  subtaskCount?: number;
}

// eslint-disable-next-line max-lines-per-function -- card renders title, description, source badge, relative time, project, agent, and subtask count
export function TaskListCard({ task, onSelect, subtaskCount }: TaskListCardProps) {
  return (
    <button
      onClick={() => onSelect(task.id)}
      className="w-full text-left p-3 rounded-lg border transition-colors"
      style={{
        background: 'var(--bg-secondary)',
        borderColor: 'var(--border)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--bg-hover)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'var(--bg-secondary)';
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ background: STATUS_COLORS[task.status] ?? 'var(--text-muted)' }}
            />
            <span className="font-medium text-sm truncate">{task.title}</span>
          </div>

          {task.description && (
            <p className="text-xs mt-1 truncate pl-4" style={{ color: 'var(--text-muted)' }}>
              {task.description}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <span
            className="text-xs px-1.5 py-0.5 rounded"
            style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)' }}
          >
            {SOURCE_LABELS[task.source] ?? task.source}
          </span>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {formatRelativeTime(task.createdAt)}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-3 mt-2 pl-4">
        {task.projectId && (
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {task.projectId}
          </span>
        )}
        {task.assignedAgentId && (
          <span className="text-xs" style={{ color: 'var(--accent)' }}>
            {task.assignedAgentId}
          </span>
        )}
        {subtaskCount !== undefined && subtaskCount > 0 && (
          <span
            className="text-xs px-1.5 py-0.5 rounded"
            style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)' }}
          >
            {subtaskCount} subtask{subtaskCount !== 1 ? 's' : ''}
          </span>
        )}
      </div>
    </button>
  );
}
