'use client';

import { useEffect, useState } from 'react';
import { api, type NamedAgentRecord } from '@/lib/api-client';
import type { ProjectTabProps } from './project-tab-registry';

// eslint-disable-next-line max-lines-per-function -- project agents tab
export function ProjectAgentsTab({ projectId }: ProjectTabProps) {
  const [agents, setAgents] = useState<NamedAgentRecord[]>([]);

  useEffect(() => {
    void api.getAgents().then((all) => {
      setAgents(all);
    });
  }, [projectId]);

  // Separate agents scoped to this project vs inherited (global/default)
  const ownAgents = agents.filter((a) => {
    // Agent is "own" if it has no project scope or matches this project
    // Since the API doesn't expose projectId on agent yet, we show all agents
    // and mark default agents as "inherited"
    return !a.isDefault;
  });
  const inheritedAgents = agents.filter((a) => a.isDefault);

  return (
    <div className="p-6 space-y-6 overflow-y-auto h-full">
      <div>
        <h2 className="text-sm font-semibold mb-3">Project Agents</h2>
        {ownAgents.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            No dedicated agents for this project.
          </p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {ownAgents.map((agent) => (
              <AgentMiniCard key={agent.id} agent={agent} badge="own" />
            ))}
          </div>
        )}
      </div>

      {inheritedAgents.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold mb-3">Inherited Agents</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {inheritedAgents.map((agent) => (
              <AgentMiniCard key={agent.id} agent={agent} badge="inherited" />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AgentMiniCard({ agent, badge }: { agent: NamedAgentRecord; badge: 'own' | 'inherited' }) {
  const badgeStyle =
    badge === 'own'
      ? { background: 'rgba(34,197,94,0.2)', color: 'rgb(74,222,128)' }
      : { background: 'rgba(161,161,170,0.2)', color: 'rgb(161,161,170)' };

  return (
    <div
      className="p-3 rounded-lg border"
      style={{ background: 'var(--bg-card)', borderColor: 'var(--border)' }}
    >
      <div className="flex items-center gap-2">
        {agent.isActive && (
          <span
            className="inline-block w-2 h-2 rounded-full animate-pulse"
            style={{ background: '#22c55e' }}
          />
        )}
        <span className="text-sm font-medium">{agent.name}</span>
        <span className="text-xs px-1.5 py-0.5 rounded-full" style={badgeStyle}>
          {badge}
        </span>
      </div>
      {agent.description && (
        <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
          {agent.description}
        </p>
      )}
      {agent.suites && agent.suites.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {agent.suites.map((s) => (
            <span
              key={s.name}
              className="text-xs px-1.5 py-0.5 rounded"
              style={{ background: 'var(--bg-hover)', color: 'var(--accent)' }}
            >
              {s.displayName}
            </span>
          ))}
        </div>
      )}
      {agent.taskCounts && (
        <div className="flex gap-3 mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
          <span>{agent.taskCounts.completed} completed</span>
          <span>{agent.taskCounts.inProgress} in progress</span>
        </div>
      )}
    </div>
  );
}
