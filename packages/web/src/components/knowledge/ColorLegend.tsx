'use client';

import { useKnowledgeStore, type ColorDimension } from '@/stores/knowledge-store';

const DOMAIN_COLORS: Record<string, string> = {
  health: '#4ade80',
  work: '#60a5fa',
  finance: '#facc15',
  personal: '#f472b6',
  tech: '#a78bfa',
  default: '#94a3b8',
};

const PERMANENCE_COLORS: Record<string, string> = {
  robust: '#4ade80',
  normal: '#60a5fa',
  temporary: '#facc15',
};

function getLegendEntries(dim: ColorDimension): Array<{ label: string; color: string }> {
  if (dim === 'domain') {
    return Object.entries(DOMAIN_COLORS).map(([k, v]) => ({ label: k, color: v }));
  }
  if (dim === 'permanence') {
    return Object.entries(PERMANENCE_COLORS).map(([k, v]) => ({ label: k, color: v }));
  }
  if (dim === 'connectionDegree') {
    return [
      { label: 'Low', color: '#94a3b8' },
      { label: 'High', color: '#f97316' },
    ];
  }
  if (dim === 'recency') {
    return [
      { label: 'Old', color: '#94a3b8' },
      { label: 'New', color: '#22d3ee' },
    ];
  }
  if (dim === 'cluster') {
    return [{ label: 'Varies by cluster', color: '#a78bfa' }];
  }
  if (dim === 'relevance') {
    return [
      { label: 'Low relevance', color: '#94a3b8' },
      { label: 'High relevance', color: '#ef4444' },
    ];
  }
  return [];
}

export function ColorLegend() {
  const colorDimension = useKnowledgeStore((s) => s.colorDimension);
  const entries = getLegendEntries(colorDimension);

  return (
    <div
      className="flex items-center gap-3 px-3 py-1.5 rounded text-xs"
      style={{ background: 'var(--bg-card)', color: 'var(--text-muted)' }}
    >
      <span className="font-medium" style={{ color: 'var(--text)' }}>
        Color: {colorDimension}
      </span>
      {entries.map((e) => (
        <span key={e.label} className="flex items-center gap-1">
          <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: e.color }} />
          {e.label}
        </span>
      ))}
    </div>
  );
}

// Exported for use in KnowledgeGraph canvas rendering
export { DOMAIN_COLORS, PERMANENCE_COLORS };
