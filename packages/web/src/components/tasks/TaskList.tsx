'use client';

import { useEffect } from 'react';
import { useTaskStore } from '@/stores/task-store';
import { usePolling } from '@/hooks/usePolling';
import { TaskFilters } from './TaskFilters';
import { TaskListCard } from './TaskListCard';
import { TaskDetailPanel } from './TaskDetailPanel';
import type { RavenTaskRecord } from '@/lib/api-client';

const TASK_POLL_MS = 10000;

interface StatusGroup {
  status: string;
  label: string;
  tasks: RavenTaskRecord[];
}

function StatusSection({
  group,
  onSelect,
}: {
  group: StatusGroup;
  onSelect: (id: string) => void;
}) {
  if (group.tasks.length === 0) return null;

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <h3 className="text-sm font-semibold">{group.label}</h3>
        <span
          className="text-xs px-1.5 py-0.5 rounded"
          style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)' }}
        >
          {group.tasks.length}
        </span>
      </div>
      <div className="space-y-1.5">
        {group.tasks.map((task) => (
          <TaskListCard key={task.id} task={task} onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
}

// eslint-disable-next-line max-lines-per-function, complexity -- builds filter query, polls tasks, groups by status, and renders sections with detail panel
export function TaskList() {
  const { tasks, fetchTasks, fetchCounts, selectTask, selectedTask, filters } = useTaskStore();

  // Build filter query string for polling
  const filterQs = new URLSearchParams();
  if (filters.status) filterQs.set('status', filters.status);
  if (filters.projectId) filterQs.set('projectId', filters.projectId);
  if (filters.source) filterQs.set('source', filters.source);
  if (filters.search) filterQs.set('search', filters.search);
  if (filters.includeArchived) filterQs.set('includeArchived', 'true');

  // Use polling to keep tasks fresh
  const { data: polledTasks } = usePolling<RavenTaskRecord[]>(`/tasks?${filterQs}`, TASK_POLL_MS);

  useEffect(() => {
    void fetchTasks();
    void fetchCounts();
  }, [fetchTasks, fetchCounts]);

  // Use polled data if available, otherwise store data
  const displayTasks = polledTasks ?? tasks;

  // Group by status
  const groups: StatusGroup[] = [
    {
      status: 'in_progress',
      label: 'In Progress',
      tasks: displayTasks.filter((t) => t.status === 'in_progress'),
    },
    { status: 'todo', label: 'To Do', tasks: displayTasks.filter((t) => t.status === 'todo') },
    {
      status: 'completed',
      label: 'Completed',
      tasks: displayTasks.filter((t) => t.status === 'completed'),
    },
  ];

  const archived = displayTasks.filter((t) => t.status === 'archived');

  return (
    <div className="space-y-4">
      <TaskFilters />

      {displayTasks.length === 0 ? (
        <p className="text-sm py-8 text-center" style={{ color: 'var(--text-muted)' }}>
          No tasks found
        </p>
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <StatusSection key={g.status} group={g} onSelect={selectTask} />
          ))}
        </div>
      )}

      {archived.length > 0 && filters.includeArchived && (
        <StatusSection
          group={{ status: 'archived', label: 'Archived', tasks: archived }}
          onSelect={selectTask}
        />
      )}

      {selectedTask && <TaskDetailPanel />}
    </div>
  );
}
