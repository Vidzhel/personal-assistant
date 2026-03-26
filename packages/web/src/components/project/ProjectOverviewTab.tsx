'use client';

import { useEffect, useState, useCallback } from 'react';
import { api, type Project, type Session } from '@/lib/api-client';
import { ProjectMemory } from './ProjectMemory';
import type { ProjectTabProps } from './project-tab-registry';

const RECENT_SESSION_LIMIT = 5;
const ID_DISPLAY_LENGTH = 8;

const MS_PER_MINUTE = 60000;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / MS_PER_MINUTE);
  if (mins < 1) return 'just now';
  if (mins < MINUTES_PER_HOUR) return `${mins}m ago`;
  const hrs = Math.floor(mins / MINUTES_PER_HOUR);
  if (hrs < HOURS_PER_DAY) return `${hrs}h ago`;
  const days = Math.floor(hrs / HOURS_PER_DAY);
  return `${days}d ago`;
}

// eslint-disable-next-line max-lines-per-function -- overview tab with stats, sessions, memory, and references
export function ProjectOverviewTab({ projectId }: ProjectTabProps) {
  const [project, setProject] = useState<Project | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    void api.getProject(projectId).then(setProject);
    void api.getProjectSessions(projectId).then(setSessions);
    void api.getTaskCounts(projectId).then(setCounts);
  }, [projectId]);

  const handleMemorySaved = useCallback((prompt: string | null) => {
    setProject((p) => (p ? { ...p, systemPrompt: prompt } : p));
  }, []);

  if (!project) {
    return (
      <div className="p-6" style={{ color: 'var(--text-muted)' }}>
        Loading...
      </div>
    );
  }

  const recentSessions = sessions.slice(0, RECENT_SESSION_LIMIT);
  const totalTasks = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <div className="p-6 space-y-6 overflow-y-auto h-full">
      {/* Quick stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Sessions" value={sessions.length} />
        <StatCard label="Tasks" value={totalTasks} />
        <StatCard label="To Do" value={counts['todo'] ?? 0} />
        <StatCard label="In Progress" value={counts['in_progress'] ?? 0} />
      </div>

      {/* Project Memory — instructions editor */}
      <div>
        <h2 className="text-sm font-semibold mb-2">Project Instructions</h2>
        <ProjectMemory
          systemPrompt={project.systemPrompt}
          projectId={project.id}
          onSaved={handleMemorySaved}
        />
      </div>

      {/* Recent sessions */}
      <div>
        <h2 className="text-sm font-semibold mb-2">Recent Sessions</h2>
        {recentSessions.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            No sessions yet
          </p>
        ) : (
          <div className="space-y-1.5">
            {recentSessions.map((s) => (
              <div
                key={s.id}
                className="flex items-center justify-between p-3 rounded border"
                style={{ background: 'var(--bg-card)', borderColor: 'var(--border)' }}
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs" style={{ color: 'var(--text-muted)' }}>
                    {s.id.slice(0, ID_DISPLAY_LENGTH)}
                  </span>
                  <span className="text-sm">{s.turnCount} turns</span>
                </div>
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {formatRelativeTime(s.lastActiveAt ?? s.createdAt)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Suites / Skills */}
      {project.skills.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold mb-2">Enabled Suites</h2>
          <div className="flex flex-wrap gap-2">
            {project.skills.map((s) => (
              <span
                key={s}
                className="text-xs px-2.5 py-1 rounded"
                style={{ background: 'var(--bg-hover)', color: 'var(--accent)' }}
              >
                {s}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div
      className="rounded p-3 border"
      style={{ background: 'var(--bg-card)', borderColor: 'var(--border)' }}
    >
      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
        {label}
      </div>
      <div className="text-xl font-bold mt-0.5">{value}</div>
    </div>
  );
}
