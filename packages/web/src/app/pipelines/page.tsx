'use client';

import { useState } from 'react';
import { type EnrichedPipeline } from '@/lib/api-client';
import { usePolling } from '@/hooks/usePolling';
import { PipelineCard } from '@/components/pipelines/PipelineCard';
import { PipelineDetail } from '@/components/pipelines/PipelineDetail';

const POLL_MS = 5000;
const SKELETON_COUNT = 3;

function PipelineSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
        <div
          key={i}
          className="p-4 rounded-lg animate-pulse"
          style={{ background: 'var(--bg-card)', height: '88px' }}
        />
      ))}
    </div>
  );
}

export default function PipelinesPage() {
  const [selected, setSelected] = useState<string | null>(null);
  const { data: pipelines, loading } = usePolling<EnrichedPipeline[]>('/pipelines', POLL_MS);

  const selectedPipeline = pipelines?.find((p) => p.config.name === selected) ?? null;

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Pipeline Monitor</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
          Real-time view of pipeline execution status and health.
        </p>
      </div>

      {selectedPipeline && (
        <PipelineDetail pipeline={selectedPipeline} onClose={() => setSelected(null)} />
      )}

      {loading ? (
        <PipelineSkeleton />
      ) : pipelines && pipelines.length > 0 ? (
        <div className="space-y-3">
          {pipelines.map((p) => (
            <PipelineCard
              key={p.config.name}
              pipeline={p}
              onClick={() => setSelected(p.config.name === selected ? null : p.config.name)}
            />
          ))}
        </div>
      ) : (
        <p className="text-sm py-8 text-center" style={{ color: 'var(--text-muted)' }}>
          No pipelines configured. Add YAML pipeline definitions to{' '}
          <code className="text-xs px-1 py-0.5 rounded" style={{ background: 'var(--bg-hover)' }}>
            config/pipelines/
          </code>{' '}
          to get started.
        </p>
      )}
    </div>
  );
}
