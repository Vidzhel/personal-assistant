'use client';

import { useEffect } from 'react';
import { useAppStore } from '@/stores/app-store';
import { usePolling } from '@/hooks/usePolling';
import { DefinitionIssues, type DefinitionIssue } from '@/components/dashboard/DefinitionIssues';
import { StatusCards } from '@/components/dashboard/StatusCards';
import { ActivityFeed } from '@/components/dashboard/ActivityFeed';
import { LifeSummary } from '@/components/dashboard/LifeSummary';
import { InsightsPanel } from '@/components/dashboard/InsightsPanel';
import { UpcomingEvents } from '@/components/dashboard/UpcomingEvents';
import { ApprovalsInbox } from '@/components/approvals/ApprovalsInbox';
import { buildSystemHealthCard } from '@/components/dashboard/system-health-helpers';
import type { LifeDashboardData } from '@raven/shared';

const HEALTH_REFRESH_INTERVAL_MS = 10000;
const DASHBOARD_REFRESH_INTERVAL_MS = 30000;

interface HealthResponse {
  status: string;
  uptime: number;
  subsystems: {
    skills: { names: string[] };
    definitions?: { diagnostics: DefinitionIssue[] };
    agentManager: { queueLength: number; runningCount: number };
  };
  selfTest?: { lastRun: string | null; ok: boolean; violations: string[] };
}

function definitionIssues(health: HealthResponse | null): DefinitionIssue[] {
  return health?.subsystems.definitions?.diagnostics ?? [];
}

// eslint-disable-next-line max-lines-per-function -- life dashboard page with multiple data sources
export default function DashboardPage() {
  const {
    health,
    projects,
    schedules,
    templates,
    loading,
    fetchAll,
    fetchProjects,
    fetchSchedules,
    fetchTemplates,
  } = useAppStore();

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const { data: healthData, refresh: refreshHealth } = usePolling<HealthResponse>(
    '/health',
    HEALTH_REFRESH_INTERVAL_MS,
  );
  const { data: dashboardData } = usePolling<LifeDashboardData>(
    '/dashboard/life',
    DASHBOARD_REFRESH_INTERVAL_MS,
  );

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
      void fetchTemplates();
    }
  }, [healthData, fetchProjects, fetchSchedules, fetchTemplates]);

  if (loading && !health) {
    return (
      <div className="p-8">
        <p style={{ color: 'var(--text-muted)' }}>Connecting to Raven...</p>
      </div>
    );
  }

  const summaryCards = dashboardData
    ? [
        {
          label: 'Actions Today',
          value: dashboardData.today.autonomousActionsCount,
          href: '/activity',
        },
        {
          label: 'Active Schedules',
          value: dashboardData.schedules.activeCount,
          href: '/schedules',
        },
        {
          label: 'Pending Approvals',
          value: dashboardData.pendingApprovalsCount,
          href: '#approvals',
          color: dashboardData.pendingApprovalsCount > 0 ? 'var(--warning, #f59e0b)' : undefined,
        },
        buildSystemHealthCard(healthData?.status, healthData?.selfTest),
      ]
    : [];

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
        templateCount={templates.length}
        scheduleCount={schedules.length}
      />

      {dashboardData && <LifeSummary cards={summaryCards} />}

      <DefinitionIssues issues={definitionIssues(healthData)} onReload={refreshHealth} />

      <ApprovalsInbox />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ActivityFeed />
        <div className="space-y-6">
          {dashboardData && <InsightsPanel insights={dashboardData.insights} />}
          {dashboardData && <UpcomingEvents events={dashboardData.upcomingEvents} />}
        </div>
      </div>
    </div>
  );
}
