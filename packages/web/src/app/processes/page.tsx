'use client';

import { useCallback } from 'react';
import { api, type ActiveTaskInfo, type ActiveTasks } from '@/lib/api-client';
import { usePolling } from '@/hooks/usePolling';

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const TASK_ID_DISPLAY_LENGTH = 8;
const REFRESH_INTERVAL_MS = 3000;

function formatDuration(ms?: number): string {
  if (!ms) return '-';
  const seconds = Math.floor(ms / MS_PER_SECOND);
  if (seconds < SECONDS_PER_MINUTE) return `${seconds}s`;
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  const remaining = seconds % SECONDS_PER_MINUTE;
  return `${minutes}m ${remaining}s`;
}

// eslint-disable-next-line max-lines-per-function -- table component with status badges and duration formatting
function TaskTable({
  title,
  tasks,
  onCancel,
}: {
  title: string;
  tasks: ActiveTaskInfo[];
  onCancel: (taskId: string) => void;
}) {
  if (tasks.length === 0) {
    return (
      <div className="mb-6">
        <h2 className="text-sm font-bold mb-2" style={{ color: 'var(--text)' }}>
          {title}
        </h2>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          None
        </p>
      </div>
    );
  }

  return (
    <div className="mb-6">
      <h2 className="text-sm font-bold mb-2" style={{ color: 'var(--text)' }}>
        {title} ({tasks.length})
      </h2>
      <div
        className="rounded-lg border overflow-hidden"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-card)' }}
      >
        <table className="w-full text-xs">
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              <th className="text-left px-3 py-2" style={{ color: 'var(--text-muted)' }}>
                Task ID
              </th>
              <th className="text-left px-3 py-2" style={{ color: 'var(--text-muted)' }}>
                Skill
              </th>
              <th className="text-left px-3 py-2" style={{ color: 'var(--text-muted)' }}>
                Priority
              </th>
              <th className="text-left px-3 py-2" style={{ color: 'var(--text-muted)' }}>
                Duration
              </th>
              <th className="text-right px-3 py-2" style={{ color: 'var(--text-muted)' }}>
                Action
              </th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr key={task.taskId} style={{ borderBottom: '1px solid var(--border)' }}>
                <td className="px-3 py-2 font-mono" style={{ color: 'var(--text)' }}>
                  {task.taskId.slice(0, TASK_ID_DISPLAY_LENGTH)}
                </td>
                <td className="px-3 py-2" style={{ color: 'var(--text)' }}>
                  {task.skillName}
                </td>
                <td className="px-3 py-2" style={{ color: 'var(--text-muted)' }}>
                  {task.priority}
                </td>
                <td className="px-3 py-2" style={{ color: 'var(--text-muted)' }}>
                  {formatDuration(task.durationMs)}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => onCancel(task.taskId)}
                    className="px-2 py-0.5 rounded text-xs font-medium"
                    style={{ background: '#ef4444', color: 'white' }}
                  >
                    Cancel
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function ProcessesPage() {
  const {
    data,
    error: pollError,
    refresh,
  } = usePolling<ActiveTasks>('/agent-tasks/active', REFRESH_INTERVAL_MS);
  const running = data?.running ?? [];
  const queued = data?.queued ?? [];
  const error = pollError?.message ?? null;

  const handleCancel = useCallback(
    (taskId: string) => {
      api.cancelTask(taskId).then(refresh).catch(refresh);
    },
    [refresh],
  );

  return (
    <div className="p-6 max-w-4xl">
      <h1 className="text-lg font-bold mb-4" style={{ color: 'var(--text)' }}>
        Processes
      </h1>
      {error && (
        <p className="text-xs mb-4" style={{ color: '#ef4444' }}>
          Error: {error}
        </p>
      )}
      <TaskTable title="Running" tasks={running} onCancel={handleCancel} />
      <TaskTable title="Queued" tasks={queued} onCancel={handleCancel} />
    </div>
  );
}
