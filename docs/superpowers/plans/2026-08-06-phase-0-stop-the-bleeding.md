# Phase 0 — Stop the Bleeding Implementation Plan

> **Historical plan — reconciled September 5, 2026.** The original instructions
> and checkboxes below are retained as history, not the current execution queue.
> See the [canonical reliability completion record](../../../_bmad-output/implementation-artifacts/reliability-completion-2026-09-05.md)
> for verified outcomes and remaining work. Reconciliation does not mean every
> implementation detail proposed here was adopted; do not recreate retired systems.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Raven's core loops actually close (task completion, Raven MCP), delete the dead strata (pipeline engine, legacy templates, v1 skill remnants), and make trunk verifiably green with CI — without adding any new subsystem.

**Architecture:** Pure subtraction plus two wires. The Raven MCP gets its deps at boot; a new `execution-bridge` module makes the *runtime* (not the model) observe agent completion and advance task trees, and honors the template's `agent` field. Everything else in this plan deletes code or fixes drift. Owner priorities: cost-effective, visible/stoppable, suites are on death row (Phase 2), extension via skills.

**Tech Stack:** TypeScript ESM monorepo, Vitest 4, ESLint 9 flat config, `@anthropic-ai/claude-agent-sdk` ^0.2.71, better-sqlite3, Fastify.

## Global Constraints

- `npm run check` and `npm test` must pass at the end of every task (they are red today; Tasks 1–4 make them green — until Task 4 completes, assert "no NEW failures").
- No new stratum: no new engines, no new definition directories.
- `config/skills.json` is LIVE (read by `loadSuitesConfig`, `packages/core/src/config.ts:94`) — do NOT delete it in Phase 0. Suites die in Phase 2, not now.
- `docker-compose.yml` at repo root is real infrastructure — never touch when deleting root YAML snapshot dumps.
- Imports use `.ts` extensions; `node:` prefix for builtins; no `console` (use `createLogger`).
- Commit after every task with a descriptive message; push after the final task.

## Verified facts this plan relies on

- `ravenMcpDeps` appears only in `agent-manager.ts` (accepts it) and `agent-session.ts` (uses it); `index.ts:343-354` never passes it. `RavenMcpDeps` (`packages/core/src/mcp-server/types.ts`) needs `eventBus` (required) + 10 optional deps, all already constructed in `index.ts`.
- `TaskExecutionEngine.onTaskCompleted(opts: {treeId, taskId, summary, artifacts})` at `task-execution-engine.ts:294`; `onTaskBlocked(treeId, taskId, reason)` at `:316`; public `getTree(treeId)` at `:362`.
- The inline run-agent bridge (`index.ts:247-277`) drops `payload.agent`, hardcodes `skillName: 'orchestrator'`, `mcpServers: {}`.
- `namedAgentStore` exposes `getAgent(id)`, `getAgentByName(name)`, `getDefaultAgent()`. `AgentTaskRequestEvent.payload` supports `namedAgentId`, `agentDefinitions`, `plugins`, `treeId`, `executionTaskId` (`packages/shared/src/types/events.ts:42-66`).
- Lint: 37 errors / 2 warnings. ~22 in `mcp-server/tools/*` (`no-explicit-any`), 2 in `TaskTreeView.tsx` (deleted by Task 2), rest in `project-validator.ts`, `create-validation-deps.ts`, `board-model.test.ts`, `skills/page.tsx`, `ProjectTree.tsx`.
- Tests: 6 drifted failures (4 × `config-history.test.ts`, 1 × `template-integration.test.ts`, 1 × `template-scheduler.test.ts`) + 6 knowledge test files failing at suite level for want of Neo4j (`knowledge-api`, `knowledge-chunking`, `knowledge-clustering`, `knowledge-embeddings`, `knowledge-retrieval`, `knowledge-store`).
- Cancel endpoints already exist: `POST /api/agent-tasks/:id/cancel` (`api/routes/agent-tasks.ts:83`), `POST /api/task-trees/:id/cancel` (`api/routes/task-trees.ts:80`).
- Tracked root snapshot dumps: `activity.yml agents.yml fresh.yml schedules.yml settings.yml skills.yml templates.yml`; untracked: `dash-back.yml dash-nav.yml schedules-active.yml`.
- `scripts/test-skill.ts` imports from deleted `packages/skills/skill-*` — dead. `RavenSkill` has zero importers outside its own file.
- Sidebar pipelines link: `packages/web/src/components/layout/Sidebar.tsx:12`. Pipeline API refs: `api/routes/pipelines.ts`, `dashboard.ts`, `metrics.ts`, `server.ts`. MCP dep: `mcp-server/types.ts:21`, `tools/system.ts:131-135`.

---

### Task 1: Delete the pipeline engine stratum

**Files:**
- Delete: `packages/core/src/pipeline-engine/` (entire dir), `config/pipelines/` (entire dir), `packages/core/src/api/routes/pipelines.ts`, `packages/web/src/app/pipelines/` (entire dir), all `packages/core/src/__tests__/pipeline-*.test.ts`
- Modify: `packages/core/src/index.ts` (imports :30-33, wiring :364-395, server deps :556-558, shutdown :596-598), `packages/core/src/api/server.ts` (deps + route registration), `packages/core/src/api/routes/dashboard.ts`, `packages/core/src/api/routes/metrics.ts`, `packages/core/src/mcp-server/types.ts` (drop `pipelineEngine` field + import), `packages/core/src/mcp-server/tools/system.ts` (drop the `trigger_pipeline` tool, :131-135 region), `packages/web/src/components/layout/Sidebar.tsx:12` (drop Pipelines nav item)

**Interfaces:**
- Produces: `RavenMcpDeps` without `pipelineEngine` (Task 3 constructs this type in index.ts).

- [ ] **Step 1: Enumerate every reference before deleting**

Run: `grep -rln "pipeline" packages/core/src packages/web/src packages/shared/src config --include='*.ts*' | grep -v node_modules | grep -v dist`
Also: `grep -rn "pipeline" packages/shared/src/types/events.ts` (pipeline event types and the `pipelineName` payload field — remove event interfaces that exist solely for pipelines; keep `AgentTaskRequestEvent` minus its `pipelineName` field, then grep for `pipelineName` consumers and remove those code paths).
Expected: the file list above plus possibly `permission-engine`/`audit` references via `pipelineName` — remove each.

- [ ] **Step 2: Delete directories and files**

```bash
git rm -r packages/core/src/pipeline-engine config/pipelines packages/core/src/api/routes/pipelines.ts packages/web/src/app/pipelines
git rm packages/core/src/__tests__/pipeline-*.test.ts
```

- [ ] **Step 3: Remove wiring from index.ts, server.ts, dashboard.ts, metrics.ts, Sidebar.tsx, mcp-server**

In `index.ts`: delete imports (lines 30–33), sections 12b/12c (lines 364–395), `pipelineEngine`/`pipelineStore`/`pipelineScheduler` from server deps, and the three `pipeline*` shutdown calls. In `server.ts`: remove the deps fields and the `registerPipelineRoutes` (or equivalent) call. In `dashboard.ts`/`metrics.ts`: remove pipeline stats blocks. In `mcp-server/types.ts`: remove the `PipelineEngine` import and `pipelineEngine?` field. In `tools/system.ts`: remove the pipeline trigger tool entirely (also removes one `no-explicit-any` error). In `Sidebar.tsx`: remove line 12.

- [ ] **Step 4: Build and check for stragglers**

Run: `npm run build && grep -rn "pipeline" packages/core/src packages/web/src --include='*.ts*' | grep -vi "pipeline-agnostic" | grep -v dist`
Expected: build passes; remaining hits only in `validation-pipeline.ts` (task-execution's validation pipeline — a different concept, KEEP) and comments referencing it.

- [ ] **Step 5: Test (no new failures) and commit**

Run: `npm test 2>&1 | tail -5` — expected: same 6 drifted failures + 6 Neo4j files, nothing new.
```bash
git add -A && git commit -m "feat(core)!: delete pipeline engine stratum (22 failed / 0 completed runs ever; nodes referenced pre-rename suites)"
```

---

### Task 2: Delete the remaining dead strata

**Files:**
- Delete: `packages/core/src/task-manager/template-loader.ts`, `config/task-templates/` (dir), `packages/core/src/orchestrator/task-queue.ts`, `packages/web/src/components/task-trees/` (dir, contains only unreachable `TaskTreeView.tsx`), `scripts/test-skill.ts`, `scripts/skill-tests/` (dir), `scripts/test-suite.ts` (only if it imports deleted paths — verify first), `packages/shared/src/types/skills.ts` (`RavenSkill` — zero importers), root snapshot dumps: `activity.yml agents.yml fresh.yml schedules.yml settings.yml skills.yml templates.yml` (git rm) + `dash-back.yml dash-nav.yml schedules-active.yml` (rm, untracked)
- Modify: `packages/core/src/index.ts` (drop `createTemplateLoader` import + :214-215 + server dep `templateLoader`), `packages/core/src/api/server.ts` + `packages/core/src/api/routes/tasks.ts` (remove templateLoader-backed endpoints), `packages/shared/src/index.ts` (drop `types/skills.ts` re-export if present), `package.json` (drop `test:skill`, and `test:suite` if deleted), delete associated tests (`grep -rl "template-loader\|task-queue\|test-skill" packages/*/src/__tests__`)

**Interfaces:**
- Produces: `server.ts` deps without `templateLoader`; `@raven/shared` without `RavenSkill`.

- [ ] **Step 1: Verify each deletion target is genuinely dead**

```bash
grep -rn "createTemplateLoader\|template-loader" packages/core/src --include='*.ts' | grep -v __tests__
grep -rln "task-queue\|TaskTreeView\|RavenSkill" packages --include='*.ts*' | grep -v dist
head -20 scripts/test-suite.ts   # delete only if it imports packages/skills or other deleted paths
grep -rn "getTaskTemplates\|templateLoader" packages/core/src/api/routes/tasks.ts
grep -rn "skills.ts" packages/shared/src/index.ts
```
Expected: template-loader used only by index.ts + routes/tasks.ts; task-queue/TaskTreeView/RavenSkill self-referential only.

- [ ] **Step 2: Delete + unwire (same mechanics as Task 1)** — `git rm` the files/dirs, remove the index.ts/server.ts/tasks.ts references, remove package.json script entries, `rm` untracked dumps.

- [ ] **Step 3: Build, lint delta, test, commit**

Run: `npm run build && npm run lint 2>&1 | tail -3` — expected: error count drops by 2 (TaskTreeView's two guardrail errors gone). `npm test 2>&1 | tail -5` — no new failures.
```bash
git add -A && git commit -m "feat!: delete dead strata — legacy template loader, task-queue, TaskTreeView, v1 skill test scripts, RavenSkill type, root snapshot dumps"
```

---

### Task 3: Wire the Raven MCP and make the runtime own task completion

**Files:**
- Create: `packages/core/src/task-execution/execution-bridge.ts`
- Test: `packages/core/src/__tests__/execution-bridge.test.ts`
- Modify: `packages/core/src/index.ts` (pass `ravenMcpDeps` to AgentManager; replace inline bridge :247-277 with the module), `packages/core/src/mcp-server/tools/*.ts` (fix all `no-explicit-any` — the deps are fully typed in `types.ts`; type the tool arg schemas with zod inferences instead of `any`), `packages/core/src/agent-manager/agent-manager.ts` (enqueue currently drops `taskBoardContext` — add it to the copied fields), `packages/core/src/orchestrator/orchestrator.ts:346-354` (reconcile the MCP-instructions block with the actual tool names the wired MCP exposes — verify with `grep -h "name: '" packages/core/src/mcp-server/tools/*.ts`; rename or delete lines that reference tools that don't exist)

**Interfaces:**
- Consumes: `RavenMcpDeps` (Task 1's shape, no pipelineEngine), `TaskExecutionEngine.getTree/onTaskCompleted/onTaskBlocked`, `namedAgentStore.getAgentByName/getAgent/getDefaultAgent`, `agentResolver.resolveAgentCapabilities`.
- Produces: `createExecutionBridge(deps: { eventBus: EventBus; executionEngine: TaskExecutionEngine; namedAgentStore: NamedAgentStore; agentResolver: ReturnType<typeof createAgentResolver> }): { start(): void; stop(): void }`.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/core/src/__tests__/execution-bridge.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus } from '../event-bus/event-bus.ts';
import { createExecutionBridge } from '../task-execution/execution-bridge.ts';

function makeDeps() {
  const eventBus = new EventBus();
  const executionEngine = {
    getTree: vi.fn(),
    onTaskCompleted: vi.fn().mockResolvedValue(undefined),
    onTaskBlocked: vi.fn(),
  };
  const gmailAgent = { id: 'agent-gmail', name: 'gmail', instructions: '' };
  const defaultAgent = { id: 'agent-raven', name: 'raven', instructions: '' };
  const namedAgentStore = {
    getAgentByName: vi.fn((n: string) => (n === 'gmail' ? gmailAgent : undefined)),
    getAgent: vi.fn(() => undefined),
    getDefaultAgent: vi.fn(() => defaultAgent),
  };
  const agentResolver = {
    resolveAgentCapabilities: vi.fn(() => ({
      mcpServers: { gmail: { command: 'x' } },
      agentDefinitions: { 'gmail-reader': { description: 'd', prompt: 'p' } },
      plugins: [],
    })),
  };
  return { eventBus, executionEngine, namedAgentStore, agentResolver };
}

function runAgentEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'e1', timestamp: Date.now(), source: 'test', type: 'execution:task:run-agent' as const,
    payload: { treeId: 't1', taskId: 'task-1', agent: 'gmail', prompt: 'do it', parentTaskId: 'root', ...overrides },
  };
}

describe('createExecutionBridge', () => {
  let deps: ReturnType<typeof makeDeps>;
  beforeEach(() => { deps = makeDeps(); createExecutionBridge(deps as never).start(); });

  it('honors the template agent field and resolves its capabilities', () => {
    const requests: unknown[] = [];
    deps.eventBus.on('agent:task:request', (e) => requests.push(e));
    deps.eventBus.emit(runAgentEvent() as never);
    expect(deps.namedAgentStore.getAgentByName).toHaveBeenCalledWith('gmail');
    const req = requests[0] as { payload: Record<string, unknown> };
    expect(req.payload.namedAgentId).toBe('agent-gmail');
    expect(req.payload.mcpServers).toHaveProperty('gmail');
    expect(req.payload.executionTaskId).toBe('task-1');
  });

  it('falls back to the default agent when no agent is named', () => {
    const requests: unknown[] = [];
    deps.eventBus.on('agent:task:request', (e) => requests.push(e));
    deps.eventBus.emit(runAgentEvent({ agent: undefined }) as never);
    const req = requests[0] as { payload: Record<string, unknown> };
    expect(req.payload.namedAgentId).toBe('agent-raven');
  });

  it('advances the tree when a tracked agent task completes', () => {
    deps.executionEngine.getTree.mockReturnValue({
      tasks: new Map([['task-1', { status: 'running' }]]),
    });
    deps.eventBus.emit(runAgentEvent() as never);
    deps.eventBus.emit({
      id: 'e2', timestamp: Date.now(), source: 'agent-manager', type: 'agent:task:complete',
      payload: { taskId: 'task-1', result: 'summary text', durationMs: 5, success: true },
    } as never);
    expect(deps.executionEngine.onTaskCompleted).toHaveBeenCalledWith({
      treeId: 't1', taskId: 'task-1', summary: 'summary text', artifacts: [],
    });
  });

  it('blocks the tree task on failure', () => {
    deps.executionEngine.getTree.mockReturnValue({
      tasks: new Map([['task-1', { status: 'running' }]]),
    });
    deps.eventBus.emit(runAgentEvent() as never);
    deps.eventBus.emit({
      id: 'e3', timestamp: Date.now(), source: 'agent-manager', type: 'agent:task:complete',
      payload: { taskId: 'task-1', result: '', durationMs: 5, success: false, errors: ['boom'] },
    } as never);
    expect(deps.executionEngine.onTaskBlocked).toHaveBeenCalledWith('t1', 'task-1', 'boom');
  });

  it('ignores completions for untracked tasks and non-running tree tasks', () => {
    deps.executionEngine.getTree.mockReturnValue({
      tasks: new Map([['task-1', { status: 'completed' }]]),
    });
    deps.eventBus.emit({
      id: 'e4', timestamp: Date.now(), source: 'agent-manager', type: 'agent:task:complete',
      payload: { taskId: 'untracked', result: 'x', durationMs: 1, success: true },
    } as never);
    deps.eventBus.emit(runAgentEvent() as never);
    deps.eventBus.emit({
      id: 'e5', timestamp: Date.now(), source: 'agent-manager', type: 'agent:task:complete',
      payload: { taskId: 'task-1', result: 'x', durationMs: 1, success: true },
    } as never);
    expect(deps.executionEngine.onTaskCompleted).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests, verify they fail** — `npm test -- execution-bridge` → FAIL (module not found).

- [ ] **Step 3: Implement the bridge**

```typescript
// packages/core/src/task-execution/execution-bridge.ts
import { createLogger, generateId } from '@raven/shared';
import type { RavenEvent } from '@raven/shared';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { TaskExecutionEngine } from './task-execution-engine.ts';
import type { NamedAgentStore } from '../agent-registry/yaml-named-agent-store.ts';
import type { createAgentResolver } from '../agent-registry/agent-resolver.ts';
import { buildRetryPrompt } from './validation-pipeline.ts';
import { buildTaskBoardInstructions } from './task-board-protocol.ts';

const log = createLogger('execution-bridge');

interface RunAgentPayload {
  treeId: string;
  taskId: string;
  agent?: string;
  prompt: string;
  parentTaskId: string;
  retryFeedback?: string;
  retryCount?: number;
  projectId?: string;
}

interface CompletePayload {
  taskId: string;
  result: string;
  success: boolean;
  errors?: string[];
}

export interface ExecutionBridgeDeps {
  eventBus: EventBus;
  executionEngine: TaskExecutionEngine;
  namedAgentStore: NamedAgentStore;
  agentResolver: ReturnType<typeof createAgentResolver>;
}

export function createExecutionBridge(deps: ExecutionBridgeDeps): { start(): void; stop(): void } {
  // agent-task id -> tree coordinates; in-memory is acceptable: an orphaned
  // entry only means the tree waits for the next manual retry
  const pending = new Map<string, { treeId: string; taskId: string }>();

  const onRunAgent = (event: unknown): void => {
    const payload = (event as RavenEvent & { payload: RunAgentPayload }).payload;
    const named = payload.agent
      ? (deps.namedAgentStore.getAgentByName(payload.agent) ?? deps.namedAgentStore.getAgent(payload.agent))
      : undefined;
    if (payload.agent && !named) {
      log.warn(`Template names unknown agent '${payload.agent}', using default agent`);
    }
    const agent = named ?? deps.namedAgentStore.getDefaultAgent();
    const capabilities = deps.agentResolver.resolveAgentCapabilities(agent);
    pending.set(payload.taskId, { treeId: payload.treeId, taskId: payload.taskId });
    deps.eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'execution-bridge',
      type: 'agent:task:request',
      payload: {
        taskId: payload.taskId,
        prompt: payload.retryFeedback
          ? buildRetryPrompt(payload.prompt, payload.retryFeedback, payload.retryCount ?? 1)
          : payload.prompt,
        skillName: agent.name,
        mcpServers: capabilities.mcpServers,
        agentDefinitions: capabilities.agentDefinitions,
        plugins: capabilities.plugins,
        namedAgentId: agent.id,
        priority: 'normal',
        projectId: payload.projectId,
        treeId: payload.treeId,
        executionTaskId: payload.taskId,
        taskBoardContext: buildTaskBoardInstructions(payload.parentTaskId, payload.retryFeedback),
      },
    } as RavenEvent);
  };

  const onComplete = (event: unknown): void => {
    const payload = (event as RavenEvent & { payload: CompletePayload }).payload;
    const entry = pending.get(payload.taskId);
    if (!entry) return;
    pending.delete(payload.taskId);
    const tree = deps.executionEngine.getTree(entry.treeId);
    const task = tree?.tasks.get(entry.taskId);
    // the model may already have completed it via the raven MCP complete_task tool
    if (!task || task.status !== 'running') return;
    if (payload.success) {
      deps.executionEngine
        .onTaskCompleted({ treeId: entry.treeId, taskId: entry.taskId, summary: payload.result, artifacts: [] })
        .catch((err: unknown) => log.error(`onTaskCompleted failed for ${entry.taskId}: ${err}`));
    } else {
      deps.executionEngine.onTaskBlocked(entry.treeId, entry.taskId, payload.errors?.join('; ') ?? 'agent task failed');
    }
  };

  return {
    start(): void {
      deps.eventBus.on('execution:task:run-agent', onRunAgent);
      deps.eventBus.on('agent:task:complete', onComplete);
    },
    stop(): void {
      deps.eventBus.off('execution:task:run-agent', onRunAgent);
      deps.eventBus.off('agent:task:complete', onComplete);
    },
  };
}
```
Adjust `on`/`off`/`emit` casts to the EventBus generics as the compiler demands; verify `NamedAgentStore` is the exported interface name in `yaml-named-agent-store.ts` (line 18 region) before importing.

- [ ] **Step 4: Wire index.ts**

Replace the inline bridge (old :247-277) with:
```typescript
const executionBridge = createExecutionBridge({
  eventBus,
  executionEngine,
  namedAgentStore,
  agentResolver,
});
executionBridge.start();
```
NOTE: `namedAgentStore`/`agentResolver` are created at :222-228, AFTER the engine at :239 — keep creation order, move bridge start below both. Add to `AgentManager` construction:
```typescript
ravenMcpDeps: {
  executionEngine,
  messageStore,
  sessionManager,
  knowledgeStore,
  retrievalEngine,
  namedAgentStore,
  projectRegistry,
  eventBus,
  db: dbInterface,
  pendingApprovals,
},
```
`knowledgeStore`/`retrievalEngine` are created at :408/:449, after AgentManager at :343 — move the AgentManager construction below step 12j, or pass a mutable deps object populated before first use (AgentManager only reads it per-task). Prefer moving construction; verify nothing between :343 and :455 uses `agentManager` except `baseContext.config` injection and the global (move those too). Add `executionBridge.stop()` to shutdown.

- [ ] **Step 5: Fix the ~20 `no-explicit-any` errors in `mcp-server/tools/*`** — the deps are typed; replace `any` casts with the real types from `types.ts` / zod schema inference. Add `taskBoardContext` to the fields `agent-manager.ts` `enqueue()` copies (verify with grep it's currently dropped).

- [ ] **Step 6: Reconcile the orchestrator's MCP instructions block** — run `grep -h "name: '" packages/core/src/mcp-server/tools/*.ts` (and check `tool('...` first args); rewrite `orchestrator.ts:346-354` to reference only tools that exist (e.g. if there is no `classify_request`, drop that line; `send_message` and `create_task_tree` names must match exactly).

- [ ] **Step 7: Run tests, verify green, run check delta, commit**

Run: `npm test -- execution-bridge` → PASS; `npm test 2>&1 | tail -5` → no new failures; `npm run lint 2>&1 | tail -3` → mcp-server errors gone.
```bash
git add -A && git commit -m "feat(core): wire raven MCP deps + runtime-owned task completion bridge; templates' agent field honored"
```

---

### Task 4: Green trunk

**Files:**
- Modify: `packages/core/src/project-registry/project-validator.ts:143` (split `validateAgentsDir` — extract per-agent validation helper to satisfy max-params/complexity), `packages/core/src/task-execution/create-validation-deps.ts` (extract named constant for `5`, split function), `packages/web/src/__tests__/board-model.test.ts:2` (drop unused `BoardCard` import), `packages/web/src/app/skills/page.tsx` (guard instead of `!`, extract `SkillCard` subcomponent), `packages/web/src/components/project/ProjectTree.tsx` (guards, constants, extract `TreeItem` body), `packages/core/src/__tests__/config-history.test.ts` (4 drifted assertions — inspect actual vs expected, update to current output shape), `packages/core/src/__tests__/template-scheduler.test.ts:144` (task ids are now prefixed `${treeId}-task-1` and payload gained `plan`/`blockedBy` — assert with `expect.objectContaining` on the new shape), `packages/core/src/__tests__/template-integration.test.ts` (inspect: likely templates referencing agents `gmail`/`ticktick`/`digest` that don't exist as named agents — fix the DATA: either create thin agent YAMLs under `projects/agents/` with explicit skill lists, or point templates at existing agents; do NOT weaken the validator), `vitest.config.ts` (root — move the 6 Neo4j-dependent knowledge test files into a separate opt-in project `knowledge-neo4j` excluded from the default run; add `test:knowledge` script)

**Interfaces:**
- Produces: `npm run check` exit 0, `npm test` exit 0 with no Neo4j running.

- [ ] **Step 1: Fix lint errors file-by-file**, re-running `npm run lint 2>&1 | tail -3` after each file. No `eslint-disable` additions — the guardrails are the owner's own rules.
- [ ] **Step 2: Fix the 6 drifted test assertions** — read each failure diff first (`npm test -- config-history 2>&1 | head -80`), decide drift-vs-bug per test. Template-integration is a real data bug: fix the data, keep the test.
- [ ] **Step 3: Split Neo4j tests into opt-in project** — root `vitest.config.ts` uses `test.projects`; add a `knowledge-neo4j` project matching the 6 files and exclude them from the default core project glob. Add `"test:knowledge": "vitest run --project knowledge-neo4j"` to package.json.
- [ ] **Step 4: Full verification** — `npm run check; echo $?` → 0. `npm test; echo $?` → 0 (assert on exit codes, never on piped tails).
- [ ] **Step 5: Commit** — `git add -A && git commit -m "fix: green trunk — lint guardrail fixes, drifted test repairs, Neo4j knowledge tests opt-in"`

---

### Task 5: CI

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the workflow**

```yaml
name: CI
on:
  push:
    branches: [master]
  pull_request:
jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npm run check
      - run: npm test
      - run: npm run validate:library
      - run: npm run validate:projects
```
Verify `validate:library`/`validate:projects` pass locally first; if either depends on runtime state (data/, credentials), scope it down or drop it from CI with a comment.

- [ ] **Step 2: Commit, push, verify the run** — `git add .github && git commit -m "ci: verify build, check, tests, definition validation on every push"` then `git push` and `gh run watch` until green.

---

### Task 6: Docs truth pass + freeze rule

**Files:**
- Modify: `CLAUDE.md` (SDK package name `@anthropic-ai/claude-code` → `@anthropic-ai/claude-agent-sdk` at :42; delete the "Adding a New Skill" section teaching `packages/skills/skill-<name>` + `RavenSkill`; rewrite the "MCP Isolation" section to describe the capability library + named-agent reality; add freeze rule), `ARCHITECTURE.md` (same corrections: suites marked deprecated/Phase-2-removal, pipeline sections deleted, event table updated), `README.md` (if it repeats the v1 skill instructions)

- [ ] **Step 1: Rewrite the three docs** — every instruction must describe something that exists; the freeze rule text for CLAUDE.md:

```markdown
## Migration Freeze Rule (Phase 0, 2026-08-06)

No new subsystem, engine, or definition directory may land unless the same
PR deletes the predecessor it replaces. Extension happens through library
skills and projects/ definitions — never through new core strata.
See docs/assessments/2026-08-06-architecture-assessment.md for the roadmap.
```

- [ ] **Step 2: Commit** — `git commit -m "docs: truth pass — real SDK name, real extension model, deprecate suites, freeze rule"`

---

### Task 7: Visibility — see what runs, stop it

**Files:**
- Verify/Modify: the activity or tasks page (`packages/web/src/app/activity/` or board components) — confirm running agent tasks are visible with a working cancel affordance wired to the existing `POST /api/agent-tasks/:id/cancel`; task-tree cancel to `POST /api/task-trees/:id/cancel`. Check `packages/web/src/lib/api-client.ts` for existing cancel helpers.

- [ ] **Step 1: Audit what the UI already shows** — grep the web app for `cancel` usages; load the board/activity components and trace whether running tasks render with a stop control.
- [ ] **Step 2: If missing, add the smallest possible stop control** — a cancel button on running task cards calling the existing endpoint, with pointer cursor + hover state per the owner's UI feedback memory. No new pages, no new state stores.
- [ ] **Step 3: Verify in browser** (browser-testing skill / playwright-cli): start core + web, create a long-running dummy agent task, see it, cancel it, watch status flip to `cancelled`. Commit: `git commit -m "feat(web): stop control for running agent tasks"` and push everything.

---

## Self-review notes

- `config/skills.json` deliberately excluded from deletions (live suite config) — deviation from the assessment report's Phase 0 list, verified against `config.ts:94-107`.
- `scripts/test-suite.ts` deletion is conditional on verified dead imports — suites still run services until Phase 2.
- Task 3's index.ts reordering (AgentManager after knowledge engine) must preserve boot behavior: only `baseContext.config` injection and the `__raven_agent_manager__` global depend on `agentManager` before the API server — both move with it.
- Type names to verify at execution time (plan uses best-known names): `NamedAgentStore` export, EventBus `on/off` signatures, exact zod arg types in mcp tools.
