'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, type RavenTaskRecord, type TaskTreeRecord } from '@/lib/api-client';
import {
  buildBoard,
  type Board,
  type BoardColumn as ColKey,
  type BoardCard,
} from '@/components/board/board-model';
import { BoardColumn } from '@/components/board/BoardColumn';
import { TaskCard } from '@/components/board/TaskCard';
import { useTaskStore } from '@/stores/task-store';
import { TaskDetailPanel } from '@/components/tasks/TaskDetailPanel';

const POLL_MS = 10_000;
const HOURS = 48;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const DONE_WINDOW_MS = HOURS * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;

const COLUMNS: ColKey[] = ['todo', 'in_progress', 'done', 'blocked'];
const COLUMN_TARGET_STATUS: Partial<Record<ColKey, string>> = {
  todo: 'todo',
  in_progress: 'in_progress',
  done: 'completed',
  blocked: 'blocked',
};

function DraggableCard({ card, onOpen }: { card: BoardCard; onOpen: (card: BoardCard) => void }) {
  return (
    <div
      draggable={card.draggable}
      onDragStart={(e) => e.dataTransfer.setData('text/card-id', card.id)}
    >
      <TaskCard card={card} onOpen={onOpen} />
    </div>
  );
}

export function TaskBoard({ projectId, search }: { projectId?: string; search?: string }) {
  const { selectTask, selectedTask } = useTaskStore();
  const [tasks, setTasks] = useState<RavenTaskRecord[]>([]);
  const [trees, setTrees] = useState<TaskTreeRecord[]>([]);

  const load = useCallback(async (): Promise<void> => {
    const [t, tr] = await Promise.all([
      api.getTasks({ ...(projectId ? { projectId } : {}), ...(search ? { search } : {}) }),
      api.getTaskTrees(),
    ]);
    setTasks(t);
    // TaskTreeRecord has no projectId, so trees cannot be project-filtered here.
    setTrees(tr);
  }, [projectId, search]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const board: Board = buildBoard(tasks, trees, { doneSinceMs: Date.now() - DONE_WINDOW_MS });

  const handleDrop = (cardId: string, column: ColKey): void => {
    const target = COLUMN_TARGET_STATUS[column];
    const card = tasks.find((t) => t.id === cardId);
    if (!target || !card || card.source !== 'manual') return;
    setTasks((prev) => prev.map((t) => (t.id === cardId ? { ...t, status: target } : t)));
    api.updateTask(cardId, { status: target }).catch(() => void load());
  };

  const onOpen = (card: BoardCard): void => {
    if (card.kind === 'task') void selectTask(card.id);
  };

  return (
    <div className="flex gap-3" style={{ minHeight: '320px' }}>
      {COLUMNS.map((col) => (
        <BoardColumn key={col} column={col} cards={board[col]} onDropCard={handleDrop}>
          {board[col].map((card) => (
            <DraggableCard key={card.id} card={card} onOpen={onOpen} />
          ))}
        </BoardColumn>
      ))}
      {selectedTask && <TaskDetailPanel />}
    </div>
  );
}
