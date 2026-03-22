'use client';

import { useTaskStore } from '@/stores/task-store';
import { TaskList } from '@/components/tasks/TaskList';
import { AgentMonitor } from '@/components/tasks/AgentMonitor';

const TABS = [
  { key: 'tasks', label: 'Tasks' },
  { key: 'monitor', label: 'Agent Monitor' },
] as const;

export default function TasksPage() {
  const { tab, setTab } = useTaskStore();

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
      <div className="flex gap-1 border-b" style={{ borderColor: 'var(--border)' }}>
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
      </div>

      {/* Tab content */}
      {tab === 'tasks' ? <TaskList /> : <AgentMonitor />}
    </div>
  );
}
