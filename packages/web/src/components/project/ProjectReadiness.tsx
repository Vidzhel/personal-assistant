'use client';

import type {
  CapabilityReadiness,
  ProjectReadinessReport,
  ReadinessFinding,
  ReadinessRequirement,
  ReadinessSource,
  ReadinessState,
} from '@raven/shared';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { getProjectReadiness } from '@/lib/workspace-api';

interface StatePresentation {
  label: string;
  color: string;
}

const STATE_PRESENTATION: Record<ReadinessState, StatePresentation> = {
  unavailable: { label: 'Unavailable', color: 'var(--error)' },
  configured: { label: 'Configured, unchecked', color: 'var(--warning)' },
  verified: { label: 'Verified', color: 'var(--success)' },
  failed: { label: 'Check failed', color: 'var(--error)' },
  unverified: { label: 'Unverified', color: 'var(--warning)' },
};

export function readinessStatePresentation(
  state: ReadinessState,
  kind?: ReadinessRequirement['kind'],
): StatePresentation {
  const presentation = STATE_PRESENTATION[state];
  if (state === 'verified' && kind === 'executable') {
    return { ...presentation, label: 'Verified locally' };
  }
  if (state === 'unverified' && kind === 'authentication') {
    return { ...presentation, label: 'Authentication unverified' };
  }
  return presentation;
}

function StatePill({
  state,
  kind,
}: {
  state: ReadinessState;
  kind?: ReadinessRequirement['kind'];
}) {
  const presentation = readinessStatePresentation(state, kind);
  return (
    <span
      className="shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium"
      style={{ borderColor: presentation.color, color: presentation.color }}
    >
      {presentation.label}
    </span>
  );
}

function Correction({ children }: { children?: string }) {
  if (!children) return null;
  return (
    <p className="mt-1 break-words text-xs" style={{ color: 'var(--text-muted)' }}>
      Fix: {children}
    </p>
  );
}

function FindingItem({ finding }: { finding: ReadinessFinding }) {
  const color = finding.severity === 'blocking' ? 'var(--error)' : 'var(--warning)';
  return (
    <li className="rounded border p-3" style={{ borderColor: color }}>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 break-words text-sm">{finding.message}</p>
        <span className="shrink-0 text-xs font-medium capitalize" style={{ color }}>
          {finding.severity}
        </span>
      </div>
      <Correction>{finding.correction}</Correction>
    </li>
  );
}

function RequirementItem({ requirement }: { requirement: ReadinessRequirement }) {
  return (
    <li className="rounded border p-2" style={{ borderColor: 'var(--border)' }}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 break-words text-sm">
          <span className="capitalize">{requirement.kind}</span>: {requirement.name}
        </span>
        <StatePill state={requirement.state} kind={requirement.kind} />
      </div>
      <Correction>{requirement.correction}</Correction>
    </li>
  );
}

function CapabilityCard({ capability }: { capability: CapabilityReadiness }) {
  return (
    <li className="min-w-0 rounded border p-3" style={{ borderColor: 'var(--border)' }}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h4 className="break-words text-sm font-semibold">{capability.displayName}</h4>
          <p className="break-all text-xs" style={{ color: 'var(--text-muted)' }}>
            {capability.name}
          </p>
        </div>
        <StatePill state={capability.state} />
      </div>
      {capability.requirements.length > 0 && (
        <ul className="mt-3 space-y-2">
          {capability.requirements.map((requirement) => (
            <RequirementItem
              key={`${requirement.kind}-${requirement.name}`}
              requirement={requirement}
            />
          ))}
        </ul>
      )}
      {capability.findings.length > 0 && (
        <ul className="mt-3 space-y-2">
          {capability.findings.map((finding) => (
            <FindingItem key={`${finding.code}-${finding.scope}`} finding={finding} />
          ))}
        </ul>
      )}
    </li>
  );
}

function SourceCard({ source }: { source: ReadinessSource }) {
  return (
    <li className="rounded border p-2" style={{ borderColor: 'var(--border)' }}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 break-words text-sm">
          {source.label} {source.selected ? '(selected)' : ''}
        </span>
        <StatePill state={source.state} />
      </div>
      <p className="mt-1 break-all text-xs" style={{ color: 'var(--text-muted)' }}>
        {source.sourceType}
      </p>
      {source.contextIndexes.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs">
          {source.contextIndexes.map((index) => (
            <li key={index.path} className="flex min-w-0 flex-wrap justify-between gap-2">
              <span className="min-w-0 break-all">{index.path}</span>
              <StatePill state={index.state} />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function WorkspaceReadiness({ report }: { report: ProjectReadinessReport }) {
  const { workspace } = report;
  return (
    <div className="min-w-0 space-y-3 rounded border p-3" style={{ borderColor: 'var(--border)' }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">Workspace</h3>
        <StatePill state={workspace.state} />
      </div>
      <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt style={{ color: 'var(--text-muted)' }}>Execution mode</dt>
          <dd>{workspace.mode ?? 'Unavailable'}</dd>
        </div>
        <div>
          <dt style={{ color: 'var(--text-muted)' }}>Settings</dt>
          <dd>{workspace.settingSources.join(', ') || 'Managed defaults'}</dd>
        </div>
        <div className="min-w-0 sm:col-span-2">
          <dt style={{ color: 'var(--text-muted)' }}>Working directory</dt>
          <dd className="break-all font-mono text-xs">{workspace.cwd ?? 'Unavailable'}</dd>
        </div>
      </dl>
      {workspace.blockedOperations.length > 0 && (
        <p className="break-words text-sm" style={{ color: 'var(--warning)' }}>
          Blocked operations: {workspace.blockedOperations.join(', ')}
        </p>
      )}
      {workspace.sources.length > 0 && (
        <ul className="grid grid-cols-1 gap-2 lg:grid-cols-2">
          {workspace.sources.map((source) => (
            <SourceCard key={source.id} source={source} />
          ))}
        </ul>
      )}
    </div>
  );
}

function AgentReadiness({ report }: { report: ProjectReadinessReport }) {
  const { agent } = report;
  return (
    <div className="min-w-0 rounded border p-3" style={{ borderColor: 'var(--border)' }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">Default agent</h3>
        <StatePill state={agent.state} />
      </div>
      <p className="mt-2 break-words text-sm">{agent.name ?? 'Unavailable'}</p>
      {agent.skills.length > 0 && (
        <p className="mt-1 break-words text-xs" style={{ color: 'var(--text-muted)' }}>
          Capabilities: {agent.skills.join(', ')}
        </p>
      )}
    </div>
  );
}

function SupportingDiagnostics({ report }: { report: ProjectReadinessReport }) {
  const count = report.definitionDiagnostics.length + report.recentFailures.length;
  if (count === 0) return null;
  return (
    <details className="rounded border p-3" style={{ borderColor: 'var(--border)' }}>
      <summary className="cursor-pointer text-sm font-semibold">
        Recent diagnostics ({count})
      </summary>
      <ul className="mt-3 space-y-2 text-sm">
        {report.definitionDiagnostics.map((item) => (
          <li key={`${item.source}-${item.path}-${item.code}`} className="break-words">
            <strong>{item.source}</strong>: {item.message}
            <div className="break-all text-xs" style={{ color: 'var(--text-muted)' }}>
              {item.path}
            </div>
          </li>
        ))}
        {report.recentFailures.map((item) => (
          <li key={`${item.taskId}-${item.occurredAt}`} className="break-words">
            <strong>{item.skillName}</strong>: {item.message}
          </li>
        ))}
      </ul>
    </details>
  );
}

const REPORT_STATUS: Record<ProjectReadinessReport['status'], StatePresentation> = {
  ready: { label: 'Ready', color: 'var(--success)' },
  degraded: { label: 'Needs attention', color: 'var(--warning)' },
  blocked: { label: 'Blocked', color: 'var(--error)' },
};

function ReportHeader({ report }: { report: ProjectReadinessReport }) {
  const status = REPORT_STATUS[report.status];
  const checkedAt = new Date(report.checkedAt);
  return (
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
      <div>
        <p className="font-semibold" style={{ color: status.color }}>
          {status.label}
        </p>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Checked{' '}
          {Number.isNaN(checkedAt.getTime()) ? report.checkedAt : checkedAt.toLocaleString()}
        </p>
      </div>
    </div>
  );
}

export function ProjectReadinessReportView({ report }: { report: ProjectReadinessReport }) {
  return (
    <div className="space-y-4">
      <ReportHeader report={report} />
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <WorkspaceReadiness report={report} />
        <AgentReadiness report={report} />
      </div>
      {report.findings.length > 0 && (
        <div>
          <h3 className="mb-2 font-semibold">Corrections</h3>
          <ul className="space-y-2">
            {report.findings.map((finding) => (
              <FindingItem key={`${finding.code}-${finding.scope}`} finding={finding} />
            ))}
          </ul>
        </div>
      )}
      <div>
        <h3 className="mb-2 font-semibold">Capabilities</h3>
        {report.capabilities.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            No optional capabilities selected.
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {report.capabilities.map((capability) => (
              <CapabilityCard key={capability.name} capability={capability} />
            ))}
          </ul>
        )}
      </div>
      <SupportingDiagnostics report={report} />
    </div>
  );
}

function useProjectReadiness(projectId: string, refreshKey?: string) {
  const [report, setReport] = useState<ProjectReadinessReport>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError(undefined);
    setReport(undefined);
    void getProjectReadiness(projectId, controller.signal)
      .then((next) => {
        if (active) setReport(next);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : 'Could not load readiness.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [projectId, refreshKey, revision]);
  return { report, error, loading, refresh };
}

export function ProjectReadiness({
  projectId,
  refreshKey,
}: {
  projectId: string;
  refreshKey?: string;
}) {
  const readiness = useProjectReadiness(projectId, refreshKey);
  return (
    <section
      aria-labelledby="project-readiness-heading"
      className="mb-6 space-y-3 rounded-lg border p-3 sm:p-4"
      style={{ background: 'var(--bg-card)', borderColor: 'var(--border)' }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="project-readiness-heading" className="text-lg font-semibold">
            Project readiness
          </h2>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Local workspace, agent, and configuration checks. Account authentication is not tested
            by these static checks.
          </p>
        </div>
        <Button size="sm" onClick={readiness.refresh} disabled={readiness.loading}>
          {readiness.loading ? 'Checking…' : 'Refresh'}
        </Button>
      </div>
      {readiness.error && (
        <p role="alert" className="break-words text-sm" style={{ color: 'var(--error)' }}>
          {readiness.error}
        </p>
      )}
      {readiness.report ? (
        <ProjectReadinessReportView report={readiness.report} />
      ) : (
        readiness.loading && (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Checking project requirements…
          </p>
        )
      )}
    </section>
  );
}
