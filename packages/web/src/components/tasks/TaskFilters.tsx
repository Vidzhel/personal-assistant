'use client';

import { useState, useEffect, useRef } from 'react';
import { useTaskStore } from '@/stores/task-store';

const STATUS_OPTIONS = ['todo', 'in_progress', 'completed'] as const;
const SOURCE_OPTIONS = ['manual', 'agent', 'template', 'ticktick', 'pipeline'] as const;

const DEBOUNCE_MS = 300;

export function TaskFilters() {
  const { filters, setFilters, clearFilters } = useTaskStore();
  const [searchInput, setSearchInput] = useState(filters.search ?? '');
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(
      () => setFilters({ search: searchInput || undefined }),
      DEBOUNCE_MS,
    );
    return () => clearTimeout(timerRef.current);
  }, [searchInput, setFilters]);

  const hasFilters = filters.status || filters.source || filters.assignedAgentId || filters.search;

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <input
        type="text"
        placeholder="Search tasks..."
        value={searchInput}
        onChange={(e) => setSearchInput(e.target.value)}
        className="px-3 py-1.5 rounded-md text-sm border"
        style={{
          background: 'var(--bg-secondary)',
          borderColor: 'var(--border)',
          color: 'var(--text-primary)',
          minWidth: '200px',
        }}
      />

      <select
        value={filters.status ?? ''}
        onChange={(e) => setFilters({ status: e.target.value || undefined })}
        className="px-2 py-1.5 rounded-md text-sm border"
        style={{
          background: 'var(--bg-secondary)',
          borderColor: 'var(--border)',
          color: 'var(--text-primary)',
        }}
      >
        <option value="">All statuses</option>
        {STATUS_OPTIONS.map((s) => (
          <option key={s} value={s}>
            {s.replace('_', ' ')}
          </option>
        ))}
      </select>

      <select
        value={filters.source ?? ''}
        onChange={(e) => setFilters({ source: e.target.value || undefined })}
        className="px-2 py-1.5 rounded-md text-sm border"
        style={{
          background: 'var(--bg-secondary)',
          borderColor: 'var(--border)',
          color: 'var(--text-primary)',
        }}
      >
        <option value="">All sources</option>
        {SOURCE_OPTIONS.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>

      {hasFilters && (
        <button
          onClick={() => {
            clearFilters();
            setSearchInput('');
          }}
          className="text-xs px-2 py-1 rounded"
          style={{ color: 'var(--accent)' }}
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
