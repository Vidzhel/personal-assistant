'use client';

import { useState } from 'react';
import { usePolling } from '@/hooks/usePolling';
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
import { TreeDetailPanel } from '@/components/tasks/TreeDetailPanel';

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

function DraggableCard({
  card,
  onOpen,
  onCancelTree,
}: {
  card: BoardCard;
  onOpen: (card: BoardCard) => void;
  onCancelTree: (treeId: string) => Promise<void>;
}) {
  return (
    <div
      draggable={card.draggable}
      onDragStart={(e) => e.dataTransfer.setData('text/card-id', card.id)}
    >
      <TaskCard card={card} onOpen={onOpen} onCancelTree={onCancelTree} />
    </div>
  );
}

function SelectedDetailPanels({
  selectedTask,
  selectedTree,
  load,
  closeTree,
}: {
  selectedTask: boolean;
  selectedTree: string | null;
  load: () => void;
  closeTree: () => void;
}) {
  return (
    <>
      {selectedTask && <TaskDetailPanel />}
      {selectedTree && (
        <TreeDetailPanel
          key={selectedTree}
          treeId={selectedTree}
          onClose={closeTree}
          onRefresh={load}
        />
      )}
    </>
  );
}

function BoardColumns({
  board,
  onDrop,
  onOpen,
  onCancelTree,
}: {
  board: Board;
  onDrop: (cardId: string, column: ColKey) => void;
  onOpen: (card: BoardCard) => void;
  onCancelTree: (treeId: string) => Promise<void>;
}) {
  return (
    <>
      {COLUMNS.map((col) => (
        <BoardColumn key={col} column={col} cards={board[col]} onDropCard={onDrop}>
          {board[col].map((card) => (
            <DraggableCard key={card.id} card={card} onOpen={onOpen} onCancelTree={onCancelTree} />
          ))}
        </BoardColumn>
      ))}
    </>
  );
}

export function TaskBoard({ projectId, search }: { projectId?: string; search?: string }) {
  const { clearSelection, selectTask, selectedTask } = useTaskStore();
  const [selectedTree, setSelectedTree] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { tasks, trees, load, loadError } = useBoardResources(projectId, search);

  const board: Board = buildBoard(tasks, trees, { doneSinceMs: Date.now() - DONE_WINDOW_MS });

  const handleDrop = (cardId: string, column: ColKey): void => {
    const target = COLUMN_TARGET_STATUS[column];
    const card = tasks.find((t) => t.id === cardId);
    if (!target || !card || card.source !== 'manual') return;
    setError(null);
    api
      .updateTask(cardId, { status: target })
      .then(load)
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : 'Could not update task.'),
      );
  };

  const onOpen = (card: BoardCard): void => {
    if (card.kind === 'task') {
      setSelectedTree(null);
      void selectTask(card.id);
    } else {
      clearSelection();
      setSelectedTree(card.id);
    }
  };

  const handleCancelTree = async (treeId: string): Promise<void> => {
    await api.cancelTaskTree(treeId);
    load();
  };

  return (
    <div className="flex flex-col gap-3 sm:flex-row" style={{ minHeight: '320px' }}>
      {(error || loadError) && <p role="alert">{error ?? loadError}</p>}
      <BoardColumns
        board={board}
        onDrop={handleDrop}
        onOpen={onOpen}
        onCancelTree={handleCancelTree}
      />
      <SelectedDetailPanels
        selectedTask={selectedTask !== null}
        selectedTree={selectedTree}
        load={load}
        closeTree={() => setSelectedTree(null)}
      />
    </div>
  );
}

function useBoardResources(
  projectId?: string,
  search?: string,
): {
  tasks: RavenTaskRecord[];
  trees: TaskTreeRecord[];
  load: () => void;
  loadError: string | null;
} {
  const query = new URLSearchParams();
  if (projectId) query.set('projectId', projectId);
  if (search) query.set('search', search);
  const taskList = usePolling<RavenTaskRecord[]>(`/tasks?${query}`, POLL_MS);
  const treeList = usePolling<TaskTreeRecord[]>('/task-trees', POLL_MS);
  const tasks = taskList.data ?? [];
  const trees = (treeList.data ?? []).filter((tree) => !projectId || tree.projectId === projectId);
  const load = () => {
    taskList.refresh();
    treeList.refresh();
  };

  return {
    tasks,
    trees,
    load,
    loadError: taskList.error?.message ?? treeList.error?.message ?? null,
  };
}
