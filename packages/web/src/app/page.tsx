'use client';

import { useEffect } from 'react';
import { useAppStore } from '@/stores/app-store';
import { usePolling } from '@/hooks/usePolling';
import { StatusCards } from '@/components/dashboard/StatusCards';
import { ActivityFeed } from '@/components/dashboard/ActivityFeed';

const HEALTH_REFRESH_INTERVAL_MS = 10000;

interface HealthResponse {
  status: string;
  uptime: number;
  subsystems: {
    skills: { names: string[] };
    agentManager: { queueLength: number; runningCount: number };
  };
}

// eslint-disable-next-line max-lines-per-function -- page component with layout and data fetching
export default function DashboardPage() {
  const { health, projects, schedules, loading, fetchAll, fetchProjects, fetchSchedules } =
    useAppStore();

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const { data: healthData } = usePolling<HealthResponse>('/health', HEALTH_REFRESH_INTERVAL_MS);

  useEffect(() => {
    if (healthData) {
      useAppStore.setState({
        health: {
          status: healthData.status,
          uptime: healthData.uptime,
          skills: healthData.subsystems.skills.names,
          agentQueue: healthData.subsystems.agentManager.queueLength,
          agentsRunning: healthData.subsystems.agentManager.runningCount,
        },
      });
    }
  }, [healthData]);

  // Re-fetch project and schedule counts on each health poll so status cards stay fresh
  useEffect(() => {
    if (healthData) {
      void fetchProjects();
      void fetchSchedules();
    }
  }, [healthData, fetchProjects, fetchSchedules]);

  if (loading && !health) {
    return (
      <div className="p-8">
        <p style={{ color: 'var(--text-muted)' }}>Connecting to Raven...</p>
      </div>
    );
  }

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
          Raven Personal Assistant
        </p>
      </div>

      <StatusCards
        health={health}
        projectCount={projects.length}
        scheduleCount={schedules.length}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ActivityFeed />
        <div
          className="rounded-lg"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
        >
          <div className="p-4 border-b" style={{ borderColor: 'var(--border)' }}>
            <h2 className="text-sm font-semibold">Quick Actions</h2>
          </div>
          <div className="p-4 space-y-2">
            <QuickAction
              href="/projects"
              label="Open Projects"
              desc="Chat with Raven about your tasks"
            />
            <QuickAction
              href="/schedules"
              label="View Schedules"
              desc="Morning digest and recurring tasks"
            />
            <QuickAction href="/skills" label="Manage Skills" desc="Configure integrations" />
          </div>
        </div>
      </div>
    </div>
  );
}

function QuickAction({ href, label, desc }: { href: string; label: string; desc: string }) {
  return (
    <a
      href={href}
      className="block p-3 rounded-lg transition-colors"
      style={{ background: 'var(--bg)', border: '1px solid var(--border)' }}
    >
      <p className="text-sm font-medium">{label}</p>
      <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
        {desc}
      </p>
    </a>
  );
}
