'use client';

import { useState } from 'react';
import { type PipelineRunRecord, type EnrichedPipeline, api } from '@/lib/api-client';
import { usePolling } from '@/hooks/usePolling';
import {
  getPipelineStatusColor,
  getPipelineStatusIcon,
  formatDuration,
  parseNodeResults,
} from '@/lib/pipeline-helpers';
import { formatRelativeTime } from '@/lib/event-helpers';

const RUNS_POLL_MS = 10000;
const RUNS_LIMIT = 10;
const SKELETON_COUNT = 3;
const DISABLED_OPACITY = 0.7;

function NodeResults({ nodeResultsJson }: { nodeResultsJson: string | null }) {
  const nodes = parseNodeResults(nodeResultsJson);
  if (nodes.length === 0) return null;

  return (
    <div className="mt-2 space-y-1 pl-4 border-l" style={{ borderColor: 'var(--border)' }}>
      {nodes.map((node) => (
        <div key={node.name} className="flex items-center gap-2 text-xs">
          <span className="font-mono" style={{ color: getPipelineStatusColor(node.status) }}>
            {getPipelineStatusIcon(node.status)}
          </span>
          <span style={{ color: 'var(--text-muted)' }}>{node.name}</span>
          {node.durationMs != null && (
            <span style={{ color: 'var(--text-muted)' }}>{formatDuration(node.durationMs)}</span>
          )}
          {node.error && (
            <span className="truncate" style={{ color: 'var(--error)' }}>
              {node.error}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function RunItem({ run }: { run: PipelineRunRecord }) {
  const [expanded, setExpanded] = useState(false);
  const startedAt = new Date(run.started_at).getTime();
  const completedAt = run.completed_at ? new Date(run.completed_at).getTime() : null;
  const duration = completedAt ? completedAt - startedAt : null;

  return (
    <div
      className="p-3 rounded-lg cursor-pointer"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-center gap-3">
        <span
          className={`font-mono text-sm ${run.status === 'running' ? 'pipeline-running' : ''}`}
          style={{ color: getPipelineStatusColor(run.status) }}
        >
          {getPipelineStatusIcon(run.status)}
        </span>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {run.trigger_type}
        </span>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {formatRelativeTime(startedAt)}
        </span>
        {duration != null && (
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {formatDuration(duration)}
          </span>
        )}
        <span className="ml-auto text-xs" style={{ color: 'var(--text-muted)' }}>
          {expanded ? '-' : '+'}
        </span>
      </div>
      {run.status === 'failed' && run.error && (
        <p className="text-xs mt-1" style={{ color: 'var(--error)' }}>
          {run.error}
        </p>
      )}
      {expanded && <NodeResults nodeResultsJson={run.node_results ?? null} />}
    </div>
  );
}

function RunsSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
        <div
          key={i}
          className="p-3 rounded-lg animate-pulse"
          style={{ background: 'var(--bg-hover)', height: '44px' }}
        />
      ))}
    </div>
  );
}

function RunsList({ runs }: { runs: PipelineRunRecord[] }) {
  if (runs.length === 0) {
    return (
      <p className="text-sm py-4 text-center" style={{ color: 'var(--text-muted)' }}>
        No executions yet.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {runs.map((run) => (
        <RunItem key={run.id} run={run} />
      ))}
    </div>
  );
}

function DetailHeader({ pipeline, onClose }: { pipeline: EnrichedPipeline; onClose: () => void }) {
  const [triggering, setTriggering] = useState(false);

  const handleTrigger = async (): Promise<void> => {
    setTriggering(true);
    try {
      await api.triggerPipeline(pipeline.config.name);
    } catch {
      // Polling will reflect actual state
    } finally {
      setTriggering(false);
    }
  };

  return (
    <div className="flex items-center justify-between">
      <h2 className="text-lg font-bold">{pipeline.config.name}</h2>
      <div className="flex items-center gap-2">
        {pipeline.config.enabled && (
          <button
            className="px-3 py-1 rounded text-xs font-medium"
            style={{
              background: 'var(--accent)',
              color: 'var(--text)',
              opacity: triggering ? DISABLED_OPACITY : 1,
            }}
            onClick={handleTrigger}
            disabled={triggering}
          >
            {triggering ? 'Starting...' : 'Run Now'}
          </button>
        )}
        <button
          className="px-2 py-1 rounded text-xs"
          style={{ color: 'var(--text-muted)' }}
          onClick={onClose}
        >
          Close
        </button>
      </div>
    </div>
  );
}

export function PipelineDetail({
  pipeline,
  onClose,
}: {
  pipeline: EnrichedPipeline;
  onClose: () => void;
}) {
  const { data: runs, loading } = usePolling<PipelineRunRecord[]>(
    `/pipelines/${pipeline.config.name}/runs?limit=${RUNS_LIMIT}`,
    RUNS_POLL_MS,
  );

  return (
    <div
      className="p-4 rounded-lg space-y-4"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
    >
      <DetailHeader pipeline={pipeline} onClose={onClose} />
      {pipeline.config.description && (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          {pipeline.config.description}
        </p>
      )}
      <div>
        <h3 className="text-sm font-semibold mb-2">Recent Runs</h3>
        {loading ? <RunsSkeleton /> : <RunsList runs={runs ?? []} />}
      </div>
    </div>
  );
}
