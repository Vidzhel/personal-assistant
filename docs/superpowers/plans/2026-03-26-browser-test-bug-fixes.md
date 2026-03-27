# Browser Test Bug Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all actual bugs discovered during the full manual test suite run (9 bugs, 4 outdated specs) plus Gmail watcher NDJSON parsing issue.

**Architecture:** Targeted fixes across core backend (git-history cwd, agent route typo), web frontend (status mapping, agent form, knowledge graph z-index, tab state), pipeline config (skill name reference), and Gmail email watcher (multi-line JSON handling).

**Tech Stack:** TypeScript, Next.js (React), Fastify, SQLite, Tailwind CSS

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `packages/core/src/config-history/git-history.ts` | Modify | Add `cwd` to all `execFile` git calls |
| `packages/web/src/components/dashboard/StatusCards.tsx` | Modify | Map "degraded" to "Degraded" instead of "Offline" |
| `packages/core/src/api/routes/agents.ts:117` | Modify | Fix missing `/` in PATCH route path |
| `packages/web/src/components/agents/AgentFormModal.tsx` | Modify | Fix edit form to send all fields directly |
| `packages/web/src/components/knowledge/GraphChatPanel.tsx` | Modify | Fix Chat button z-index when detail panel open |
| `config/pipelines/system-maintenance.yaml` | Modify | Change `skill: orchestrator` to `skill: _orchestrator` |
| `packages/web/src/app/projects/[id]/page.tsx` | Modify | Render all tabs, hide inactive with CSS |
| `suites/google-workspace/services/email-watcher.ts` | Modify | Handle multi-line JSON from gws CLI |
| `manual-tests/01-smoke-test.md` | Modify | Update SM-01 for Life Dashboard |
| `manual-tests/02-navigation-and-layout.md` | Modify | Update sidebar link count from 10 to 13 |
| `manual-tests/03-dashboard.md` | Modify | Replace Quick Actions tests with Life Dashboard tests |
| `manual-tests/04-projects-and-chat.md` | Modify | Update PROJ-10 for hub/tabbed layout |
| `manual-tests/16-kanban-task-board.md` | Rewrite | Match current Tasks + Agent Monitor UI |

---

### Task 1: Fix config-history git `cwd` (HIGH — entire feature broken)

**Files:**
- Modify: `packages/core/src/config-history/git-history.ts`

The root cause: every `execFile('git', [...])` call runs git from the process cwd (`packages/core/`) instead of the project root. The `config/` directory is at the project root.

- [ ] **Step 1: Add cached project root resolver**

Add after line 7 (`const log = createLogger('config-history');`):

```typescript
let cachedRoot: string | undefined;
async function getProjectRoot(): Promise<string> {
  if (!cachedRoot) {
    // git rev-parse --show-toplevel works from any subdirectory within the repo
    const { stdout } = await execFile('git', ['rev-parse', '--show-toplevel']);
    cachedRoot = stdout.trim();
  }
  return cachedRoot;
}
```

- [ ] **Step 2: Add `cwd` option to every `execFile` call**

Every `execFile('git', [...])` call in the file needs `{ cwd: await getProjectRoot() }` as the third argument. Update each one:

In `getConfigCommits`:
```typescript
// Line 32 — git log
const cwd = await getProjectRoot();
const { stdout } = await execFile('git', [
  'log', `--pretty=format:${GIT_LOG_FORMAT}`, `--skip=${offset}`, `-${limit}`, '--', CONFIG_DIR,
], { cwd });

// Line 53 — git diff-tree (inside the for loop)
const { stdout: filesOut } = await execFile('git', [
  'diff-tree', '--no-commit-id', '--name-only', '-r', hash, '--', CONFIG_DIR,
], { cwd });
```

In `getCommitDetail`:
```typescript
// Line 78 — git log
const cwd = await getProjectRoot();
const { stdout: logOut } = await execFile('git', [
  'log', '-1', `--pretty=format:${GIT_LOG_FORMAT}`, hash, '--', CONFIG_DIR,
], { cwd });

// Line 95 — git diff-tree
const { stdout: filesOut } = await execFile('git', [
  'diff-tree', '--no-commit-id', '--name-only', '-r', hash, '--', CONFIG_DIR,
], { cwd });

// Line 107 — git show
const { stdout: diffOut } = await execFile('git', ['show', hash, '--', CONFIG_DIR], { cwd });
```

In `revertConfigFile` — replace the inline `git rev-parse --show-toplevel` call (line 157) with the cached version, and add `{ cwd }` to all git calls:
```typescript
// Line 153-169: single-file revert path
const cwd = await getProjectRoot();
if (filePath) {
  validateFilePath(filePath);
  const { join } = await import('node:path');
  const absolutePath = join(cwd, filePath);

  await execFile('git', ['show', `${hash}~1:${filePath}`], { cwd }).then(async ({ stdout: content }) => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(absolutePath, content);
  });
  await execFile('git', ['add', filePath], { cwd });
  const shortHash = hash.slice(0, SHORT_SHA_LENGTH);
  await execFile('git', ['commit', '-m', `revert: ${filePath} from commit ${shortHash}`], { cwd });
  reloadedConfigs.push(filePath);
} else {
  // Line 174: full commit revert
  await execFile('git', ['revert', '--no-edit', hash], { cwd });
  const { stdout: filesOut } = await execFile('git', [
    'diff-tree', '--no-commit-id', '--name-only', '-r', hash, '--', CONFIG_DIR,
  ], { cwd });
  reloadedConfigs.push(...(filesOut.trim() ? filesOut.trim().split('\n') : []));
}

// Line 190: get revert commit hash
const { stdout: headOut } = await execFile('git', ['rev-parse', 'HEAD'], { cwd });
```

- [ ] **Step 3: Run `npm run check`**

```bash
npm run check
```
Expected: passes (no type errors, lint clean)

- [ ] **Step 4: Verify the fix**

```bash
curl -s http://localhost:4001/api/config-history | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Commits: {len(d[\"commits\"])}')"
```
Expected: `Commits: N` where N > 0

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config-history/git-history.ts
git commit -m "fix: add cwd to git execFile calls in config-history — resolves broken config history feature"
```

**Rerun tests:** `manual-tests/31-config-history.md` (all 11 tests)

---

### Task 2: Fix dashboard "Offline" status for degraded backend (MEDIUM)

**Files:**
- Modify: `packages/web/src/components/dashboard/StatusCards.tsx:20-21`

The dashboard maps `health.status !== 'ok'` to "Offline". When the backend is healthy but one skill fails to load, status is "degraded" — not offline.

- [ ] **Step 1: Update status mapping**

```typescript
// Before (line 20-21):
value: health?.status === 'ok' ? 'Online' : 'Offline',
color: health?.status === 'ok' ? 'var(--success)' : 'var(--error)',

// After:
value: health?.status === 'ok' ? 'Online' : health?.status === 'degraded' ? 'Degraded' : 'Offline',
color: health?.status === 'ok' ? 'var(--success)' : health?.status === 'degraded' ? 'var(--warning, #eab308)' : 'var(--error)',
```

- [ ] **Step 2: Run `npm run check` and commit**

```bash
npm run check
git add packages/web/src/components/dashboard/StatusCards.tsx
git commit -m "fix: show 'Degraded' instead of 'Offline' when backend status is degraded"
```

**Rerun tests:** `manual-tests/01-smoke-test.md` (SM-05), `manual-tests/03-dashboard.md` (DASH-03), `manual-tests/08-integration-flows.md` (INT-08)

---

### Task 3: Fix agent PATCH route typo + edit form (MEDIUM)

**Files:**
- Modify: `packages/core/src/api/routes/agents.ts:117`
- Modify: `packages/web/src/components/agents/AgentFormModal.tsx:66-79`

Two bugs combine here:

1. **Backend route typo**: Line 117 has `app.patch('/api/agents:id', ...)` — missing the `/` before `:id`. The PATCH route never matches. This is the primary cause of AGENT-05 (PUT not found) and AGENT-14 (edit not working). The store's `updateAgent` calls `api.updateAgent` which sends `PATCH /api/agents/{id}` but the route is registered as `/api/agents:id` (no slash) so Fastify returns 404.

2. **Frontend form**: The `handleSubmit` function uses `description || undefined` which strips empty strings via `JSON.stringify`. For edits, send values directly.

- [ ] **Step 1: Fix the backend route path typo**

```typescript
// Before (line 117):
app.patch('/api/agents:id', async (req, reply) => {

// After:
app.patch('/api/agents/:id', async (req, reply) => {
```

- [ ] **Step 2: Fix the frontend form to send all fields on edit**

In `packages/web/src/components/agents/AgentFormModal.tsx`, replace the `handleSubmit` function (lines 66-79):

```typescript
// Before:
async function handleSubmit() {
  if (!validateName(name)) return;
  const data = {
    name,
    description: description || undefined,
    instructions: instructions || undefined,
    suiteIds: Array.from(selectedSuites),
  };

  if (editing) {
    await updateAgent(editing.id, data);
  } else {
    await createAgent(data);
  }
}

// After:
async function handleSubmit() {
  if (!validateName(name)) return;
  if (editing) {
    await updateAgent(editing.id, {
      name,
      description,
      instructions,
      suiteIds: Array.from(selectedSuites),
    });
  } else {
    await createAgent({
      name,
      description: description || undefined,
      instructions: instructions || undefined,
      suiteIds: Array.from(selectedSuites),
    });
  }
}
```

Key change: for edits, send `description` and `instructions` directly (even if empty string) instead of using `|| undefined` which causes `JSON.stringify` to strip the key entirely.

- [ ] **Step 3: Run `npm run check` and commit**

```bash
npm run check
git add packages/core/src/api/routes/agents.ts packages/web/src/components/agents/AgentFormModal.tsx
git commit -m "fix: agent PATCH route missing slash + edit form sends all fields"
```

**Rerun tests:** `manual-tests/27-agent-management.md` (AGENT-05, AGENT-14)

---

### Task 4: Fix knowledge graph Chat button z-index overlap (LOW)

**Files:**
- Modify: `packages/web/src/components/knowledge/GraphChatPanel.tsx:70`

The Chat toggle button has `z-10` but the BubbleDetailPanel has `z-20`, so the detail panel covers the button. When a node is selected, the user can't open Chat.

- [ ] **Step 1: Raise Chat button z-index above detail panel**

```typescript
// Before (line 70):
className="absolute bottom-4 right-4 px-3 py-2 rounded-lg shadow-lg text-xs z-10"

// After:
className="absolute bottom-4 right-4 px-3 py-2 rounded-lg shadow-lg text-xs z-30"
```

- [ ] **Step 2: Run `npm run check` and commit**

```bash
npm run check
git add packages/web/src/components/knowledge/GraphChatPanel.tsx
git commit -m "fix: raise Chat button z-index above detail panel on knowledge graph"
```

**Rerun tests:** `manual-tests/20-knowledge-graph.md` (KGRAPH-42)

---

### Task 5: Fix system-maintenance pipeline skill reference (MEDIUM)

**Files:**
- Modify: `config/pipelines/system-maintenance.yaml:18`

The pipeline references `skill: orchestrator` but the skill registers as `_orchestrator`.

- [ ] **Step 1: Update skill reference**

```yaml
# Before (line 18):
    skill: orchestrator

# After:
    skill: _orchestrator
```

- [ ] **Step 2: Commit**

```bash
git add config/pipelines/system-maintenance.yaml
git commit -m "fix: system-maintenance pipeline references _orchestrator (not orchestrator)"
```

**Rerun tests:** `manual-tests/29-system-maintenance.md` (MAINT-01)

---

### Task 6: Fix project hub tab switch losing draft text (LOW)

**Files:**
- Modify: `packages/web/src/app/projects/[id]/page.tsx:124-133`

The project page uses dynamic component lookup (`const ActiveComponent = tabs.find(...)?.component`) and conditional rendering, which unmounts tab components when switching. Chat input state is lost.

Fix: render all tab components simultaneously, hide inactive ones with `display: none`.

- [ ] **Step 1: Replace conditional rendering with always-mounted hidden tabs**

```tsx
// Before (lines 124-133):
<div className="flex-1 overflow-hidden">
  {ActiveComponent && (
    <ActiveComponent
      projectId={id}
      projectName={project.name}
      project={project}
      onProjectUpdated={setProject}
      onNewSession={handleNewSession}
    />
  )}
</div>

// After (remove the ActiveComponent variable on line 63 as well):
<div className="flex-1 overflow-hidden">
  {tabs.map((t) => (
    <div
      key={t.key}
      className="h-full"
      style={{ display: activeTab === t.key ? 'block' : 'none' }}
    >
      <t.component
        projectId={id}
        projectName={project.name}
        project={project}
        onProjectUpdated={setProject}
        onNewSession={handleNewSession}
      />
    </div>
  ))}
</div>
```

Also remove line 63: `const ActiveComponent = tabs.find((t) => t.key === activeTab)?.component;`

Note: This eagerly mounts all 4 tab components (Overview, Tasks, Knowledge, Sessions). Each may fetch its own data on mount. This is acceptable because the project detail page is the primary workspace and users typically visit all tabs.

- [ ] **Step 2: Run `npm run check` and commit**

```bash
npm run check
git add packages/web/src/app/projects/\[id\]/page.tsx
git commit -m "fix: preserve chat draft text when switching project hub tabs"
```

**Rerun tests:** `manual-tests/04-projects-and-chat.md` (HUB-12)

---

### Task 7: Fix Gmail email watcher NDJSON parsing (MEDIUM)

**Files:**
- Modify: `suites/google-workspace/services/email-watcher.ts:30-47`

The `gws gmail +watch` CLI outputs single-line NDJSON for normal events but writes multi-line pretty-printed JSON error objects to stdout when it encounters errors (e.g., `invalid_grant`). The current parser splits on `\n` and tries to parse each line individually, causing a cascade of `"Failed to parse NDJSON line"` warnings for each line of the error object.

Two issues:
1. **Code fix**: The NDJSON parser should handle multi-line JSON by accumulating lines that fail to parse and retrying as they accumulate.
2. **Auth fix**: The `invalid_grant` error means the Gmail OAuth refresh token has expired. The user needs to re-authenticate with `gws auth login`. This is not a code fix — just note it.

- [ ] **Step 1: Add multi-line JSON buffering to stdout handler**

Replace the stdout handler (lines 30-47):

```typescript
let buffer = '';
let jsonAccumulator = '';

child.stdout?.on('data', (chunk: Buffer) => {
  buffer += chunk.toString();
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Try parsing the line as standalone JSON first
    try {
      const msg = JSON.parse(trimmed) as Record<string, unknown>;
      jsonAccumulator = '';
      emitEmailEvent(msg);
      continue;
    } catch {
      // Not valid JSON on its own — could be part of multi-line JSON
    }

    // Accumulate lines that might form a multi-line JSON object
    jsonAccumulator += trimmed;
    try {
      const msg = JSON.parse(jsonAccumulator) as Record<string, unknown>;
      // Successfully parsed accumulated lines as JSON — log as error (these are error responses)
      logger.warn(`gws gmail +watch error response: ${JSON.stringify(msg).slice(0, 200)}`);
      jsonAccumulator = '';
    } catch {
      // Still incomplete — keep accumulating
    }
  }
});
```

This approach:
- Tries each line as standalone NDJSON first (normal path)
- If parsing fails, accumulates the line with previous failures
- Retries parsing the accumulated buffer after each new line
- When the multi-line JSON object is complete, logs it as a single warning
- No more "Failed to parse NDJSON line" spam for each line of an error object

- [ ] **Step 2: Run `npm run check`**

```bash
npm run check
```

- [ ] **Step 3: Run existing tests**

```bash
npm test -- --filter google-workspace
```

- [ ] **Step 4: Commit**

```bash
git add suites/google-workspace/services/email-watcher.ts
git commit -m "fix: email watcher handles multi-line JSON error output from gws CLI"
```

- [ ] **Step 5: Note for user — Gmail re-auth needed**

The `invalid_grant` error means the Gmail OAuth refresh token has expired. Run:
```bash
gws auth login
```
This is a manual step, not a code fix.

**Rerun tests:** `manual-tests/11-email-auto-triage.md` (when Gmail is re-authenticated)

---

### Task 8: Update outdated test specs

**Files:**
- Modify: `manual-tests/01-smoke-test.md`
- Modify: `manual-tests/02-navigation-and-layout.md`
- Modify: `manual-tests/03-dashboard.md`
- Modify: `manual-tests/04-projects-and-chat.md`
- Rewrite: `manual-tests/16-kanban-task-board.md`

The executing agent should read the current version of each file, then make the changes described below. For test rewrites, read the current UI via snapshot to write accurate assertions.

- [ ] **Step 1: Update SM-01 in `manual-tests/01-smoke-test.md`**

Replace the assertion `text "Quick Actions"` with `link "Actions Today"` (the Life Dashboard summary card that replaced Quick Actions).

- [ ] **Step 2: Update NAV-01 in `manual-tests/02-navigation-and-layout.md`**

Update the sidebar link list to include all 13 navigation links:
Dashboard, Projects, Activity, Pipelines, Tasks, Metrics, Schedules, Agents, Skills, Knowledge, Config, Logs, Settings

- [ ] **Step 3: Update DASH-07/08 in `manual-tests/03-dashboard.md`**

Replace DASH-07 assertions with:
```markdown
### DASH-07: Life Dashboard summary cards

**Steps:**
1. navigate: `http://localhost:4000`
2. snapshot → assert:
   - link "Actions Today" with count
   - link "Active Pipelines" with count
   - link "Pending Approvals" with count
   - link "System Health" with status
```

Replace DASH-08 assertions with:
```markdown
### DASH-08: Summary card navigation

**Steps:**
1. click: link "Actions Today" → assert URL is `/activity`
2. go-back
3. click: link "Active Pipelines" → assert URL is `/pipelines`
```

- [ ] **Step 4: Update PROJ-10 in `manual-tests/04-projects-and-chat.md`**

Replace PROJ-10 assertions:
```markdown
### PROJ-10: Project card navigation

**Steps:**
1. click: first project card link
2. snapshot → assert:
   - heading with project name
   - button "Overview" or tab "Overview" is active
   - button "Tasks"
   - button "Knowledge"
   - button "Sessions"
   - button "New Chat"
   - NOT textbox "Ask Raven..." (chat input is on Sessions tab, not Overview)
```

- [ ] **Step 5: Rewrite `manual-tests/16-kanban-task-board.md`**

Replace the entire file with tests matching the current two-tab layout. The executing agent should navigate to `/tasks`, take a snapshot, and write test cases covering:

**Tab 1 — Tasks (Board view):**
- heading "Tasks"
- List/Board view toggle buttons
- Board view: 3 columns (To Do, In Progress, Completed) with count badges
- Filters: search textbox, status dropdown, source dropdown
- Empty column state: "No tasks"

**Tab 2 — Agent Monitor:**
- Tab button "Agent Monitor"
- Empty state: "No agents currently active"
- "Show Recent Executions" button with count
- Recent executions list: skill name, status badge, duration

- [ ] **Step 6: Commit**

```bash
git add manual-tests/01-smoke-test.md manual-tests/02-navigation-and-layout.md manual-tests/03-dashboard.md manual-tests/04-projects-and-chat.md manual-tests/16-kanban-task-board.md
git commit -m "docs: update outdated test specs to match current UI (nav, dashboard, projects, tasks)"
```

**Rerun tests:** All updated specs (01, 02, 03, 04, 16)
