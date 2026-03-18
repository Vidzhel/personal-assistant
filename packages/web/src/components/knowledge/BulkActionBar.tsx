'use client';

import { useState } from 'react';
import { useKnowledgeStore } from '@/stores/knowledge-store';
import { api } from '@/lib/api-client';

const PREVIEW_COUNT = 3;
const MERGE_MAX = 10;

// eslint-disable-next-line max-lines-per-function -- bulk action toolbar with multiple action flows
export function BulkActionBar({ onRefetch }: { onRefetch: () => void }) {
  const { selectedNodeIds, clearSelection, nodes } = useKnowledgeStore();
  const [tagInput, setTagInput] = useState('');
  const [permValue, setPermValue] = useState('normal');
  const [showRetag, setShowRetag] = useState(false);
  const [showPerm, setShowPerm] = useState(false);

  if (selectedNodeIds.length < 2) return null;

  const selectedTitles = nodes.filter((n) => selectedNodeIds.includes(n.id)).map((n) => n.title);

  async function handleMerge() {
    if (selectedNodeIds.length < 2) return;
    if (!confirm(`Merge ${selectedNodeIds.length} bubbles? This cannot be undone.`)) return;
    await api.mergeKnowledgeBubbles(selectedNodeIds);
    clearSelection();
    onRefetch();
  }

  async function handleRetag() {
    if (!tagInput.trim()) return;
    const tags = tagInput
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const results = await Promise.allSettled(
      selectedNodeIds.map((id) => {
        const existing = nodes.find((n) => n.id === id);
        const merged = [...new Set([...(existing?.tags ?? []), ...tags])];
        return api.updateKnowledgeBubble(id, { tags: merged });
      }),
    );
    const failures = results.filter((r) => r.status === 'rejected');
    if (failures.length > 0)
      alert(`${failures.length} of ${results.length} re-tag operations failed`);
    setTagInput('');
    setShowRetag(false);
    onRefetch();
  }

  async function handleChangePermanence() {
    const results = await Promise.allSettled(
      selectedNodeIds.map((id) => api.patchPermanence(id, permValue)),
    );
    const failures = results.filter((r) => r.status === 'rejected');
    if (failures.length > 0)
      alert(`${failures.length} of ${results.length} permanence updates failed`);
    setShowPerm(false);
    onRefetch();
  }

  async function handleDelete() {
    if (!confirm(`Delete ${selectedNodeIds.length} bubbles? This cannot be undone.`)) return;
    const results = await Promise.allSettled(
      selectedNodeIds.map((id) => api.deleteKnowledgeBubble(id)),
    );
    const failures = results.filter((r) => r.status === 'rejected');
    if (failures.length > 0) alert(`${failures.length} of ${results.length} deletes failed`);
    clearSelection();
    onRefetch();
  }

  return (
    <div
      className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 px-4 py-2 rounded-lg shadow-lg z-10"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
    >
      <span className="text-xs font-medium" style={{ color: 'var(--text)' }}>
        {selectedNodeIds.length} selected
      </span>
      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
        ({selectedTitles.slice(0, PREVIEW_COUNT).join(', ')}
        {selectedTitles.length > PREVIEW_COUNT ? '...' : ''})
      </span>

      <div className="w-px h-4" style={{ background: 'var(--border)' }} />

      {selectedNodeIds.length >= 2 && selectedNodeIds.length <= MERGE_MAX && (
        <button
          onClick={handleMerge}
          className="px-2 py-1 text-xs rounded"
          style={{ background: 'var(--accent)', color: '#fff' }}
        >
          Merge
        </button>
      )}

      <button
        onClick={() => setShowRetag(!showRetag)}
        className="px-2 py-1 text-xs rounded"
        style={{ background: 'var(--bg-hover)', color: 'var(--text)' }}
      >
        Re-tag
      </button>

      {showRetag && (
        <div className="flex items-center gap-1">
          <input
            type="text"
            placeholder="tag1, tag2..."
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleRetag()}
            className="px-1.5 py-0.5 text-xs rounded w-28"
            style={{
              background: 'var(--bg)',
              color: 'var(--text)',
              border: '1px solid var(--border)',
            }}
          />
          <button
            onClick={handleRetag}
            className="px-1.5 py-0.5 text-xs rounded"
            style={{ background: 'var(--accent)', color: '#fff' }}
          >
            Apply
          </button>
        </div>
      )}

      <button
        onClick={() => setShowPerm(!showPerm)}
        className="px-2 py-1 text-xs rounded"
        style={{ background: 'var(--bg-hover)', color: 'var(--text)' }}
      >
        Permanence
      </button>

      {showPerm && (
        <div className="flex items-center gap-1">
          <select
            value={permValue}
            onChange={(e) => setPermValue(e.target.value)}
            className="text-xs px-1.5 py-0.5 rounded"
            style={{ background: 'var(--bg)', color: 'var(--text)', border: 'none' }}
          >
            <option value="temporary">temporary</option>
            <option value="normal">normal</option>
            <option value="robust">robust</option>
          </select>
          <button
            onClick={handleChangePermanence}
            className="px-1.5 py-0.5 text-xs rounded"
            style={{ background: 'var(--accent)', color: '#fff' }}
          >
            Apply
          </button>
        </div>
      )}

      <button
        onClick={handleDelete}
        className="px-2 py-1 text-xs rounded"
        style={{ background: '#ef4444', color: '#fff' }}
      >
        Delete
      </button>

      <button
        onClick={clearSelection}
        className="px-2 py-1 text-xs rounded"
        style={{ color: 'var(--text-muted)' }}
      >
        Cancel
      </button>
    </div>
  );
}
