'use client';

import { useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusBadge, SourceBadge } from '@/components/ui/Badge';
import { Disclosure } from '@/components/ui/Disclosure';
import { api, type RavenTaskRecord } from '@/lib/api-client';
import { canCancelTree, type BoardCard } from '@/components/board/board-model';

const PROGRESS_FULL = 100;

interface ChildItem {
  id: string;
  title: string;
  status: string;
}

async function loadChildren(card: BoardCard): Promise<ChildItem[]> {
  if (card.kind === 'task') {
    const detail = await api.getTask(card.id);
    return detail.subtasks.map((s: RavenTaskRecord) => ({
      id: s.id,
      title: s.title,
      status: s.status,
    }));
  }
  const tree = await api.getTaskTree(card.id);
  return tree.tasks.map((s) => ({ id: s.id, title: s.title, status: s.status }));
}

function ProgressBar({ completed, total }: { completed: number; total: number }) {
  const pct = total ? (completed / total) * PROGRESS_FULL : 0;
  return (
    <div className="mt-2 flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full" style={{ background: 'var(--bg-hover)' }}>
        <div
          className="h-1.5 rounded-full"
          style={{ width: `${pct}%`, background: 'var(--accent)' }}
        />
      </div>
      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
        {completed}/{total}
      </span>
    </div>
  );
}

function ChildList({ loading, items }: { loading: boolean; items: ChildItem[] | null }) {
  if (loading)
    return (
      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
        Loading…
      </p>
    );
  if (items && items.length === 0)
    return (
      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
        None
      </p>
    );
  return (
    <>
      {items?.map((c) => (
        <div key={c.id} className="flex items-center gap-2 py-0.5 pl-2">
          <StatusBadge status={c.status} />
          <span className="text-xs truncate">{c.title}</span>
        </div>
      ))}
    </>
  );
}

function TreeCancelAction({
  card,
  onCancelTree,
}: {
  card: BoardCard;
  onCancelTree?: (treeId: string) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  if (card.kind !== 'plan' || !canCancelTree(card.status)) return null;

  const handleCancelTree = (): void => {
    if (!confirm('Cancel this task tree? Running agent work will be aborted.')) return;
    if (!onCancelTree || cancelling) return;
    setCancelling(true);
    setError(null);
    void onCancelTree(card.id)
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : 'Could not cancel this tree.'),
      )
      .finally(() => setCancelling(false));
  };

  return (
    <div className="mt-2 flex justify-end" onClick={(e) => e.stopPropagation()}>
      {error && <p role="alert">{error}</p>}
      <Button variant="danger" size="sm" onClick={handleCancelTree} disabled={cancelling}>
        {cancelling ? 'Cancelling…' : 'Cancel'}
      </Button>
    </div>
  );
}

interface TaskCardProps {
  card: BoardCard;
  onOpen: (card: BoardCard) => void;
  onCancelTree?: (treeId: string) => Promise<void>;
}

export function TaskCard({ card, onOpen, onCancelTree }: TaskCardProps) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ChildItem[] | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    if (next && items === null && !loading) {
      setLoading(true);
      loadChildren(card)
        .then(setItems)
        .catch(() => setItems([]))
        .finally(() => setLoading(false));
    }
  };

  const childLabel = card.kind === 'plan' ? `${card.progress?.total ?? 0} steps` : 'subtasks';

  return (
    <Card interactive onClick={() => onOpen(card)} className="mb-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <StatusBadge status={card.status} />
          <span className="text-sm font-medium truncate">{card.title}</span>
        </div>
        <SourceBadge source={card.source} />
      </div>

      {card.progress && (
        <ProgressBar completed={card.progress.completed} total={card.progress.total} />
      )}

      <TreeCancelAction card={card} onCancelTree={onCancelTree} />

      <div className="mt-1.5" onClick={(e) => e.stopPropagation()}>
        <Disclosure
          open={open}
          onToggle={toggle}
          header={
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {childLabel}
            </span>
          }
        >
          <ChildList loading={loading} items={items} />
        </Disclosure>
      </div>
    </Card>
  );
}
