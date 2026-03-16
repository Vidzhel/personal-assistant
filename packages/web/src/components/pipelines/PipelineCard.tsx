'use client';

import { type EnrichedPipeline, type PipelineRunRecord } from '@/lib/api-client';
import {
  getPipelineStatusColor,
  getPipelineStatusIcon,
  getTriggerLabel,
} from '@/lib/pipeline-helpers';
import { formatRelativeTime } from '@/lib/event-helpers';

const DISABLED_OPACITY = 0.7;

function EnabledBadge({ enabled }: { enabled: boolean }) {
  return (
    <span
      className="text-xs px-1.5 py-0.5 rounded"
      style={{
        background: enabled ? 'var(--success)' : 'var(--text-muted)',
        color: 'var(--bg)',
        opacity: enabled ? 1 : DISABLED_OPACITY,
      }}
    >
      {enabled ? 'on' : 'off'}
    </span>
  );
}

function LastRunStatus({ lastRun }: { lastRun: PipelineRunRecord }) {
  const isRunning = lastRun.status === 'running';
  const lastRunTime = new Date(lastRun.started_at).getTime();

  return (
    <span className="flex items-center gap-1">
      <span
        className={`font-mono ${isRunning ? 'pipeline-running' : ''}`}
        style={{ color: getPipelineStatusColor(lastRun.status) }}
      >
        {getPipelineStatusIcon(lastRun.status)}
      </span>
      {formatRelativeTime(lastRunTime)}
    </span>
  );
}

export function PipelineCard({
  pipeline,
  onClick,
}: {
  pipeline: EnrichedPipeline;
  onClick: () => void;
}) {
  const { config, lastRun, nextRun } = pipeline;

  return (
    <div
      className="p-4 rounded-lg cursor-pointer transition-colors"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
      onClick={onClick}
    >
      <div className="flex items-center gap-3">
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center font-mono text-sm shrink-0"
          style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)' }}
        >
          |
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm truncate">{config.name}</span>
            <EnabledBadge enabled={config.enabled} />
          </div>
          {config.description && (
            <p className="text-xs truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>
              {config.description}
            </p>
          )}
        </div>
      </div>
      <div className="mt-3 flex items-center gap-4 text-xs" style={{ color: 'var(--text-muted)' }}>
        <span>{getTriggerLabel(config.trigger)}</span>
        {lastRun && <LastRunStatus lastRun={lastRun} />}
        {nextRun && <span>Next: {formatRelativeTime(new Date(nextRun).getTime())}</span>}
      </div>
    </div>
  );
}
