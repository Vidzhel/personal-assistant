'use client';

import { useState } from 'react';
import { type ActiveTasks, type TaskRecord } from '@/lib/api-client';
import { usePolling } from '@/hooks/usePolling';
import { AgentMonitorCard } from './AgentMonitorCard';

const ACTIVE_POLL_MS = 3000;
const HISTORY_LIMIT = 20;
const MS_PER_SECOND = 1000;
const HISTORY_POLL_MULTIPLIER = 3;

function RecentExecution({ task }: { task: TaskRecord }) {
  return (
    <div
      className="flex items-center gap-3 p-2 rounded text-xs"
      style={{ background: 'var(--bg-hover)' }}
    >
      <span
        className="w-2 h-2 rounded-full flex-shrink-0"
        style={{ background: task.status === 'completed' ? 'var(--success)' : 'var(--error)' }}
      />
      <span className="flex-1 truncate">{task.skillName}</span>
      <span style={{ color: 'var(--text-muted)' }}>{task.status}</span>
      {task.durationMs !== undefined && (
        <span className="font-mono" style={{ color: 'var(--text-muted)' }}>
          {task.durationMs < MS_PER_SECOND
            ? `${task.durationMs}ms`
            : `${(task.durationMs / MS_PER_SECOND).toFixed(1)}s`}
        </span>
      )}
    </div>
  );
}

// eslint-disable-next-line max-lines-per-function, complexity -- renders running/queued/recent sections with conditional branches
export function AgentMonitor() {
  const [showRecent, setShowRecent] = useState(false);

  const { data: activeTasks, refresh } = usePolling<ActiveTasks>(
    '/agent-tasks/active',
    ACTIVE_POLL_MS,
  );

  const { data: recentTasks } = usePolling<TaskRecord[]>(
    `/agent-tasks?limit=${HISTORY_LIMIT}`,
    ACTIVE_POLL_MS * HISTORY_POLL_MULTIPLIER,
  );

  const running = activeTasks?.running ?? [];
  const queued = activeTasks?.queued ?? [];
  const recent = (recentTasks ?? []).filter(
    (t) => t.status === 'completed' || t.status === 'failed',
  );

  const isEmpty = running.length === 0 && queued.length === 0;

  return (
    <div className="space-y-6">
      {isEmpty ? (
        <div className="text-center py-12">
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            No agents currently active
          </p>
        </div>
      ) : (
        <>
          {running.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <span className="w-2 h-2 rounded-full" style={{ background: 'var(--warning)' }} />
                <h3 className="text-sm font-semibold">Running ({running.length})</h3>
              </div>
              <div className="space-y-2">
                {running.map((task) => (
                  <AgentMonitorCard
                    key={task.taskId}
                    task={task}
                    section="running"
                    onRefresh={refresh}
                  />
                ))}
              </div>
            </div>
          )}

          {queued.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ background: 'var(--text-muted)' }}
                />
                <h3 className="text-sm font-semibold">Queued ({queued.length})</h3>
              </div>
              <div className="space-y-2">
                {queued.map((task) => (
                  <AgentMonitorCard
                    key={task.taskId}
                    task={task}
                    section="queued"
                    onRefresh={refresh}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Recent Executions */}
      {recent.length > 0 && (
        <div>
          <button
            onClick={() => setShowRecent(!showRecent)}
            className="text-xs font-semibold flex items-center gap-1"
            style={{ color: 'var(--text-muted)' }}
          >
            {showRecent ? 'Hide' : 'Show'} Recent Executions ({recent.length})
          </button>
          {showRecent && (
            <div className="space-y-1 mt-2">
              {recent.map((task) => (
                <RecentExecution key={task.id} task={task} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
