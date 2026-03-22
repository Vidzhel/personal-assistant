'use client';

import { useTaskStore } from '@/stores/task-store';
import type { RavenTaskDetail } from '@/lib/api-client';

const STATUS_COLORS: Record<string, string> = {
  todo: 'var(--text-muted)',
  in_progress: 'var(--warning)',
  completed: 'var(--success)',
  archived: 'var(--text-muted)',
};

function MetaRow({ label, value }: { label: string; value: string | undefined }) {
  if (!value) return null;
  return (
    <div className="flex items-start gap-2 text-xs">
      <span className="font-medium min-w-[90px]" style={{ color: 'var(--text-muted)' }}>
        {label}:
      </span>
      <span style={{ color: 'var(--text-primary)' }}>{value}</span>
    </div>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function TaskDetailPanel() {
  const { selectedTask, clearSelection } = useTaskStore();
  if (!selectedTask) return null;

  const task: RavenTaskDetail = selectedTask;

  return (
    <div
      className="fixed inset-y-0 right-0 w-[480px] z-50 shadow-xl overflow-y-auto border-l"
      style={{ background: 'var(--bg-primary)', borderColor: 'var(--border)' }}
    >
      <div className="p-6 space-y-5">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <span
                className="w-2.5 h-2.5 rounded-full"
                style={{ background: STATUS_COLORS[task.status] ?? 'var(--text-muted)' }}
              />
              <span
                className="text-xs font-medium px-2 py-0.5 rounded"
                style={{ background: 'var(--bg-hover)' }}
              >
                {task.status.replace('_', ' ')}
              </span>
            </div>
            <h2 className="text-lg font-bold mt-2">{task.title}</h2>
          </div>
          <button
            onClick={clearSelection}
            className="text-lg px-2 py-1 rounded hover:opacity-70"
            style={{ color: 'var(--text-muted)' }}
          >
            x
          </button>
        </div>

        {/* Description */}
        {task.description && (
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {task.description}
          </p>
        )}

        {/* Prompt */}
        {task.prompt && (
          <div>
            <h3 className="text-xs font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>
              Prompt
            </h3>
            <pre
              className="text-xs p-3 rounded whitespace-pre-wrap"
              style={{ background: 'var(--bg-hover)', color: 'var(--text-primary)' }}
            >
              {task.prompt}
            </pre>
          </div>
        )}

        {/* Metadata */}
        <div className="space-y-1.5">
          <MetaRow label="Source" value={task.source} />
          <MetaRow label="Project" value={task.projectId} />
          <MetaRow label="Agent" value={task.assignedAgentId} />
          <MetaRow label="Pipeline" value={task.pipelineId} />
          <MetaRow label="External ID" value={task.externalId} />
          <MetaRow label="Created" value={formatDate(task.createdAt)} />
          <MetaRow label="Updated" value={formatDate(task.updatedAt)} />
          {task.completedAt && <MetaRow label="Completed" value={formatDate(task.completedAt)} />}
          <MetaRow label="ID" value={task.id} />
        </div>

        {/* Subtasks */}
        {task.subtasks.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>
              Subtasks ({task.subtasks.length})
            </h3>
            <div className="space-y-1">
              {task.subtasks.map((sub) => (
                <div
                  key={sub.id}
                  className="flex items-center gap-2 p-2 rounded text-sm"
                  style={{ background: 'var(--bg-hover)' }}
                >
                  <span
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ background: STATUS_COLORS[sub.status] ?? 'var(--text-muted)' }}
                  />
                  <span className="truncate">{sub.title}</span>
                  <span
                    className="text-xs ml-auto flex-shrink-0"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    {sub.status.replace('_', ' ')}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Artifacts */}
        {task.artifacts.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>
              Artifacts ({task.artifacts.length})
            </h3>
            <div className="space-y-1">
              {task.artifacts.map((artifact, i) => (
                <div
                  key={i}
                  className="text-xs p-2 rounded font-mono"
                  style={{ background: 'var(--bg-hover)', color: 'var(--accent)' }}
                >
                  {artifact}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
