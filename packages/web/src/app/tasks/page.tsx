'use client';

import { useState } from 'react';
import { useTaskStore } from '@/stores/task-store';
import { TaskBoard } from '@/components/board/TaskBoard';
import { AgentMonitor } from '@/components/tasks/AgentMonitor';

const TABS = [
  { key: 'tasks', label: 'Tasks' },
  { key: 'monitor', label: 'Agent Monitor' },
] as const;

function TaskTabBar({
  tab,
  setTab,
  search,
  setSearch,
}: {
  tab: 'tasks' | 'monitor';
  setTab: (tab: 'tasks' | 'monitor') => void;
  search: string;
  setSearch: (search: string) => void;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-1 border-b"
      style={{ borderColor: 'var(--border)' }}
    >
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
      {tab === 'tasks' && (
        <input
          type="search"
          placeholder="Search tasks…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="mt-2 w-full text-xs px-2 py-1 rounded sm:ml-auto sm:mt-0 sm:w-auto"
          style={{
            background: 'var(--bg-hover)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            outline: 'none',
          }}
        />
      )}
    </div>
  );
}

export default function TasksPage() {
  const { tab, setTab } = useTaskStore();
  const [search, setSearch] = useState('');

  return (
    <div className="p-4 space-y-6 sm:p-8">
      <div>
        <h1 className="text-2xl font-bold">Tasks</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
          {tab === 'tasks'
            ? 'Manage work items across all sources.'
            : 'Monitor running and queued agents in real-time.'}
        </p>
      </div>

      <TaskTabBar tab={tab} setTab={setTab} search={search} setSearch={setSearch} />

      {/* Tab content */}
      {tab === 'tasks' ? <TaskBoard search={search} /> : <AgentMonitor />}
    </div>
  );
}
