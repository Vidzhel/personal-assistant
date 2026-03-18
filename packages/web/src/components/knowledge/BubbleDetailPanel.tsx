'use client';

import { useEffect, useState, useCallback } from 'react';
import { api, type KnowledgeBubble } from '@/lib/api-client';
import { useKnowledgeStore, type GraphNode } from '@/stores/knowledge-store';

interface DetailContentProps {
  bubble: KnowledgeBubble;
  selectedId: string;
  linkedNodes: GraphNode[];
  onRefetch: () => void;
  onReload: () => void;
}

// eslint-disable-next-line max-lines-per-function -- detail content with multiple editable fields
function DetailContent({
  bubble,
  selectedId,
  linkedNodes,
  onRefetch,
  onReload,
}: DetailContentProps) {
  const selectNode = useKnowledgeStore((s) => s.selectNode);
  const nodes = useKnowledgeStore((s) => s.nodes);
  const [editPermanence, setEditPermanence] = useState(bubble.permanence);
  const [tagInput, setTagInput] = useState('');

  async function handlePermanenceChange(perm: 'temporary' | 'normal' | 'robust') {
    setEditPermanence(perm);
    await api.patchPermanence(selectedId, perm);
    onRefetch();
  }

  async function handleAddTag() {
    if (!tagInput.trim()) return;
    await api.updateKnowledgeBubble(selectedId, { tags: [...bubble.tags, tagInput.trim()] });
    setTagInput('');
    onReload();
    onRefetch();
  }

  async function handleRemoveTag(tag: string) {
    await api.updateKnowledgeBubble(selectedId, { tags: bubble.tags.filter((t) => t !== tag) });
    onReload();
    onRefetch();
  }

  return (
    <>
      <h4 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
        {bubble.title}
      </h4>
      <div
        className="text-xs p-2 rounded max-h-48 overflow-y-auto whitespace-pre-wrap"
        style={{ background: 'var(--bg-card)', color: 'var(--text-muted)' }}
      >
        {bubble.content || '(empty)'}
      </div>
      <div>
        <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
          Tags:
        </span>
        <div className="flex flex-wrap gap-1 mt-1">
          {bubble.tags.map((tag) => (
            <span
              key={tag}
              className="px-1.5 py-0.5 text-xs rounded cursor-pointer"
              style={{ background: 'var(--accent)', color: '#fff' }}
              onClick={() => handleRemoveTag(tag)}
            >
              {tag} x
            </span>
          ))}
          <input
            type="text"
            placeholder="+ tag"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAddTag()}
            className="px-1.5 py-0.5 text-xs rounded w-16"
            style={{
              background: 'var(--bg-card)',
              color: 'var(--text)',
              border: '1px solid var(--border)',
            }}
          />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
          Domain:
        </span>
        <span
          className="px-1.5 py-0.5 text-xs rounded"
          style={{ background: 'var(--bg-card)', color: 'var(--text)' }}
        >
          {bubble.domains?.[0] ?? 'none'}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
          Permanence:
        </span>
        <select
          value={editPermanence}
          onChange={(e) =>
            handlePermanenceChange(e.target.value as 'temporary' | 'normal' | 'robust')
          }
          className="text-xs px-1.5 py-0.5 rounded"
          style={{ background: 'var(--bg-card)', color: 'var(--text)', border: 'none' }}
        >
          <option value="temporary">temporary</option>
          <option value="normal">normal</option>
          <option value="robust">robust</option>
        </select>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
          Cluster:
        </span>
        <span className="text-xs" style={{ color: 'var(--text)' }}>
          {nodes.find((n) => n.id === selectedId)?.clusterLabel ?? 'none'}
        </span>
      </div>
      {bubble.sourceFile && (
        <div>
          <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
            Source:
          </span>
          <span className="text-xs ml-1" style={{ color: 'var(--text)' }}>
            {bubble.sourceFile}
          </span>
        </div>
      )}
      {linkedNodes.length > 0 && (
        <div>
          <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
            Linked ({linkedNodes.length}):
          </span>
          <div className="flex flex-col gap-1 mt-1">
            {linkedNodes.map((n) => (
              <button
                key={n.id}
                onClick={() => selectNode(n.id)}
                className="text-xs text-left px-2 py-1 rounded truncate"
                style={{ background: 'var(--bg-card)', color: 'var(--accent)' }}
              >
                {n.title}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// eslint-disable-next-line max-lines-per-function -- panel wrapper with data fetching
export function BubbleDetailPanel({ onRefetch }: { onRefetch: () => void }) {
  const selectedNodeIds = useKnowledgeStore((s) => s.selectedNodeIds);
  const clearSelection = useKnowledgeStore((s) => s.clearSelection);
  const nodes = useKnowledgeStore((s) => s.nodes);
  const edges = useKnowledgeStore((s) => s.edges);
  const [bubble, setBubble] = useState<KnowledgeBubble | null>(null);
  const [loading, setLoading] = useState(false);

  const selectedId = selectedNodeIds.length === 1 ? selectedNodeIds[0] : null;

  const loadBubble = useCallback(async (id: string) => {
    setLoading(true);
    try {
      setBubble(await api.getKnowledgeBubble(id));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedId) void loadBubble(selectedId);
    else setBubble(null);
  }, [selectedId, loadBubble]);

  if (!selectedId) return null;

  const linkedIds = edges
    .filter((e) => e.source === selectedId || e.target === selectedId)
    .map((e) => (e.source === selectedId ? e.target : e.source));
  const linkedNodes = nodes.filter((n) => linkedIds.includes(n.id));

  return (
    <div
      className="w-80 h-full overflow-y-auto border-l p-4 flex flex-col gap-3"
      style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold" style={{ color: 'var(--text)' }}>
          Bubble Detail
        </h3>
        <button
          onClick={clearSelection}
          className="text-xs px-2 py-0.5 rounded"
          style={{ color: 'var(--text-muted)' }}
        >
          Close
        </button>
      </div>
      {loading && (
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Loading...
        </p>
      )}
      {bubble && (
        <DetailContent
          bubble={bubble}
          selectedId={selectedId}
          linkedNodes={linkedNodes}
          onRefetch={onRefetch}
          onReload={() => loadBubble(selectedId)}
        />
      )}
    </div>
  );
}
