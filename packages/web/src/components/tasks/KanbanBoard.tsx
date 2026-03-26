'use client';

import { useEffect, useCallback, useState } from 'react';
import { api, type RavenTaskRecord } from '@/lib/api-client';
import { usePolling } from '@/hooks/usePolling';
import { TaskListCard } from './TaskListCard';
import { TaskDetailPanel } from './TaskDetailPanel';
import { useTaskStore } from '@/stores/task-store';

const TASK_POLL_MS = 10000;

const STATUS_COLUMNS = [
  { status: 'todo', label: 'To Do', color: 'var(--text-muted)' },
  { status: 'in_progress', label: 'In Progress', color: 'var(--warning)' },
  { status: 'completed', label: 'Completed', color: 'var(--success)' },
] as const;

interface KanbanBoardProps {
  projectId?: string;
}

// eslint-disable-next-line max-lines-per-function -- kanban board with drag-drop, columns, and task detail
export function KanbanBoard({ projectId }: KanbanBoardProps) {
  const { selectTask, selectedTask } = useTaskStore();
  const [tasks, setTasks] = useState<RavenTaskRecord[]>([]);
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);

  const filterQs = new URLSearchParams();
  if (projectId) filterQs.set('projectId', projectId);

  const { data: polledTasks } = usePolling<RavenTaskRecord[]>(`/tasks?${filterQs}`, TASK_POLL_MS);

  useEffect(() => {
    const qs: Record<string, string> = {};
    if (projectId) qs.projectId = projectId;
    void api.getTasks(qs).then(setTasks);
  }, [projectId]);

  const displayTasks = polledTasks ?? tasks;

  const handleDragStart = useCallback((e: React.DragEvent, taskId: string) => {
    e.dataTransfer.setData('text/plain', taskId);
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, status: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverColumn(status);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOverColumn(null);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent, newStatus: string) => {
      e.preventDefault();
      setDragOverColumn(null);
      const taskId = e.dataTransfer.getData('text/plain');
      if (!taskId) return;

      // Optimistic update
      setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, status: newStatus } : t)));

      try {
        await api.updateTask(taskId, { status: newStatus });
      } catch {
        // Revert on failure
        if (projectId) {
          const fresh = await api.getTasks({ projectId });
          setTasks(fresh);
        }
      }
    },
    [projectId],
  );

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 grid grid-cols-3 gap-4 p-4 overflow-y-auto">
        {STATUS_COLUMNS.map((col) => {
          const colTasks = displayTasks.filter((t) => t.status === col.status);
          const isOver = dragOverColumn === col.status;
          return (
            <div
              key={col.status}
              className="flex flex-col rounded-lg border p-3 transition-colors"
              style={{
                background: isOver ? 'var(--bg-hover)' : 'var(--bg-card)',
                borderColor: isOver ? 'var(--accent)' : 'var(--border)',
              }}
              onDragOver={(e) => handleDragOver(e, col.status)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => void handleDrop(e, col.status)}
            >
              <div className="flex items-center gap-2 mb-3">
                <span className="w-2.5 h-2.5 rounded-full" style={{ background: col.color }} />
                <span className="text-sm font-semibold">{col.label}</span>
                <span
                  className="text-xs px-1.5 py-0.5 rounded"
                  style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)' }}
                >
                  {colTasks.length}
                </span>
              </div>
              <div className="space-y-2 flex-1">
                {colTasks.map((task) => (
                  <div
                    key={task.id}
                    draggable
                    onDragStart={(e) => handleDragStart(e, task.id)}
                    className="cursor-grab active:cursor-grabbing"
                  >
                    <TaskListCard task={task} onSelect={selectTask} />
                  </div>
                ))}
                {colTasks.length === 0 && (
                  <p className="text-xs text-center py-4" style={{ color: 'var(--text-muted)' }}>
                    No tasks
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {selectedTask && <TaskDetailPanel />}
    </div>
  );
}
