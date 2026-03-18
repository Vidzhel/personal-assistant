'use client';

import { useState } from 'react';
import { useKnowledgeStore } from '@/stores/knowledge-store';

// eslint-disable-next-line max-lines-per-function -- filter UI with tag, domain, permanence inputs
export function FilterPanel() {
  const { filters, setFilters } = useKnowledgeStore();
  const [tagInput, setTagInput] = useState('');
  const [domainInput, setDomainInput] = useState('');

  const activeCount = filters.tags.length + filters.domains.length + filters.permanence.length;

  function addTag() {
    const tag = tagInput.trim();
    if (tag && !filters.tags.includes(tag)) {
      setFilters({ ...filters, tags: [...filters.tags, tag] });
      setTagInput('');
    }
  }

  function removeTag(tag: string) {
    setFilters({ ...filters, tags: filters.tags.filter((t) => t !== tag) });
  }

  function addDomain() {
    const domain = domainInput.trim();
    if (domain && !filters.domains.includes(domain)) {
      setFilters({ ...filters, domains: [...filters.domains, domain] });
      setDomainInput('');
    }
  }

  function removeDomain(domain: string) {
    setFilters({ ...filters, domains: filters.domains.filter((d) => d !== domain) });
  }

  function togglePermanence(perm: string) {
    const perms = filters.permanence.includes(perm)
      ? filters.permanence.filter((p) => p !== perm)
      : [...filters.permanence, perm];
    setFilters({ ...filters, permanence: perms });
  }

  function clearAll() {
    setFilters({ tags: [], domains: [], permanence: [] });
  }

  return (
    <div className="flex items-center gap-2 text-xs flex-wrap">
      <span className="font-medium" style={{ color: 'var(--text-muted)' }}>
        Filters{activeCount > 0 ? ` (${activeCount})` : ''}:
      </span>

      {/* Tag filter */}
      <div className="flex items-center gap-1">
        <input
          type="text"
          placeholder="Tag..."
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addTag()}
          className="px-1.5 py-0.5 rounded w-20"
          style={{
            background: 'var(--bg-card)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
          }}
        />
        {filters.tags.map((tag) => (
          <span
            key={tag}
            className="px-1.5 py-0.5 rounded cursor-pointer"
            style={{ background: 'var(--accent)', color: '#fff' }}
            onClick={() => removeTag(tag)}
          >
            {tag} x
          </span>
        ))}
      </div>

      {/* Domain filter */}
      <div className="flex items-center gap-1">
        <input
          type="text"
          placeholder="Domain..."
          value={domainInput}
          onChange={(e) => setDomainInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addDomain()}
          className="px-1.5 py-0.5 rounded w-20"
          style={{
            background: 'var(--bg-card)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
          }}
        />
        {filters.domains.map((d) => (
          <span
            key={d}
            className="px-1.5 py-0.5 rounded cursor-pointer"
            style={{ background: 'var(--accent)', color: '#fff' }}
            onClick={() => removeDomain(d)}
          >
            {d} x
          </span>
        ))}
      </div>

      {/* Permanence filter */}
      {(['temporary', 'normal', 'robust'] as const).map((p) => (
        <label
          key={p}
          className="flex items-center gap-0.5 cursor-pointer"
          style={{ color: 'var(--text-muted)' }}
        >
          <input
            type="checkbox"
            checked={filters.permanence.includes(p)}
            onChange={() => togglePermanence(p)}
            className="w-3 h-3"
          />
          {p}
        </label>
      ))}

      {activeCount > 0 && (
        <button
          onClick={clearAll}
          className="px-1.5 py-0.5 rounded"
          style={{ background: 'var(--bg-card)', color: 'var(--text-muted)' }}
        >
          Clear all
        </button>
      )}
    </div>
  );
}
