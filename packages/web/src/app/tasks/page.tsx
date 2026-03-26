'use client';

import { useState } from 'react';
import { useTaskStore } from '@/stores/task-store';
import { TaskList } from '@/components/tasks/TaskList';
import { KanbanBoard } from '@/components/tasks/KanbanBoard';
import { AgentMonitor } from '@/components/tasks/AgentMonitor';

const TABS = [
  { key: 'tasks', label: 'Tasks' },
  { key: 'monitor', label: 'Agent Monitor' },
] as const;

type TaskViewMode = 'list' | 'kanban';

function ViewToggle({
  viewMode,
  onChangeView,
}: {
  viewMode: TaskViewMode;
  onChangeView: (mode: TaskViewMode) => void;
}) {
  return (
    <div className="ml-auto flex gap-1 mb-px">
      {(['list', 'kanban'] as const).map((mode) => (
        <button
          key={mode}
          onClick={() => onChangeView(mode)}
          className="px-2 py-1 text-xs rounded transition-colors"
          style={{
            background: viewMode === mode ? 'var(--bg-hover)' : 'transparent',
            color: viewMode === mode ? 'var(--text)' : 'var(--text-muted)',
          }}
        >
          {mode === 'list' ? 'List' : 'Board'}
        </button>
      ))}
    </div>
  );
}

export default function TasksPage() {
  const { tab, setTab } = useTaskStore();
  const [viewMode, setViewMode] = useState<TaskViewMode>('list');

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Tasks</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
          {tab === 'tasks'
            ? 'Manage work items across all sources.'
            : 'Monitor running and queued agents in real-time.'}
        </p>
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b" style={{ borderColor: 'var(--border)' }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className="px-4 py-2 text-sm font-medium -mb-px border-b-2 transition-colors"
            style={{
              borderColor: tab === t.key ? 'var(--accent)' : 'transparent',
              color: tab === t.key ? 'var(--text-primary)' : 'var(--text-muted)',
            }}
          >
            {t.label}
          </button>
        ))}
        {tab === 'tasks' && <ViewToggle viewMode={viewMode} onChangeView={setViewMode} />}
      </div>

      {/* Tab content */}
      {tab === 'tasks' ? (
        viewMode === 'list' ? (
          <TaskList />
        ) : (
          <div style={{ height: 'calc(100vh - 220px)' }}>
            <KanbanBoard />
          </div>
        )
      ) : (
        <AgentMonitor />
      )}
    </div>
  );
}
