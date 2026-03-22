'use client';

import { useAgentStore } from '@/stores/agent-store';
import type { NamedAgentRecord } from '@/lib/api-client';

// eslint-disable-next-line max-lines-per-function -- React component
export function AgentCard({ agent }: { agent: NamedAgentRecord }) {
  const { openEditForm, deleteAgent, showHistory } = useAgentStore();

  return (
    <div
      className="rounded-lg border p-4 space-y-3"
      style={{ borderColor: 'var(--border)', background: 'var(--bg-card)' }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {agent.isActive && (
            <span
              className="inline-block w-2 h-2 rounded-full animate-pulse"
              style={{ background: '#22c55e' }}
            />
          )}
          <h3 className="font-semibold text-sm">{agent.name}</h3>
          {agent.isDefault && (
            <span
              className="text-xs px-1.5 py-0.5 rounded"
              style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)' }}
            >
              default
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => openEditForm(agent.id)}
            className="p-1 rounded hover:opacity-80 text-xs"
            style={{ color: 'var(--text-muted)' }}
            title="Edit"
          >
            &#9998;
          </button>
          <button
            onClick={() => void showHistory(agent.id)}
            className="p-1 rounded hover:opacity-80 text-xs"
            style={{ color: 'var(--text-muted)' }}
            title="View History"
          >
            &#128337;
          </button>
          {!agent.isDefault && (
            <button
              onClick={() => {
                if (confirm(`Delete agent "${agent.name}"?`)) {
                  void deleteAgent(agent.id);
                }
              }}
              className="p-1 rounded hover:opacity-80 text-xs"
              style={{ color: 'var(--text-muted)' }}
              title="Delete"
            >
              &#128465;
            </button>
          )}
        </div>
      </div>

      {agent.description && (
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {agent.description}
        </p>
      )}

      {agent.suites && agent.suites.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {agent.suites.map((s) => (
            <span
              key={s.name}
              className="text-xs px-2 py-0.5 rounded-full"
              style={{
                background: 'var(--accent-bg)',
                color: 'var(--accent)',
                border: '1px solid var(--accent)',
                opacity: 0.8,
              }}
            >
              {s.displayName}
            </span>
          ))}
        </div>
      )}

      {agent.suiteIds.length === 0 && (
        <p className="text-xs italic" style={{ color: 'var(--text-muted)' }}>
          All suites (unrestricted)
        </p>
      )}

      {agent.taskCounts && (
        <div className="flex gap-3 text-xs" style={{ color: 'var(--text-muted)' }}>
          <span>{agent.taskCounts.completed} completed</span>
          <span>{agent.taskCounts.inProgress} in progress</span>
        </div>
      )}
    </div>
  );
}
