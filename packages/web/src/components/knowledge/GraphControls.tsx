'use client';

import {
  useKnowledgeStore,
  type GraphViewMode,
  type ColorDimension,
} from '@/stores/knowledge-store';
import { FilterPanel } from './FilterPanel';
import { ColorLegend } from './ColorLegend';
import { useState } from 'react';
import { api } from '@/lib/api-client';

const VIEW_MODES: { value: GraphViewMode; label: string }[] = [
  { value: 'links', label: 'Links' },
  { value: 'tags', label: 'Tags' },
  { value: 'timeline', label: 'Timeline' },
  { value: 'clusters', label: 'Clusters' },
  { value: 'domains', label: 'Domains' },
];

const COLOR_DIMS: { value: ColorDimension; label: string }[] = [
  { value: 'domain', label: 'Domain' },
  { value: 'permanence', label: 'Permanence' },
  { value: 'connectionDegree', label: 'Connections' },
  { value: 'recency', label: 'Recency' },
  { value: 'cluster', label: 'Cluster' },
];

// eslint-disable-next-line max-lines-per-function -- toolbar with view modes, color, search, filters
export function GraphControls({ onRefetch }: { onRefetch: () => void }) {
  const { viewMode, setViewMode, colorDimension, setColorDimension, setSearchResults } =
    useKnowledgeStore();
  const [searchText, setSearchText] = useState('');
  const [searching, setSearching] = useState(false);

  async function handleSearch() {
    if (!searchText.trim()) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    try {
      const result = await api.searchKnowledge(searchText);
      setSearchResults(result.results.map((r) => ({ bubbleId: r.bubbleId, score: r.score })));
      setColorDimension('relevance');
    } finally {
      setSearching(false);
    }
  }

  function clearSearch() {
    setSearchText('');
    setSearchResults([]);
    setColorDimension('domain');
  }

  return (
    <div
      className="flex flex-col gap-2 p-3 border-b"
      style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
    >
      <div className="flex items-center gap-3 flex-wrap">
        {/* View mode */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
            View:
          </span>
          {VIEW_MODES.map((m) => (
            <button
              key={m.value}
              onClick={() => {
                setViewMode(m.value);
                onRefetch();
              }}
              className="px-2 py-1 text-xs rounded transition-colors"
              style={{
                background: viewMode === m.value ? 'var(--accent)' : 'var(--bg-card)',
                color: viewMode === m.value ? '#fff' : 'var(--text-muted)',
              }}
            >
              {m.label}
            </button>
          ))}
        </div>

        {/* Color dimension */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
            Color:
          </span>
          <select
            value={colorDimension}
            onChange={(e) => setColorDimension(e.target.value as ColorDimension)}
            className="text-xs px-2 py-1 rounded"
            style={{ background: 'var(--bg-card)', color: 'var(--text)', border: 'none' }}
          >
            {COLOR_DIMS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </div>

        {/* Search */}
        <div className="flex items-center gap-1.5 ml-auto">
          <input
            type="text"
            placeholder="Search knowledge..."
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            className="text-xs px-2 py-1 rounded w-48"
            style={{
              background: 'var(--bg-card)',
              color: 'var(--text)',
              border: '1px solid var(--border)',
            }}
          />
          <button
            onClick={handleSearch}
            disabled={searching}
            className="px-2 py-1 text-xs rounded"
            style={{ background: 'var(--accent)', color: '#fff' }}
          >
            {searching ? '...' : 'Search'}
          </button>
          {searchText && (
            <button
              onClick={clearSearch}
              className="px-2 py-1 text-xs rounded"
              style={{ background: 'var(--bg-card)', color: 'var(--text-muted)' }}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <FilterPanel />
        <ColorLegend />
      </div>
    </div>
  );
}
