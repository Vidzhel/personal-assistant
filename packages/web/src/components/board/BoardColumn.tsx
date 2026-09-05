'use client';

import type { ReactNode } from 'react';
import type { BoardColumn as ColKey, BoardCard } from '@/components/board/board-model';

const TITLES: Record<ColKey, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  done: 'Done',
  blocked: 'Blocked',
};

export function BoardColumn({
  column,
  cards,
  onDropCard,
  children,
}: {
  column: ColKey;
  cards: BoardCard[];
  onDropCard?: (cardId: string, column: ColKey) => void;
  children: ReactNode;
}) {
  return (
    <div
      role="region"
      aria-label={TITLES[column]}
      className="flex-1 min-w-0 flex flex-col rounded-lg"
      style={{ background: 'var(--bg)', border: '1px solid var(--border)' }}
      onDragOver={(e) => {
        if (onDropCard) e.preventDefault();
      }}
      onDrop={(e) => {
        const id = e.dataTransfer.getData('text/card-id');
        if (id && onDropCard) onDropCard(id, column);
      }}
    >
      <div
        className="px-3 py-2 text-xs font-semibold flex items-center justify-between"
        style={{ color: 'var(--text-muted)' }}
      >
        <span>{TITLES[column]}</span>
        <span>{cards.length}</span>
      </div>
      <div className="px-2 pb-2 overflow-y-auto" style={{ maxHeight: 'calc(100vh - 220px)' }}>
        {children}
      </div>
    </div>
  );
}
