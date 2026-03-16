'use client';

import {
  getTaskStatusColor,
  getTaskStatusIcon,
  truncatePrompt,
  formatTaskDuration,
  isHighPriority,
  getTaskPriorityLabel,
  getTaskPriorityColor,
} from '@/lib/task-helpers';
import { formatRelativeTime } from '@/lib/event-helpers';

const TASK_ID_DISPLAY_LENGTH = 8;
const FONT_WEIGHT_BOLD = 700;
const FONT_WEIGHT_NORMAL = 400;

interface TaskCardTask {
  id: string;
  skillName: string;
  prompt?: string;
  status: string;
  priority: string;
  createdAt: number | string;
  durationMs?: number;
  errors?: string[];
}

function StatusCircle({ status }: { status: string }) {
  const isRunning = status === 'running';
  return (
    <span
      className={`flex items-center justify-center w-7 h-7 rounded-full font-mono text-xs font-bold shrink-0 ${isRunning ? 'pipeline-running' : ''}`}
      style={{
        background: 'var(--bg)',
        color: getTaskStatusColor(status),
        border: `1px solid ${getTaskStatusColor(status)}`,
      }}
    >
      {getTaskStatusIcon(status)}
    </span>
  );
}

function PriorityBadge({ priority }: { priority: string }) {
  if (priority === 'normal' || priority === 'low') return null;
  return (
    <span
      className="text-xs px-1.5 py-0.5 rounded font-medium"
      style={{
        color: getTaskPriorityColor(priority),
        border: `1px solid ${getTaskPriorityColor(priority)}`,
        fontWeight: isHighPriority(priority) ? FONT_WEIGHT_BOLD : FONT_WEIGHT_NORMAL,
      }}
    >
      {getTaskPriorityLabel(priority)}
    </span>
  );
}

function ErrorSummary({ errors }: { errors?: string[] }) {
  if (!errors || errors.length === 0) return null;
  const firstLine = errors[0].split('\n')[0];
  return (
    <p className="text-xs mt-1 truncate" style={{ color: 'var(--error)' }}>
      {firstLine}
    </p>
  );
}

function CardMeta({ task }: { task: TaskCardTask }) {
  const timestamp =
    typeof task.createdAt === 'string' ? new Date(task.createdAt).getTime() : task.createdAt;
  return (
    <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
      <span>{formatRelativeTime(timestamp)}</span>
      {task.durationMs != null && <span>{formatTaskDuration(task.durationMs)}</span>}
      <span className="font-mono">{task.id.slice(0, TASK_ID_DISPLAY_LENGTH)}</span>
    </div>
  );
}

export function TaskCard({
  task,
  onSelect,
}: {
  task: TaskCardTask;
  onSelect: (id: string) => void;
}) {
  return (
    <div
      className="p-3 rounded-lg cursor-pointer transition-colors hover:brightness-110"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
      onClick={() => onSelect(task.id)}
    >
      <div className="flex items-center gap-3">
        <StatusCircle status={task.status} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">{task.skillName}</span>
            <PriorityBadge priority={task.priority} />
          </div>
          {task.prompt && (
            <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>
              {truncatePrompt(task.prompt)}
            </p>
          )}
          {task.status === 'failed' && <ErrorSummary errors={task.errors} />}
        </div>
      </div>
      <CardMeta task={task} />
    </div>
  );
}
