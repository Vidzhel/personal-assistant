'use client';

import { useAgentStore } from '@/stores/agent-store';

// eslint-disable-next-line max-lines-per-function -- React component
export function AgentTaskHistory() {
  const { showTaskHistory, selectedAgentTasks, agents, closeHistory } = useAgentStore();
  const agent = agents.find((a) => a.id === showTaskHistory);

  return (
    <div
      className="fixed inset-y-0 right-0 z-50 w-96 border-l shadow-lg overflow-y-auto"
      style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
    >
      <div
        className="p-4 border-b flex items-center justify-between"
        style={{ borderColor: 'var(--border)' }}
      >
        <h3 className="font-semibold text-sm">Task History: {agent?.name ?? 'Unknown'}</h3>
        <button
          onClick={closeHistory}
          className="text-sm px-2 py-1 rounded"
          style={{ color: 'var(--text-muted)' }}
        >
          Close
        </button>
      </div>

      <div className="p-4 space-y-2">
        {selectedAgentTasks.length === 0 && (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            No tasks found for this agent.
          </p>
        )}
        {selectedAgentTasks.map((task) => (
          <div
            key={task.id}
            className="rounded border p-3 text-xs space-y-1"
            style={{ borderColor: 'var(--border)' }}
          >
            <div className="font-medium">{task.title}</div>
            <div className="flex gap-2" style={{ color: 'var(--text-muted)' }}>
              <span
                className="px-1.5 py-0.5 rounded"
                style={{
                  background:
                    task.status === 'completed'
                      ? 'rgba(34, 197, 94, 0.1)'
                      : task.status === 'in_progress'
                        ? 'rgba(59, 130, 246, 0.1)'
                        : 'var(--bg-hover)',
                  color:
                    task.status === 'completed'
                      ? '#22c55e'
                      : task.status === 'in_progress'
                        ? '#3b82f6'
                        : 'var(--text-muted)',
                }}
              >
                {task.status}
              </span>
              <span>{new Date(task.createdAt).toLocaleDateString()}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
