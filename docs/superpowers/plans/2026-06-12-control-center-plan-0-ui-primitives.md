# Control Center — Plan 0: UI Primitives & Global Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the in-house UI primitives (`Button`, `IconButton`, `Card`, `Badge`, `Disclosure`, `Markdown`) and fix the global CSS tokens + cursor affordances, so later Control Center work has a consistent, hover/focus-correct foundation — and the transparent sidebar/cards bug is fixed immediately.

**Architecture:** A new `packages/web/src/components/ui/` directory holds small, presentational, app-type-free primitives styled with the existing CSS custom properties. Pure logic (badge color/label mapping) lives in a separate `.ts` helper so it's unit-testable in the node-environment Vitest project. The five undefined CSS tokens are defined in `globals.css`, and a guard test prevents that class of bug from recurring.

**Tech Stack:** Next.js 16 / React 19, TypeScript ESM, Tailwind v4 + CSS custom properties, `react-markdown` + `remark-gfm` (already deps), Vitest 4 (node env, no DOM harness).

**Spec:** `docs/superpowers/specs/2026-06-12-control-center-design.md` § Part 0.

**Conventions (verified — read before starting):**
- **Web import style is different from core/shared:** web uses the `@/` alias (→ `packages/web/src`) and **NO file extensions** in imports (e.g. `import { Badge } from '@/components/ui/Badge'`, or relative `./badge-helpers`). Do **not** add `.ts`/`.tsx` extensions in web imports.
- `.tsx` files are **exempt** from `explicit-function-return-type`; `.ts` files are **not** (helpers need explicit return types).
- ESLint runs with `--max-warnings 0` over `packages/*/src`, so even *warning*-level guardrails fail: keep each function under 50 lines (`max-lines-per-function`) or add `// eslint-disable-next-line max-lines-per-function -- <reason>` exactly like existing `TaskListCard.tsx`/`TaskTreeView.tsx` do. Avoid magic numbers (`no-magic-numbers` is a warning).
- `consistent-type-imports`: use `import type { ... }` for type-only imports.
- **`npm run lint`/`npm run check` does NOT type-check web** (only shared + core). You MUST run `npx tsc --noEmit -p packages/web/tsconfig.json` to type-check web.
- The web Vitest project is **node environment with no DOM/React testing library**. Only pure logic gets unit tests; presentational `.tsx` primitives are verified by type-check + lint + (manual) visual smoke. This matches the project testing philosophy ("unit tests only for complex/reused logic; no cosmetic tests"). Do **not** fabricate render tests.
- Web test files live in `packages/web/src/__tests__/**/*.test.ts` (note: `.test.ts`, not `.tsx`).
- No chained shell commands (`&&`/`;`) — run one per line.
- Pre-existing unrelated test failures (knowledge-*, config-history, template-integration, template-scheduler) are the baseline — do not try to fix them.

**Scope note (deviation from spec Part 0 list):** the `Rail` primitive is **deferred to Plan 1**, where its real consumers (the agents/plans/schedules rails) define its API. Building it now would be speculative. Plan 0 builds only the usage-independent primitives.

---

### Task 1: Global CSS tokens + cursor affordances (+ a guard test)

Fixes the transparent sidebar/cards. Five tokens are referenced across `src` but never defined: `--bg-primary`, `--bg-secondary`, `--accent-bg`, `--text-primary`, `--text-secondary`.

**Files:**
- Create: `packages/web/src/__tests__/css-tokens.test.ts`
- Modify: `packages/web/src/app/globals.css`

- [ ] **Step 1: Write the failing guard test**

Create `packages/web/src/__tests__/css-tokens.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SRC = resolve(__dirname, '..'); // packages/web/src
const GLOBALS = join(SRC, 'app', 'globals.css');

function definedTokens(): Set<string> {
  const css = readFileSync(GLOBALS, 'utf-8');
  const defs = css.match(/--[a-z-]+(?=\s*:)/g) ?? [];
  return new Set(defs.map((d) => d.trim()));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|css)$/.test(name)) out.push(p);
  }
  return out;
}

function referencedTokens(): Set<string> {
  const refs = new Set<string>();
  for (const file of walk(SRC)) {
    const text = readFileSync(file, 'utf-8');
    for (const m of text.matchAll(/var\((--[a-z-]+)\)/g)) refs.add(m[1]);
  }
  return refs;
}

describe('CSS custom properties', () => {
  it('every var(--x) referenced in src is defined in globals.css', () => {
    const defined = definedTokens();
    const missing = [...referencedTokens()].filter((t) => !defined.has(t)).sort();
    expect(missing).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/web/src/__tests__/css-tokens.test.ts`
Expected: FAIL — `missing` is `['--accent-bg', '--bg-primary', '--bg-secondary', '--text-primary', '--text-secondary']` (order sorted).

- [ ] **Step 3: Define the missing tokens**

In `packages/web/src/app/globals.css`, inside the `:root { ... }` block, add these lines immediately after `--error: #ef4444;` (before the closing `}` on line 15):

```css
  /* Additions: referenced across the app but previously undefined */
  --bg-primary: #141414;
  --bg-secondary: #141414;
  --accent-bg: rgba(109, 40, 217, 0.15);
  --text-primary: #e5e5e5;
  --text-secondary: #737373;
```

- [ ] **Step 4: Add the cursor affordance rules**

In the same file, immediately after the `body { ... }` block (after line 21's closing `}`), add:

```css
/* Clickable elements always show a pointer + disabled cue */
button,
[role='button'],
a[href],
summary {
  cursor: pointer;
}

button:disabled,
[role='button'][aria-disabled='true'] {
  cursor: not-allowed;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/web/src/__tests__/css-tokens.test.ts`
Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/app/globals.css packages/web/src/__tests__/css-tokens.test.ts
```
```bash
git commit -m "fix(web): define missing CSS tokens + cursor affordances, add token guard test"
```

---

### Task 2: Badge primitive + badge helpers

Consolidates the status/source color maps duplicated today in `TaskListCard.tsx` and `TaskTreeView.tsx` into one tested helper.

**Files:**
- Create: `packages/web/src/components/ui/badge-helpers.ts`
- Create: `packages/web/src/components/ui/Badge.tsx`
- Test: `packages/web/src/__tests__/badge-helpers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/__tests__/badge-helpers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { statusBadgeProps, sourceBadgeProps } from '@/components/ui/badge-helpers';

describe('statusBadgeProps', () => {
  it('maps known statuses to a label + colors', () => {
    expect(statusBadgeProps('in_progress').label).toBe('In Progress');
    expect(statusBadgeProps('completed').label).toBe('Completed');
    expect(statusBadgeProps('failed').label).toBe('Failed');
  });

  it('treats waiting-approval and pending_approval the same', () => {
    expect(statusBadgeProps('waiting-approval').label).toBe('Needs Approval');
    expect(statusBadgeProps('pending_approval').label).toBe('Needs Approval');
  });

  it('falls back to the raw status with neutral colors', () => {
    const r = statusBadgeProps('totally-unknown');
    expect(r.label).toBe('totally-unknown');
    expect(r.bg).toBe('var(--bg-hover)');
    expect(r.fg).toBe('var(--text-muted)');
  });
});

describe('sourceBadgeProps', () => {
  it('labels known sources', () => {
    expect(sourceBadgeProps('manual').label).toBe('Manual');
    expect(sourceBadgeProps('scheduled').label).toBe('Scheduled');
    expect(sourceBadgeProps('plan').label).toBe('Plan');
    expect(sourceBadgeProps('pipeline').label).toBe('Pipeline');
  });

  it('falls back to the raw source with neutral colors', () => {
    const r = sourceBadgeProps('xyz');
    expect(r.label).toBe('xyz');
    expect(r.fg).toBe('var(--text-muted)');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/web/src/__tests__/badge-helpers.test.ts`
Expected: FAIL — cannot resolve `@/components/ui/badge-helpers` (module does not exist).

- [ ] **Step 3: Implement the helper**

Create `packages/web/src/components/ui/badge-helpers.ts`:

```ts
export interface BadgeStyle {
  label: string;
  bg: string;
  fg: string;
}

type Tone = 'neutral' | 'info' | 'warning' | 'success' | 'error' | 'accent';

const TONE: Record<Tone, { bg: string; fg: string }> = {
  neutral: { bg: 'var(--bg-hover)', fg: 'var(--text-muted)' },
  info: { bg: 'rgba(59,130,246,0.2)', fg: 'rgb(96,165,250)' },
  warning: { bg: 'rgba(234,179,8,0.2)', fg: 'rgb(250,204,21)' },
  success: { bg: 'rgba(34,197,94,0.2)', fg: 'rgb(74,222,128)' },
  error: { bg: 'rgba(239,68,68,0.2)', fg: 'rgb(248,113,113)' },
  accent: { bg: 'rgba(168,85,247,0.2)', fg: 'rgb(192,132,252)' },
};

const STATUS: Record<string, { tone: Tone; label: string }> = {
  todo: { tone: 'neutral', label: 'To Do' },
  pending: { tone: 'neutral', label: 'Pending' },
  ready: { tone: 'info', label: 'Ready' },
  in_progress: { tone: 'warning', label: 'In Progress' },
  running: { tone: 'warning', label: 'Running' },
  validating: { tone: 'info', label: 'Validating' },
  completed: { tone: 'success', label: 'Completed' },
  failed: { tone: 'error', label: 'Failed' },
  blocked: { tone: 'error', label: 'Blocked' },
  skipped: { tone: 'neutral', label: 'Skipped' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
  archived: { tone: 'neutral', label: 'Archived' },
  pending_approval: { tone: 'accent', label: 'Needs Approval' },
  'waiting-approval': { tone: 'accent', label: 'Needs Approval' },
};

const SOURCE: Record<string, { tone: Tone; label: string }> = {
  manual: { tone: 'neutral', label: 'Manual' },
  agent: { tone: 'info', label: 'Agent' },
  template: { tone: 'accent', label: 'Template' },
  ticktick: { tone: 'info', label: 'TickTick' },
  pipeline: { tone: 'accent', label: 'Pipeline' },
  scheduled: { tone: 'warning', label: 'Scheduled' },
  schedule: { tone: 'warning', label: 'Scheduled' },
  plan: { tone: 'accent', label: 'Plan' },
};

function toStyle(entry: { tone: Tone; label: string } | undefined, raw: string): BadgeStyle {
  if (!entry) return { label: raw, bg: TONE.neutral.bg, fg: TONE.neutral.fg };
  return { label: entry.label, bg: TONE[entry.tone].bg, fg: TONE[entry.tone].fg };
}

export function statusBadgeProps(status: string): BadgeStyle {
  return toStyle(STATUS[status], status);
}

export function sourceBadgeProps(source: string): BadgeStyle {
  return toStyle(SOURCE[source], source);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/web/src/__tests__/badge-helpers.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Implement the Badge component**

Create `packages/web/src/components/ui/Badge.tsx`:

```tsx
'use client';

import type { CSSProperties } from 'react';
import { statusBadgeProps, sourceBadgeProps, type BadgeStyle } from './badge-helpers';

export function Badge({ label, bg, fg, title }: BadgeStyle & { title?: string }) {
  const style: CSSProperties = { background: bg, color: fg };
  return (
    <span
      className="text-xs px-1.5 py-0.5 rounded-full whitespace-nowrap"
      style={style}
      title={title}
    >
      {label}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge {...statusBadgeProps(status)} title={status} />;
}

export function SourceBadge({ source }: { source: string }) {
  return <Badge {...sourceBadgeProps(source)} title={source} />;
}
```

- [ ] **Step 6: Type-check + lint the new files**

Run: `npx tsc --noEmit -p packages/web/tsconfig.json`
Expected: no errors.

Run: `npx eslint --max-warnings 0 packages/web/src/components/ui/badge-helpers.ts packages/web/src/components/ui/Badge.tsx`
Expected: no output (clean).

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/components/ui/badge-helpers.ts packages/web/src/components/ui/Badge.tsx packages/web/src/__tests__/badge-helpers.test.ts
```
```bash
git commit -m "feat(web): add Badge primitive + tested status/source badge helpers"
```

---

### Task 3: Button + IconButton primitives

**Files:**
- Create: `packages/web/src/components/ui/Button.tsx`
- Create: `packages/web/src/components/ui/IconButton.tsx`

No unit test (presentational, no DOM harness — verified by type-check + lint).

- [ ] **Step 1: Implement Button**

Create `packages/web/src/components/ui/Button.tsx`:

```tsx
'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

const VARIANT: Record<Variant, { bg: string; fg: string; border: string; hover: string }> = {
  primary: { bg: 'var(--accent)', fg: '#ffffff', border: 'transparent', hover: 'var(--accent-hover)' },
  secondary: { bg: 'var(--bg-card)', fg: 'var(--text)', border: 'var(--border)', hover: 'var(--bg-hover)' },
  ghost: { bg: 'transparent', fg: 'var(--text-muted)', border: 'transparent', hover: 'var(--bg-hover)' },
  danger: { bg: 'var(--error)', fg: '#ffffff', border: 'transparent', hover: '#dc2626' },
};

const SIZE: Record<Size, string> = {
  sm: 'text-xs px-2 py-1',
  md: 'text-sm px-3 py-1.5',
};

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  children: ReactNode;
}

export function Button({ variant = 'secondary', size = 'md', loading, disabled, children, ...rest }: ButtonProps) {
  const v = VARIANT[variant];
  const off = disabled === true || loading === true;
  return (
    <button
      {...rest}
      disabled={off}
      className={`inline-flex items-center gap-1.5 rounded-md border font-medium transition-colors disabled:opacity-50 ${SIZE[size]}`}
      style={{ background: v.bg, color: v.fg, borderColor: v.border }}
      onMouseEnter={(e) => {
        if (!off) e.currentTarget.style.background = v.hover;
      }}
      onMouseLeave={(e) => {
        if (!off) e.currentTarget.style.background = v.bg;
      }}
    >
      {loading === true ? '…' : children}
    </button>
  );
}
```

- [ ] **Step 2: Implement IconButton**

Create `packages/web/src/components/ui/IconButton.tsx`:

```tsx
'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  'aria-label': string;
  children: ReactNode;
}

export function IconButton({ children, disabled, ...rest }: IconButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled}
      className="inline-flex items-center justify-center w-7 h-7 rounded-md transition-colors disabled:opacity-50"
      style={{ color: 'var(--text-muted)' }}
      onMouseEnter={(e) => {
        if (disabled !== true) e.currentTarget.style.background = 'var(--bg-hover)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
    >
      {children}
    </button>
  );
}
```

- [ ] **Step 3: Type-check + lint**

Run: `npx tsc --noEmit -p packages/web/tsconfig.json`
Expected: no errors.

Run: `npx eslint --max-warnings 0 packages/web/src/components/ui/Button.tsx packages/web/src/components/ui/IconButton.tsx`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/ui/Button.tsx packages/web/src/components/ui/IconButton.tsx
```
```bash
git commit -m "feat(web): add Button + IconButton primitives with hover/disabled affordances"
```

---

### Task 4: Card primitive

**Files:**
- Create: `packages/web/src/components/ui/Card.tsx`

- [ ] **Step 1: Implement Card**

Create `packages/web/src/components/ui/Card.tsx`:

```tsx
'use client';

import type { CSSProperties, ReactNode } from 'react';

interface CardProps {
  children: ReactNode;
  interactive?: boolean;
  selected?: boolean;
  onClick?: () => void;
  className?: string;
}

export function Card({ children, interactive, selected, onClick, className = '' }: CardProps) {
  const style: CSSProperties = {
    background: 'var(--bg-card)',
    borderColor: selected === true ? 'var(--accent)' : 'var(--border)',
  };
  return (
    <div
      onClick={onClick}
      role={interactive === true ? 'button' : undefined}
      tabIndex={interactive === true ? 0 : undefined}
      className={`rounded-lg border p-3 ${interactive === true ? 'transition-colors' : ''} ${className}`}
      style={style}
      onMouseEnter={(e) => {
        if (interactive === true) e.currentTarget.style.background = 'var(--bg-hover)';
      }}
      onMouseLeave={(e) => {
        if (interactive === true) e.currentTarget.style.background = 'var(--bg-card)';
      }}
    >
      {children}
    </div>
  );
}
```

- [ ] **Step 2: Type-check + lint**

Run: `npx tsc --noEmit -p packages/web/tsconfig.json`
Expected: no errors.

Run: `npx eslint --max-warnings 0 packages/web/src/components/ui/Card.tsx`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/ui/Card.tsx
```
```bash
git commit -m "feat(web): add Card primitive with interactive hover state"
```

---

### Task 5: Disclosure primitive

Controlled expand/collapse used by task/plan cards and (later) the rails.

**Files:**
- Create: `packages/web/src/components/ui/Disclosure.tsx`

- [ ] **Step 1: Implement Disclosure**

Create `packages/web/src/components/ui/Disclosure.tsx`:

```tsx
'use client';

import type { ReactNode } from 'react';

interface DisclosureProps {
  open: boolean;
  onToggle: () => void;
  header: ReactNode;
  children: ReactNode;
}

export function Disclosure({ open, onToggle, header, children }: DisclosureProps) {
  return (
    <div>
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="flex items-center gap-1.5 w-full text-left"
        style={{ color: 'var(--text-muted)' }}
      >
        <span
          className="text-xs inline-block transition-transform"
          style={{ transform: open ? 'rotate(90deg)' : 'none' }}
        >
          ▸
        </span>
        {header}
      </button>
      {open && <div className="mt-1.5">{children}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Type-check + lint**

Run: `npx tsc --noEmit -p packages/web/tsconfig.json`
Expected: no errors.

Run: `npx eslint --max-warnings 0 packages/web/src/components/ui/Disclosure.tsx`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/ui/Disclosure.tsx
```
```bash
git commit -m "feat(web): add controlled Disclosure primitive"
```

---

### Task 6: Markdown primitive (lift from ChatPanel)

Extract the existing chat markdown rendering into a reusable primitive and rewire `ChatPanel` to use it. This is the canonical "markdown text box" for agent output.

**Files:**
- Create: `packages/web/src/components/ui/Markdown.tsx`
- Modify: `packages/web/src/components/chat/ChatPanel.tsx` (imports at lines 4–5; `MarkdownBlock` at 166–179; `ContentBubble` at 193–213)

- [ ] **Step 1: Implement the Markdown primitive**

Create `packages/web/src/components/ui/Markdown.tsx`:

```tsx
'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function Markdown({ content }: { content: string }) {
  return (
    <div className="markdown-content">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}
```

- [ ] **Step 2: Add the import to ChatPanel**

In `packages/web/src/components/chat/ChatPanel.tsx`, add to the imports near the top (after the existing component imports). Then **remove** the now-unused `import ReactMarkdown from 'react-markdown';` (line 4) and `import remarkGfm from 'remark-gfm';` (line 5):

```tsx
import { Markdown } from '@/components/ui/Markdown';
```

- [ ] **Step 3: Replace `MarkdownBlock`**

Replace the `MarkdownBlock` function (currently lines 166–179) with:

```tsx
function MarkdownBlock({ content }: { content: string }) {
  return (
    <div
      className="max-w-[80%] px-4 py-2 rounded-lg text-sm"
      style={{
        background: 'var(--bg-card)',
        color: 'var(--text)',
        border: '1px solid var(--border)',
      }}
    >
      <Markdown content={content} />
    </div>
  );
}
```

- [ ] **Step 4: Replace `ContentBubble`'s inline markdown**

Replace the `ContentBubble` function (currently lines 193–213) with:

```tsx
function ContentBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] px-4 py-2 rounded-lg text-sm${isUser ? ' whitespace-pre-wrap' : ''}`}
        style={{
          background: isUser ? 'var(--accent)' : 'var(--bg-card)',
          color: 'var(--text)',
          border: isUser ? 'none' : '1px solid var(--border)',
        }}
      >
        {isUser ? message.content : <Markdown content={message.content} />}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Type-check + lint (catches any leftover unused import)**

Run: `npx tsc --noEmit -p packages/web/tsconfig.json`
Expected: no errors.

Run: `npx eslint --max-warnings 0 packages/web/src/components/ui/Markdown.tsx packages/web/src/components/chat/ChatPanel.tsx`
Expected: no output. (If it reports `ReactMarkdown`/`remarkGfm` unused, remove those two import lines — Step 2.)

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/ui/Markdown.tsx packages/web/src/components/chat/ChatPanel.tsx
```
```bash
git commit -m "feat(web): extract reusable Markdown primitive, rewire ChatPanel to use it"
```

---

### Task 7: Full verification

- [ ] **Step 1: Format the new/changed files**

Run: `npm run format`
Expected: Prettier writes any formatting fixes (new `ui/` files, ChatPanel, globals.css, tests).

- [ ] **Step 2: Web type-check**

Run: `npx tsc --noEmit -p packages/web/tsconfig.json`
Expected: clean (no errors).

- [ ] **Step 3: Lint/format/strip-types gate**

Run: `npm run check`
Expected: passes. (ESLint over all `packages/*/src` clean for our files; pre-existing errors elsewhere, if any, are the baseline — our new files contribute zero.)

- [ ] **Step 4: Run the web test suite**

Run: `npx vitest run --project web`
Expected: all web tests pass, including the new `css-tokens` (1) and `badge-helpers` (5) tests, plus the pre-existing web tests (project-tab-registry, project-hub, references, knowledge-store).

- [ ] **Step 5: Visual smoke (manual)**

Run: `npm run dev:web`
Then open the dashboard and confirm: the task detail sidebar and task cards now have a solid dark background (no transparency), and buttons/clickable rows show a pointer cursor on hover. Stop the dev server when done (Ctrl-C).

(This step is a human visual check — there is no automated DOM test. If running headless, skip and rely on the token guard test.)

- [ ] **Step 6: Push**

```bash
git push
```

---

## Follow-up (later plans, not here)

- **Plan 1 — Control Center:** builds the `Rail` primitive (deferred from here), the three rails, the kanban `TaskBoard` (source badges, plan-as-grouped-task-with-steps), the polymorphic `DetailPanel` (detail/config/logs), and the schedule backend slice. Migrates `TaskListCard`/`TaskTreeView` onto `Card`/`Badge`.
- **Plan 2 — System copilot:** wire the Raven MCP to the meta agent + dock the chat.
- **Plan 3 — Gmail watcher hardening:** independent.
