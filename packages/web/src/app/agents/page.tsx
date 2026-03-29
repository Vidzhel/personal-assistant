'use client';

import { useEffect, useRef } from 'react';
import { useAgentStore } from '@/stores/agent-store';
import { AgentCard } from '@/components/agents/AgentCard';
import { AgentFormModal } from '@/components/agents/AgentFormModal';
import { AgentTaskHistory } from '@/components/agents/AgentTaskHistory';

const POLL_INTERVAL_MS = 5000;

export default function AgentsPage() {
  const {
    agents,
    showForm,
    showTaskHistory,
    fetchAgents,
    fetchSuites,
    fetchProjects,
    openCreateForm,
  } = useAgentStore();
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    void fetchAgents();
    void fetchSuites();
    void fetchProjects();
    timerRef.current = setInterval(() => void fetchAgents(), POLL_INTERVAL_MS);
    return () => clearInterval(timerRef.current);
  }, [fetchAgents, fetchSuites, fetchProjects]);

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Agents</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
            Named agents with dedicated skill sets and task history.
          </p>
        </div>
        <button
          onClick={openCreateForm}
          className="px-4 py-2 rounded-md text-sm font-medium text-white"
          style={{ background: 'var(--accent)' }}
        >
          + Create Agent
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} />
        ))}
      </div>

      {agents.length === 0 && (
        <div className="text-center py-12" style={{ color: 'var(--text-muted)' }}>
          No agents configured yet. Create one to get started.
        </div>
      )}

      {showForm && <AgentFormModal />}
      {showTaskHistory && <AgentTaskHistory />}
    </div>
  );
}
