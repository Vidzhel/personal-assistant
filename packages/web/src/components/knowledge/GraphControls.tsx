'use client';

import {
  useKnowledgeStore,
  type GraphViewMode,
  type ColorDimension,
} from '@/stores/knowledge-store';
import { FilterPanel } from './FilterPanel';
import { ColorLegend } from './ColorLegend';
import { useEffect, useRef, useState } from 'react';
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
  { value: 'relevance', label: 'Search relevance' },
];

// eslint-disable-next-line max-lines-per-function -- toolbar with view modes, color, search, filters
export function GraphControls({
  projectId,
  onRefetch,
}: {
  projectId?: string;
  onRefetch: () => void;
}) {
  const { viewMode, setViewMode, colorDimension, setColorDimension, setSearchResults } =
    useKnowledgeStore();
  const [searchText, setSearchText] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchGeneration = useRef(0);
  const projectRef = useRef(projectId);
  if (projectRef.current !== projectId) {
    projectRef.current = projectId;
    searchGeneration.current++;
  }

  useEffect(() => {
    searchGeneration.current++;
    setSearchText('');
    setSearchError(null);
    setSearching(false);
    setSearchResults([]);
    setColorDimension('domain');
    return () => {
      searchGeneration.current++;
    };
  }, [projectId, setColorDimension, setSearchResults]);

  async function handleSearch() {
    const requestGeneration = ++searchGeneration.current;
    const graphVersion = useKnowledgeStore.getState().graphVersion;
    if (!projectId || !searchText.trim()) {
      setSearchResults([]);
      setSearchError(null);
      return;
    }
    setSearchError(null);
    setSearching(true);
    try {
      const result = await api.searchKnowledge(searchText);
      const current = useKnowledgeStore.getState();
      if (requestGeneration !== searchGeneration.current || current.graphVersion !== graphVersion) {
        return;
      }
      const visibleIds = new Set(current.nodes.map((node) => node.id));
      setSearchResults(
        result.results
          .filter((resultItem) => visibleIds.has(resultItem.bubbleId))
          .map((resultItem) => ({ bubbleId: resultItem.bubbleId, score: resultItem.score })),
      );
      setColorDimension('relevance');
    } catch (cause) {
      if (requestGeneration === searchGeneration.current) {
        setSearchResults([]);
        setSearchError(cause instanceof Error ? cause.message : 'Could not search knowledge.');
      }
    } finally {
      if (requestGeneration === searchGeneration.current) setSearching(false);
    }
  }

  function clearSearch() {
    searchGeneration.current++;
    setSearching(false);
    setSearchError(null);
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
            aria-label="Graph color"
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
            disabled={!projectId}
            className="text-xs px-2 py-1 rounded w-48"
            style={{
              background: 'var(--bg-card)',
              color: 'var(--text)',
              border: '1px solid var(--border)',
            }}
          />
          <button
            onClick={handleSearch}
            disabled={searching || !projectId}
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

      <div className="flex flex-wrap items-center gap-3">
        <FilterPanel />
        <ColorLegend />
      </div>
      {searchError && (
        <p role="alert" className="text-xs" style={{ color: 'var(--error)' }}>
          {searchError}
        </p>
      )}
    </div>
  );
}
