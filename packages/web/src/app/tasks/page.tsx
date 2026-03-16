'use client';

import { useState } from 'react';
import { type ActiveTasks, type TaskRecord } from '@/lib/api-client';
import { usePolling } from '@/hooks/usePolling';
import { TaskCard } from '@/components/tasks/TaskCard';
import { TaskDetail } from '@/components/tasks/TaskDetail';
import { getTaskStatusColor } from '@/lib/task-helpers';

const ACTIVE_POLL_MS = 3000;
const HISTORY_POLL_MS = 10000;
const HISTORY_LIMIT = 20;
const SKELETON_COUNT = 3;

interface ColumnDef {
  key: string;
  label: string;
}

const COLUMNS: ColumnDef[] = [
  { key: 'queued', label: 'Queued' },
  { key: 'running', label: 'Running' },
  { key: 'completed', label: 'Completed' },
  { key: 'failed', label: 'Failed' },
];

interface ActiveTaskItem {
  id: string;
  skillName: string;
  status: string;
  priority: string;
  createdAt: number;
  startedAt?: number;
  durationMs?: number;
}

function normalizeActiveTask(t: {
  taskId: string;
  skillName: string;
  status: string;
  priority: string;
  createdAt: number;
  startedAt?: number;
  durationMs?: number;
}): ActiveTaskItem {
  return {
    id: t.taskId,
    skillName: t.skillName,
    status: t.status,
    priority: t.priority,
    createdAt: t.createdAt,
    startedAt: t.startedAt,
    durationMs: t.durationMs,
  };
}

function ColumnSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
        <div
          key={i}
          className="p-3 rounded-lg animate-pulse"
          style={{ background: 'var(--bg-hover)', height: '72px' }}
        />
      ))}
    </div>
  );
}

function ColumnHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <span
        className="w-2 h-2 rounded-full"
        style={{ background: getTaskStatusColor(label.toLowerCase()) }}
      />
      <h2 className="text-sm font-semibold">{label}</h2>
      <span
        className="text-xs px-1.5 py-0.5 rounded"
        style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)' }}
      >
        {count}
      </span>
    </div>
  );
}

function EmptyColumn({ status }: { status: string }) {
  return (
    <p className="text-xs py-4 text-center" style={{ color: 'var(--text-muted)' }}>
      No {status} tasks
    </p>
  );
}

// eslint-disable-next-line max-lines-per-function -- page component with 4 columns, polling, and detail panel
export default function TasksPage() {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const {
    data: activeTasks,
    loading: activeLoading,
    refresh: refreshActive,
  } = usePolling<ActiveTasks>('/agent-tasks/active', ACTIVE_POLL_MS);

  const {
    data: completedTasks,
    loading: completedLoading,
    refresh: refreshCompleted,
  } = usePolling<TaskRecord[]>(
    `/agent-tasks?status=completed&limit=${HISTORY_LIMIT}`,
    HISTORY_POLL_MS,
  );

  const {
    data: failedTasks,
    loading: failedLoading,
    refresh: refreshFailed,
  } = usePolling<TaskRecord[]>(
    `/agent-tasks?status=failed&limit=${HISTORY_LIMIT}`,
    HISTORY_POLL_MS,
  );

  const queued = (activeTasks?.queued ?? []).map(normalizeActiveTask);
  const running = (activeTasks?.running ?? []).map(normalizeActiveTask);

  const handleSelect = (id: string): void => {
    setSelectedTaskId(id);
  };

  const handleRefresh = (): void => {
    refreshActive();
    refreshCompleted();
    refreshFailed();
  };

  const getColumnTasks = (key: string): Array<ActiveTaskItem | TaskRecord> => {
    if (key === 'queued') return queued;
    if (key === 'running') return running;
    if (key === 'completed') return completedTasks ?? [];
    if (key === 'failed') return failedTasks ?? [];
    return [];
  };

  const isColumnLoading = (key: string): boolean => {
    if (key === 'queued' || key === 'running') return activeLoading;
    if (key === 'completed') return completedLoading;
    if (key === 'failed') return failedLoading;
    return false;
  };

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Agent Tasks</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
          Kanban board of active and completed agent tasks.
        </p>
      </div>

      {selectedTaskId && (
        <TaskDetail
          taskId={selectedTaskId}
          onClose={() => setSelectedTaskId(null)}
          onRefresh={handleRefresh}
        />
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {COLUMNS.map((col) => {
          const tasks = getColumnTasks(col.key);
          const loading = isColumnLoading(col.key);
          return (
            <div key={col.key} className="min-h-48">
              <ColumnHeader label={col.label} count={tasks.length} />
              {loading ? (
                <ColumnSkeleton />
              ) : tasks.length === 0 ? (
                <EmptyColumn status={col.key} />
              ) : (
                <div className="space-y-2">
                  {tasks.map((task) => {
                    const id = 'id' in task ? task.id : (task as ActiveTaskItem).id;
                    return (
                      <TaskCard
                        key={id}
                        task={{
                          ...task,
                          id,
                          prompt: 'prompt' in task ? task.prompt : undefined,
                          errors: 'errors' in task ? task.errors : undefined,
                        }}
                        onSelect={handleSelect}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
