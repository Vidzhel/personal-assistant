'use client';

import { useEffect } from 'react';
import { useAppStore } from '@/stores/app-store';

export default function SkillsPage() {
  const { skills, fetchSkills } = useAppStore();

  useEffect(() => {
    fetchSkills();
  }, [fetchSkills]);

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Skills</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>Active integrations and their capabilities.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {skills.map((s) => (
          <div key={s.name} className="p-4 rounded-lg" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
            <div className="flex justify-between items-start">
              <h3 className="font-semibold">{s.displayName}</h3>
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>v{s.version}</span>
            </div>
            <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>{s.description}</p>
            <div className="mt-3 space-y-2">
              <div className="flex gap-1 flex-wrap">
                {s.capabilities.map((c) => (
                  <span key={c} className="text-xs px-2 py-0.5 rounded" style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)' }}>
                    {c}
                  </span>
                ))}
              </div>
              {s.mcpServers.length > 0 && (
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  MCP: {s.mcpServers.join(', ')}
                </p>
              )}
              {s.agentDefinitions.length > 0 && (
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  Agents: {s.agentDefinitions.join(', ')}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
