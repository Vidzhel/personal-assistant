import type { RavenTaskRecord, TaskTreeRecord } from '@/lib/api-client';

export type BoardColumn = 'todo' | 'in_progress' | 'done' | 'blocked';

export interface BoardCard {
  id: string;
  kind: 'task' | 'plan';
  title: string;
  status: string;
  source: string;
  column: BoardColumn;
  draggable: boolean;
  progress?: { completed: number; total: number };
  updatedAt: string;
  raw: RavenTaskRecord | TaskTreeRecord;
}

export type Board = Record<BoardColumn, BoardCard[]>;

const PLAN_ID_PREFIX_LENGTH = 8;

const STATUS_COLUMN: Record<string, BoardColumn> = {
  todo: 'todo',
  pending: 'todo',
  ready: 'todo',
  pending_approval: 'todo',
  'waiting-approval': 'todo',
  in_progress: 'in_progress',
  running: 'in_progress',
  validating: 'in_progress',
  completed: 'done',
  skipped: 'done',
  cancelled: 'done',
  blocked: 'blocked',
  failed: 'blocked',
};

export function statusToColumn(status: string): BoardColumn | null {
  return STATUS_COLUMN[status] ?? null;
}

export interface BuildBoardOptions {
  doneSinceMs?: number;
}

function taskToCard(t: RavenTaskRecord, column: BoardColumn): BoardCard {
  return {
    id: t.id,
    kind: 'task',
    title: t.title,
    status: t.status,
    source: t.source,
    column,
    draggable: t.source === 'manual',
    updatedAt: t.updatedAt,
    raw: t,
  };
}

function treeToCard(t: TaskTreeRecord, column: BoardColumn): BoardCard {
  return {
    id: t.id,
    kind: 'plan',
    title: t.plan ?? `Plan ${t.id.slice(0, PLAN_ID_PREFIX_LENGTH)}`,
    status: t.status,
    source: 'plan',
    column,
    draggable: false,
    progress: { completed: t.completedCount, total: t.taskCount },
    updatedAt: t.createdAt,
    raw: t,
  };
}

export function buildBoard(
  tasks: RavenTaskRecord[],
  trees: TaskTreeRecord[],
  options: BuildBoardOptions = {},
): Board {
  const board: Board = { todo: [], in_progress: [], done: [], blocked: [] };

  const place = (card: BoardCard): void => {
    if (card.column === 'done' && options.doneSinceMs !== undefined) {
      if (Date.parse(card.updatedAt) < options.doneSinceMs) return;
    }
    board[card.column].push(card);
  };

  for (const t of tasks) {
    const col = statusToColumn(t.status);
    if (col) place(taskToCard(t, col));
  }
  for (const t of trees) {
    const col = statusToColumn(t.status);
    if (col) place(treeToCard(t, col));
  }
  return board;
}
