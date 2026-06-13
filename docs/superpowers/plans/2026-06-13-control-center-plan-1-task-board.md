# Control Center — Plan 1: Unified Task Board — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the separate "Tasks" (list/kanban) and "Task Tree" pages with ONE board where every item is a task card placed in a status column (To Do / In Progress / Done / Blocked), badged by source (`manual`/`agent`/`scheduled`/`template`/`pipeline`/`plan`), where an execution plan renders as a grouped task whose children are its steps — embedded in both the global view and the per-project Tasks tab.

**Architecture:** A pure, tested view-model (`board-model.ts`) merges RavenTasks (`/api/tasks`) + TaskTrees (`/api/task-trees`) into `BoardCard`s and maps each to a column via an approved status→column table. A `TaskCard` (built on the Plan 0 `Card`/`Badge`/`Disclosure` primitives) renders a card and lazily fetches its children on expand (subtasks via `getTask`, plan steps via `getTaskTree`). `TaskBoard` lays out four columns, composes the sources, supports drag-to-restatus for `manual` tasks only, and filters/searches. Clicking a card opens the existing `TaskDetailPanel` (generalized in Plan 1-sidebar). The Task-Tree page + nav entry are removed (redirect).

**Tech Stack:** Next.js 16 / React 19, TypeScript ESM, Tailwind v4 + CSS tokens, Zustand, Vitest (node env). Web conventions: `@/` alias, NO file extensions in imports; `.tsx` exempt from `explicit-function-return-type`; ESLint `--max-warnings 0` (functions <50 lines or `// eslint-disable-next-line max-lines-per-function -- reason`); `npm run lint` does NOT type-check web → use `npx tsc --noEmit -p packages/web/tsconfig.json`; no chained shell commands.

**Spec:** `docs/superpowers/specs/2026-06-12-control-center-design.md` §§ 1d (board), Glossary, "Compactness contract". **Depends on Plan 0** (ui primitives) + Plans 1a–1d (unified schedule backend — already merged; the `scheduled` task source + `/api/task-trees` `scheduleId` exist).

**Approved status→column mapping (from the spec):**

| Column | Statuses |
|---|---|
| To Do | `todo`, `pending`, `ready`, `pending_approval`, `waiting-approval` |
| In Progress | `in_progress`, `running`, `validating` |
| Done | `completed`, `skipped`, `cancelled` (Done shows recent ~48h by default) |
| Blocked | `blocked`, `failed` |
| (excluded) | `archived` → not shown by default |

**Verified API surface (exact):**
- `api.getTasks(params)` → `RavenTaskRecord[]` (`{id,title,description?,status,source,assignedAgentId?,projectId?,scheduleId?,parentTaskId?,createdAt,updatedAt,...}`). `api.getTask(id)` → `RavenTaskDetail` (`+ subtasks: RavenTaskRecord[]`). `api.updateTask(id, {status})`. `api.getTaskCounts(projectId?)`.
- `api.getTaskTrees()` → `TaskTreeRecord[]` (`{id,status,plan?,taskCount,completedCount,createdAt}`). `api.getTaskTree(id)` → `TaskTreeDetailRecord` (`+ projectId?, tasks: ExecutionTaskRecord[]`). `ExecutionTaskRecord` = `{id,title,type,status,agent?,blockedBy,summary?,artifacts,retryCount,lastError?,validationResult?}`. `api.approveTaskTree(id)`, `api.cancelTaskTree(id)`, `api.approveTaskTreeTask(treeId,taskId)`.
- Plan 0 primitives: `Card {children,interactive?,selected?,onClick?,className?}`, `Badge {label,bg,fg,title?}` + `StatusBadge {status}` + `SourceBadge {source}`, `Disclosure {open,onToggle,header,children}`, `Button {variant?,size?,loading?,...}`, `IconButton`.
- `task-store.ts` (Zustand): `tasks`, `filters {status?,projectId?,source?,search?,includeArchived?}`, `selectedTask`, `fetchTasks()`, `setFilters()`, `selectTask(id)`, `clearSelection()`, polling 10s.
- `TaskTreeRecord` has no `title` — use `plan` (description) or `Plan ${id.slice(0,8)}`.

**Out of scope (Plan 1-rails / Plan 1-sidebar):** the Agents/Plans/Schedules rails + `Rail` primitive; the polymorphic `DetailPanel` + logs. This plan keeps the existing `TaskDetailPanel` for click-detail and keeps the Agent Monitor sub-tab as-is.

---

### Task 1: Board view-model (pure, tested)

**Files:**
- Create: `packages/web/src/components/board/board-model.ts`
- Test: `packages/web/src/__tests__/board-model.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/__tests__/board-model.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { statusToColumn, buildBoard, type BoardCard } from '@/components/board/board-model';
import type { RavenTaskRecord, TaskTreeRecord } from '@/lib/api-client';

function task(over: Partial<RavenTaskRecord> = {}): RavenTaskRecord {
  return {
    id: 't1', title: 'Task', status: 'todo', source: 'manual', artifacts: [],
    createdAt: '2026-06-13T00:00:00.000Z', updatedAt: '2026-06-13T00:00:00.000Z', ...over,
  } as RavenTaskRecord;
}
function tree(over: Partial<TaskTreeRecord> = {}): TaskTreeRecord {
  return { id: 'tree1', status: 'running', taskCount: 5, completedCount: 3, createdAt: '2026-06-13T00:00:00.000Z', ...over } as TaskTreeRecord;
}

describe('statusToColumn', () => {
  it('maps statuses to the approved columns', () => {
    expect(statusToColumn('todo')).toBe('todo');
    expect(statusToColumn('pending_approval')).toBe('todo');
    expect(statusToColumn('waiting-approval')).toBe('todo');
    expect(statusToColumn('in_progress')).toBe('in_progress');
    expect(statusToColumn('running')).toBe('in_progress');
    expect(statusToColumn('validating')).toBe('in_progress');
    expect(statusToColumn('completed')).toBe('done');
    expect(statusToColumn('cancelled')).toBe('done');
    expect(statusToColumn('blocked')).toBe('blocked');
    expect(statusToColumn('failed')).toBe('blocked');
  });
  it('returns null for archived (excluded)', () => {
    expect(statusToColumn('archived')).toBeNull();
  });
  it('returns null for unknown statuses', () => {
    expect(statusToColumn('weird')).toBeNull();
  });
});

describe('buildBoard', () => {
  it('places tasks and plans into columns with source/kind', () => {
    const board = buildBoard(
      [task({ id: 'a', status: 'todo', source: 'manual' }), task({ id: 'b', status: 'in_progress', source: 'scheduled' })],
      [tree({ id: 'p', status: 'running' })],
    );
    const todo = board.todo.map((c) => c.id);
    const inProg = board.in_progress;
    expect(todo).toContain('a');
    expect(inProg.find((c) => c.id === 'b')?.source).toBe('scheduled');
    const plan = inProg.find((c) => c.id === 'p');
    expect(plan?.kind).toBe('plan');
    expect(plan?.source).toBe('plan');
    expect(plan?.progress).toEqual({ completed: 3, total: 5 });
  });

  it('excludes archived tasks', () => {
    const board = buildBoard([task({ id: 'x', status: 'archived' })], []);
    const all = [...board.todo, ...board.in_progress, ...board.done, ...board.blocked];
    expect(all.find((c) => c.id === 'x')).toBeUndefined();
  });

  it('marks manual tasks draggable and others not', () => {
    const board = buildBoard(
      [task({ id: 'm', source: 'manual' }), task({ id: 's', source: 'scheduled' })],
      [],
    );
    expect(board.todo.find((c) => c.id === 'm')?.draggable).toBe(true);
    expect(board.todo.find((c) => c.id === 's')?.draggable).toBe(false);
  });

  it('trims Done to recent items when a cutoff is given', () => {
    const old = task({ id: 'old', status: 'completed', updatedAt: '2026-01-01T00:00:00.000Z' });
    const recent = task({ id: 'recent', status: 'completed', updatedAt: '2026-06-13T00:00:00.000Z' });
    const board = buildBoard([old, recent], [], { doneSinceMs: Date.parse('2026-06-12T00:00:00.000Z') });
    const doneIds = board.done.map((c) => c.id);
    expect(doneIds).toContain('recent');
    expect(doneIds).not.toContain('old');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/web/src/__tests__/board-model.test.ts`
Expected: FAIL — module `@/components/board/board-model` does not exist.

- [ ] **Step 3: Implement the view-model**

Create `packages/web/src/components/board/board-model.ts`:

```ts
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

/** Map a raw status to a board column, or null if it should not be shown (e.g. archived/unknown). */
export function statusToColumn(status: string): BoardColumn | null {
  return STATUS_COLUMN[status] ?? null;
}

export interface BuildBoardOptions {
  /** Drop Done-column items older than this epoch-ms (default: keep all). */
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

function treeToCard(tree: TaskTreeRecord, column: BoardColumn): BoardCard {
  return {
    id: tree.id,
    kind: 'plan',
    title: tree.plan ?? `Plan ${tree.id.slice(0, 8)}`,
    status: tree.status,
    source: 'plan',
    column,
    draggable: false,
    progress: { completed: tree.completedCount, total: tree.taskCount },
    updatedAt: tree.createdAt,
    raw: tree,
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
  for (const tree of trees) {
    const col = statusToColumn(tree.status);
    if (col) place(treeToCard(tree, col));
  }
  return board;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/web/src/__tests__/board-model.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/board/board-model.ts packages/web/src/__tests__/board-model.test.ts
```
```bash
git commit -m "feat(web): board view-model — merge tasks+trees into status columns (tested)"
```

---

### Task 2: TaskCard component (lazy children)

**Files:**
- Create: `packages/web/src/components/board/TaskCard.tsx`

Presentational — no unit test (no DOM harness; verified by type-check/lint/visual). Built on `Card` + `StatusBadge` + `SourceBadge` + `Disclosure`. Expanding lazily fetches children.

- [ ] **Step 1: Implement TaskCard**

Create `packages/web/src/components/board/TaskCard.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { Card } from '@/components/ui/Card';
import { StatusBadge, SourceBadge } from '@/components/ui/Badge';
import { Disclosure } from '@/components/ui/Disclosure';
import { api, type RavenTaskRecord } from '@/lib/api-client';
import type { BoardCard } from '@/components/board/board-model';

interface ChildItem {
  id: string;
  title: string;
  status: string;
}

async function loadChildren(card: BoardCard): Promise<ChildItem[]> {
  if (card.kind === 'task') {
    const detail = await api.getTask(card.id);
    return detail.subtasks.map((s: RavenTaskRecord) => ({ id: s.id, title: s.title, status: s.status }));
  }
  const tree = await api.getTaskTree(card.id);
  return tree.tasks.map((s) => ({ id: s.id, title: s.title, status: s.status }));
}

export function TaskCard({ card, onOpen }: { card: BoardCard; onOpen: (card: BoardCard) => void }) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<ChildItem[] | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    if (next && children === null && !loading) {
      setLoading(true);
      loadChildren(card)
        .then(setChildren)
        .catch(() => setChildren([]))
        .finally(() => setLoading(false));
    }
  };

  const childCount = card.kind === 'plan' ? card.progress?.total ?? 0 : undefined;

  return (
    <Card interactive selected={false} onClick={() => onOpen(card)} className="mb-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <StatusBadge status={card.status} />
          <span className="text-sm font-medium truncate">{card.title}</span>
        </div>
        <SourceBadge source={card.source} />
      </div>

      {card.progress && (
        <div className="mt-2 flex items-center gap-2">
          <div className="flex-1 h-1.5 rounded-full" style={{ background: 'var(--bg-hover)' }}>
            <div
              className="h-1.5 rounded-full"
              style={{
                width: `${card.progress.total ? (card.progress.completed / card.progress.total) * 100 : 0}%`,
                background: 'var(--accent)',
              }}
            />
          </div>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {card.progress.completed}/{card.progress.total}
          </span>
        </div>
      )}

      <div className="mt-1.5" onClick={(e) => e.stopPropagation()}>
        <Disclosure
          open={open}
          onToggle={toggle}
          header={
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {card.kind === 'plan' ? `${childCount} steps` : 'subtasks'}
            </span>
          }
        >
          {loading && <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Loading…</p>}
          {children?.length === 0 && !loading && (
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>None</p>
          )}
          {children?.map((c) => (
            <div key={c.id} className="flex items-center gap-2 py-0.5 pl-2">
              <StatusBadge status={c.status} />
              <span className="text-xs truncate">{c.title}</span>
            </div>
          ))}
        </Disclosure>
      </div>
    </Card>
  );
}
```

Note: the `onClick={(e) => e.stopPropagation()}` wrapper around `Disclosure` prevents expanding from also triggering the card's `onOpen` (sidebar). Confirm `Card`'s `onClick` fires on the card body — if `Card` doesn't stop propagation internally, this wrapper is what keeps expand and open separate.

- [ ] **Step 2: Type-check + lint**

Run: `npx tsc --noEmit -p packages/web/tsconfig.json`
Expected: clean.
Run: `npx eslint --max-warnings 0 packages/web/src/components/board/TaskCard.tsx`
Expected: clean. (If `max-lines-per-function` fires on `TaskCard`, extract the progress bar or children list into a small sub-component.)

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/board/TaskCard.tsx
```
```bash
git commit -m "feat(web): TaskCard — task/plan card with lazy-loaded expandable children"
```

---

### Task 3: TaskBoard component (columns + compose + drag + filter)

**Files:**
- Create: `packages/web/src/components/board/TaskBoard.tsx`
- Create: `packages/web/src/components/board/BoardColumn.tsx`

- [ ] **Step 1: Implement BoardColumn**

Create `packages/web/src/components/board/BoardColumn.tsx`:

```tsx
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
        className="px-3 py-2 text-xs font-semibold flex items-center justify-between sticky top-0"
        style={{ color: 'var(--text-muted)', background: 'var(--bg)' }}
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
```

- [ ] **Step 2: Implement TaskBoard**

Create `packages/web/src/components/board/TaskBoard.tsx`:

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, type RavenTaskRecord, type TaskTreeRecord } from '@/lib/api-client';
import { buildBoard, type Board, type BoardColumn as ColKey, type BoardCard } from '@/components/board/board-model';
import { BoardColumn } from '@/components/board/BoardColumn';
import { TaskCard } from '@/components/board/TaskCard';
import { TaskDetailPanel } from '@/components/tasks/TaskDetailPanel';

const POLL_MS = 10_000;
const DONE_WINDOW_MS = 48 * 60 * 60 * 1000;
const COLUMNS: ColKey[] = ['todo', 'in_progress', 'done', 'blocked'];

const COLUMN_TARGET_STATUS: Partial<Record<ColKey, string>> = {
  todo: 'todo',
  in_progress: 'in_progress',
  done: 'completed',
  blocked: 'blocked',
};

export function TaskBoard({ projectId, search }: { projectId?: string; search?: string }) {
  const [tasks, setTasks] = useState<RavenTaskRecord[]>([]);
  const [trees, setTrees] = useState<TaskTreeRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const [t, tr] = await Promise.all([
      api.getTasks({ ...(projectId && { projectId }), ...(search && { search }) }),
      api.getTaskTrees(),
    ]);
    setTasks(t);
    setTrees(projectId ? tr.filter((x) => (x as { projectId?: string }).projectId === projectId) : tr);
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
    // optimistic
    setTasks((prev) => prev.map((t) => (t.id === cardId ? { ...t, status: target } : t)));
    api.updateTask(cardId, { status: target }).catch(() => void load());
  };

  const onOpen = (card: BoardCard): void => {
    if (card.kind === 'task') setSelectedId(card.id);
    // plan/step detail handled by Plan 1-sidebar; for now only tasks open the existing panel
  };

  return (
    <div className="flex gap-3 h-full" style={{ minHeight: '320px' }}>
      {COLUMNS.map((col) => (
        <BoardColumn key={col} column={col} cards={board[col]} onDropCard={handleDrop}>
          {board[col].map((card) => (
            <div
              key={card.id}
              draggable={card.draggable}
              onDragStart={(e) => e.dataTransfer.setData('text/card-id', card.id)}
            >
              <TaskCard card={card} onOpen={onOpen} />
            </div>
          ))}
        </BoardColumn>
      ))}
      {selectedId && <TaskDetailPanel taskId={selectedId} onClose={() => setSelectedId(null)} />}
    </div>
  );
}
```

IMPORTANT — verify the existing `TaskDetailPanel` prop API before wiring: read `packages/web/src/components/tasks/TaskDetailPanel.tsx`. The current panel may take a `task: RavenTaskDetail` (fetched by the parent) + `onClose`, rather than a `taskId`. Adapt the `onOpen`/render: if it needs a fetched detail, call `api.getTask(card.id)` in `onOpen`, store the detail, and pass it; match the real prop names exactly (e.g. `<TaskDetailPanel task={detail} onClose={...}/>`). Keep behavior: clicking a task card opens the existing panel.

- [ ] **Step 3: Type-check + lint**

Run: `npx tsc --noEmit -p packages/web/tsconfig.json`
Expected: clean.
Run: `npx eslint --max-warnings 0 packages/web/src/components/board/TaskBoard.tsx packages/web/src/components/board/BoardColumn.tsx`
Expected: clean (extract helpers if `max-lines-per-function` fires on `TaskBoard`).

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/board/TaskBoard.tsx packages/web/src/components/board/BoardColumn.tsx
```
```bash
git commit -m "feat(web): TaskBoard — 4 status columns composing tasks+plans, drag-restatus for manual tasks"
```

---

### Task 4: Wire the Tasks page to the board + project embed

**Files:**
- Modify: `packages/web/src/app/tasks/page.tsx` (Tasks tab → `<TaskBoard/>`)
- Modify: `packages/web/src/components/project/ProjectTasksTab.tsx` (→ `<TaskBoard projectId/>`)

- [ ] **Step 1: Read the current tasks page + ProjectTasksTab**

Read `packages/web/src/app/tasks/page.tsx` and `packages/web/src/components/project/ProjectTasksTab.tsx` to confirm the exact structure (tab keys, the `viewMode` toggle, the `TaskFilters`/`TaskList`/`KanbanBoard` usage).

- [ ] **Step 2: Replace the Tasks tab content with the board**

In `app/tasks/page.tsx`: for the `tasks` tab, render `<TaskBoard />` instead of the list/kanban toggle (`<TaskList/>`/`<KanbanBoard/>`). Remove the `viewMode` toggle (`ViewToggle`) — the board is the single view. Keep the `TaskFilters` bar above the board if present (wire its `search` into `<TaskBoard search={...}/>` via the task-store filter, or render a simple search input that passes `search` down). KEEP the `Agent Monitor` tab unchanged (folds into the Agents rail in Plan 1-rails). Keep the page's existing layout/header.

If the page used `useTaskStore().tab`, keep that for the Tasks/Agent-Monitor switch; only the Tasks-tab body changes.

- [ ] **Step 3: Project embed**

In `packages/web/src/components/project/ProjectTasksTab.tsx`, replace `<KanbanBoard projectId={projectId} />` with `<TaskBoard projectId={projectId} />`.

- [ ] **Step 4: Type-check + lint**

Run: `npx tsc --noEmit -p packages/web/tsconfig.json`
Expected: clean. Grep for now-unused imports (`KanbanBoard`, `TaskList`, `ViewToggle`) in the changed files and remove them; if `KanbanBoard`/`TaskList` are no longer used ANYWHERE, leave the files for now (removed in Step of Task 5) — just don't import them.

Run: `npx eslint --max-warnings 0 packages/web/src/app/tasks/page.tsx packages/web/src/components/project/ProjectTasksTab.tsx`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/app/tasks/page.tsx packages/web/src/components/project/ProjectTasksTab.tsx
```
```bash
git commit -m "feat(web): Tasks page + project Tasks tab render the unified TaskBoard"
```

---

### Task 5: Remove the Task-Tree page + nav entry (redirect)

**Files:**
- Modify: `packages/web/src/components/layout/Sidebar.tsx` (remove the `/task-trees` nav item)
- Replace: `packages/web/src/app/task-trees/page.tsx` (→ redirect to `/tasks`)
- Delete (if now unused): `packages/web/src/components/tasks/KanbanBoard.tsx`, `packages/web/src/components/tasks/TaskList.tsx`

- [ ] **Step 1: Remove the Task Trees nav item**

In `packages/web/src/components/layout/Sidebar.tsx`, delete the `{ href: '/task-trees', label: 'Task Trees', icon: '+' }` entry from the `nav` array.

- [ ] **Step 2: Redirect the old route**

Replace `packages/web/src/app/task-trees/page.tsx` with a client redirect to `/tasks`:

```tsx
'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function TaskTreesRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/tasks');
  }, [router]);
  return null;
}
```

(Anything still linking to `/task-trees` lands on the board.)

- [ ] **Step 3: Remove now-unused components**

Grep for remaining usages:
Run: `grep -rn "KanbanBoard\|components/tasks/TaskList\b\|<TaskList" packages/web/src`
If `KanbanBoard` / `TaskList` have ZERO remaining importers (the board replaced them), delete them:
```bash
git rm packages/web/src/components/tasks/KanbanBoard.tsx packages/web/src/components/tasks/TaskList.tsx
```
If either is still imported somewhere unexpected, leave it and report. (Do NOT delete `TaskListCard.tsx` / `TaskDetailPanel.tsx` / `TaskFilters.tsx` — still used / used by the board's interim panel.)

- [ ] **Step 4: Type-check + lint + build web**

Run: `npx tsc --noEmit -p packages/web/tsconfig.json`
Expected: clean.
Run: `npx eslint --max-warnings 0 packages/web/src/components/layout/Sidebar.tsx packages/web/src/app/task-trees/page.tsx`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add -A
```
```bash
git commit -m "feat(web): retire Task Trees page/nav (board subsumes it); redirect /task-trees → /tasks"
```

---

### Task 6: Full verification

- [ ] **Step 1: Board model test + web tests**

Run: `npx vitest run packages/web/src/__tests__/board-model.test.ts`
Expected: PASS (7).
Run: `npx vitest run --project web`
Expected: all web tests pass (board-model + the Plan 0 css-tokens/badge-helpers + pre-existing web tests).

- [ ] **Step 2: Web type-check + lint/format**

Run: `npx tsc --noEmit -p packages/web/tsconfig.json`
Expected: clean.
Run: `npm run format`
Run: `npm run check`
Expected: our new/changed files clean (baseline lint debt elsewhere is not ours; compare to the known master baseline).

- [ ] **Step 3: Build core (unchanged) + confirm nothing server-side broke**

Run: `npm run build -w packages/shared -w packages/core`
Expected: clean (this plan is web-only; core should be untouched).

- [ ] **Step 4: Visual smoke (manual — your eyes)**

Run: `npm run dev:web`
Open `/tasks` and confirm:
- Four columns (To Do / In Progress / Done / Blocked) with counts.
- Tasks appear as cards with a status badge + source badge; manual tasks drag between columns and persist; scheduled/agent/plan cards are present and NOT draggable.
- Execution plans appear as cards (badge `plan`) with a progress bar; expanding shows their steps; expanding a task shows its subtasks.
- Clicking a task card opens the existing detail panel (solid background — Plan 0 token fix).
- `/task-trees` redirects to `/tasks`; the Task Trees nav entry is gone.
- Open a project → Tasks tab shows the same board scoped to that project.
Stop the dev server when done. (Headless? skip — rely on the view-model tests + type-check.)

- [ ] **Step 5: Push**

```bash
git push
```

---

## Follow-up — Plan 1-rails & Plan 1-sidebar (NOT in this plan)

- **Plan 1-rails:** build the `Rail` primitive (deferred from Plan 0) — a compact, collapsible, single-row strip with title/count/search/show-all — then the **Agents** rail (active vs idle from `/api/agents` + `/api/agent-tasks/active`, click → filter the board), **Execution Plans** rail (running plans from `/api/task-trees`), and **Schedules** rail (`/api/schedules` + `setScheduleEnabled`/`triggerSchedule`, next-run, on/off). Mount them above the board on the Control Center page with the board-always-visible compactness contract. Fold the Agent Monitor tab into the Agents rail. Make the Control Center the home view + remove the `/schedules` (and Agent Monitor) nav items.
- **Plan 1-sidebar:** generalize `TaskDetailPanel` → polymorphic `DetailPanel` accepting `{kind: 'task'|'plan'|'step'|'schedule'|'agent', ...}`, rendering source-specific config + agent output via the `Markdown` primitive + a best-effort **Logs** section. NOTE: `GET /api/logs` filters only by `component`/`level`/`search` (no task/session/agent id filter) — the sidebar can `search=<id>` as a substring best-effort; precise per-item logs need a small backend filter (flagged, separate).
