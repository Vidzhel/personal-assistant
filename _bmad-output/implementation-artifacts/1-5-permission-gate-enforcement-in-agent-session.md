# Story 1.5: Permission Gate Enforcement in Agent Session

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the system operator,
I want permission tiers enforced as code-level middleware before any sub-agent executes,
so that trust boundaries cannot be bypassed regardless of prompt content.

## Acceptance Criteria

1. **AC1: Green-Tier Execution** — Given a Green-tier action is requested, when the agent session processes it, then the sub-agent executes without notification and an audit entry records `outcome: executed`

2. **AC2: Yellow-Tier Execution with Notification** — Given a Yellow-tier action is requested, when the agent session processes it, then the sub-agent executes, an audit entry records `outcome: executed`, and a `permission:approved` event is emitted for downstream notification

3. **AC3: Red-Tier Blocking** — Given a Red-tier action is requested, when the agent session processes it, then execution is blocked, an audit entry records `outcome: queued`, and the action is inserted into `pending_approvals`

4. **AC4: Code-Level Enforcement** — Given any permission check occurs, when the tier is evaluated, then it happens at the code level in agent-session.ts — not as a prompt instruction to the LLM

5. **AC5: Undeclared Action Safety** — Given an action that is not declared by any skill, when it is requested, then it defaults to Red tier and follows AC3 behavior

## Tasks / Subtasks

- [x] Task 1: Add permission event types to shared (AC: #2, #3)
  - [x] 1.1 Add `permission:approved` event type and payload to `packages/shared/src/types/events.ts`
  - [x] 1.2 Add `permission:blocked` event type and payload to `packages/shared/src/types/events.ts`
  - [x] 1.3 Add Zod schemas for both event payloads
  - [x] 1.4 Export new types from `packages/shared/src/types/index.ts`
  - [x] 1.5 Build shared: `npm run build -w packages/shared`

- [x] Task 2: Create pending approvals module (AC: #3)
  - [x] 2.1 Create `packages/core/src/permission-engine/pending-approvals.ts`
  - [x] 2.2 Implement factory function `createPendingApprovals(db)` returning `{ insert, query, resolve, initialize }`
  - [x] 2.3 `insert()` — INSERT a new pending approval with `id`, `action_name`, `skill_name`, `details`, `requested_at`, `session_id`, `pipeline_name`
  - [x] 2.4 `query()` — SELECT pending approvals where `resolution IS NULL`, ordered by `requested_at` ASC
  - [x] 2.5 `resolve()` — UPDATE `resolution` and `resolved_at` for a given approval ID (used by Story 1.6)
  - [x] 2.6 `initialize()` — verify `pending_approvals` table exists (already created by migration 002)

- [x] Task 3: Add permission gate to agent session (AC: #1, #2, #3, #4, #5)
  - [x] 3.1 Extend `RunOptions` interface in `agent-session.ts` with optional `permissionEngine`, `auditLog`, and `pendingApprovals` dependencies
  - [x] 3.2 Add `actionName` field to `RunOptions` — the `<skill-name>:<action-name>` to gate
  - [x] 3.3 Implement `enforcePermissionGate()` function that:
    - Resolves tier via `permissionEngine.resolveTier(actionName)`
    - For Green: writes audit entry with `outcome: 'executed'`, returns `{ allowed: true }`
    - For Yellow: writes audit entry with `outcome: 'executed'`, emits `permission:approved` event, returns `{ allowed: true }`
    - For Red: writes audit entry with `outcome: 'queued'`, inserts pending approval, emits `permission:blocked` event, returns `{ allowed: false, reason: 'queued-for-approval' }`
  - [x] 3.4 Call `enforcePermissionGate()` before `query()` in `runAgentTask()`
  - [x] 3.5 If gate returns `{ allowed: false }`, return early with a result indicating the task was blocked (do NOT call `query()`)
  - [x] 3.6 If permission deps are not provided (backward compat), skip gating entirely and execute as before

- [x] Task 4: Wire dependencies through agent manager (AC: #1, #2, #3)
  - [x] 4.1 Extend agent manager constructor to accept `permissionEngine`, `auditLog`, and `pendingApprovals`
  - [x] 4.2 Pass these deps to `runAgentTask()` via `RunOptions` when calling from `runTask()`
  - [x] 4.3 Extract `actionName` from `AgentTask.payload` and pass it in `RunOptions`

- [x] Task 5: Update boot sequence (AC: #1, #2, #3)
  - [x] 5.1 In `packages/core/src/index.ts`, instantiate `pendingApprovals` after audit log init
  - [x] 5.2 Pass `permissionEngine`, `auditLog`, `pendingApprovals` to agent manager constructor
  - [x] 5.3 Ensure the dependency chain: database -> permissionEngine -> auditLog -> pendingApprovals -> agentManager

- [x] Task 6: Tests (AC: #1, #2, #3, #4, #5)
  - [x] 6.1 Create `packages/core/src/__tests__/permission-gate.test.ts`
  - [x] 6.2 Test Green tier: action executes, audit entry written with `outcome: 'executed'`, no event emitted
  - [x] 6.3 Test Yellow tier: action executes, audit entry written with `outcome: 'executed'`, `permission:approved` event emitted
  - [x] 6.4 Test Red tier: action blocked, audit entry written with `outcome: 'queued'`, pending approval inserted, `permission:blocked` event emitted
  - [x] 6.5 Test undeclared action: defaults to Red tier, follows Red-tier behavior
  - [x] 6.6 Test backward compat: when permission deps not provided, agent executes normally (no gating)
  - [x] 6.7 Test pending approvals module: insert, query (unresolved only), resolve
  - [x] 6.8 Test permission gate with mock permission engine returning each tier

- [x] Task 7: Verify (AC: #1, #2, #3, #4, #5)
  - [x] 7.1 `npm run check` passes (format, lint, types)
  - [x] 7.2 `npm test` passes (all existing + new tests)
  - [x] 7.3 Build succeeds: `npm run build`

## Dev Notes

### Architecture Decision: Single Enforcement Point

The architecture document mandates that permission gate enforcement happens in `agent-session.ts` before `query()`. This is the single narrowest choke point — every sub-agent invocation passes through this gate. It is **impossible to bypass** regardless of orchestrator routing.

> "Permission gate enforcement: In `agent-session.ts` before `query()`. Single narrowest choke point."
> [Source: _bmad-output/planning-artifacts/architecture.md — Authentication & Security Decisions]

### Database Schema (Already Exists — Migration 002)

The `pending_approvals` table was created in Story 1.2 via `migrations/002-permission-tables.sql`:

```sql
CREATE TABLE IF NOT EXISTS pending_approvals (
  id TEXT PRIMARY KEY,
  action_name TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  details TEXT,
  requested_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT,          -- 'approved' | 'denied'
  session_id TEXT,
  pipeline_name TEXT
);
```

**Do NOT create a new migration.** The table already exists. The pending-approvals module's `initialize()` should simply verify it exists.

### Current Agent Session Code (`packages/core/src/agent-manager/agent-session.ts`)

The current `runAgentTask()` function has `permissionMode: 'bypassPermissions'` hardcoded (line 74). The permission gate logic must be inserted BEFORE the `query()` call. The `permissionMode` on the SDK query can remain `bypassPermissions` — our gating happens at a higher level (code-level, not SDK-level).

Key function signature:
```typescript
export async function runAgentTask(options: RunOptions): Promise<AgentSessionResult>
```

Current `RunOptions`:
```typescript
export interface RunOptions {
  task: AgentTask;
  eventBus: EventBus;
  mcpServers?: McpServerConfig[];
  agentDefinitions?: AgentDefinition[];
}
```

### Permission Engine Interface (Already Implemented)

```typescript
// packages/core/src/permission-engine/permission-engine.ts
interface PermissionEngine {
  initialize(configDir: string): void;
  resolveTier(actionName: string): PermissionTier;  // 'green' | 'yellow' | 'red'
  shutdown(): void;
  getConfig(): PermissionConfig;
}
```

`resolveTier()` resolution order:
1. Check `permissions.json` overrides
2. Check skill registry default tiers
3. Default to `'red'` if action undeclared

### Audit Log Interface (Already Implemented)

```typescript
// packages/core/src/permission-engine/audit-log.ts
interface AuditLog {
  insert(entry: Omit<AuditEntry, 'id' | 'timestamp'>): AuditEntry;
  query(filters?: AuditLogFilter): AuditEntry[];
  initialize(): void;
}
```

### Pending Approvals Module Design

Follow the same factory function pattern as `createAuditLog()` and `createPermissionEngine()`:

```typescript
// packages/core/src/permission-engine/pending-approvals.ts
import type { DatabaseInterface } from '../db/database.ts';

export interface PendingApproval {
  id: string;
  actionName: string;
  skillName: string;
  details?: string;
  requestedAt: string;
  resolvedAt?: string;
  resolution?: 'approved' | 'denied';
  sessionId?: string;
  pipelineName?: string;
}

export interface PendingApprovals {
  insert(entry: Omit<PendingApproval, 'id' | 'requestedAt' | 'resolvedAt' | 'resolution'>): PendingApproval;
  query(): PendingApproval[];  // Returns only unresolved (resolution IS NULL)
  resolve(id: string, resolution: 'approved' | 'denied'): PendingApproval;
  initialize(): void;
}

export function createPendingApprovals(db: DatabaseInterface): PendingApprovals {
  // Factory function — no classes
}
```

**Note:** The `resolve()` method will be called by Story 1.6 (Approval Queue). This story just creates the insert/query infrastructure and the `resolve()` signature.

### Permission Gate Function Design

```typescript
// Inside agent-session.ts
interface GateResult {
  allowed: boolean;
  tier: PermissionTier;
  reason?: string;
}

function enforcePermissionGate(
  actionName: string,
  deps: { permissionEngine: PermissionEngine; auditLog: AuditLog; pendingApprovals: PendingApprovals; eventBus: EventBus },
  context: { sessionId?: string; skillName: string; pipelineName?: string }
): GateResult {
  const tier = deps.permissionEngine.resolveTier(actionName);

  // Green: execute silently
  if (tier === 'green') {
    deps.auditLog.insert({ skillName: context.skillName, actionName, permissionTier: tier, outcome: 'executed', sessionId: context.sessionId });
    return { allowed: true, tier };
  }

  // Yellow: execute with notification
  if (tier === 'yellow') {
    deps.auditLog.insert({ skillName: context.skillName, actionName, permissionTier: tier, outcome: 'executed', sessionId: context.sessionId });
    deps.eventBus.emit({ type: 'permission:approved', payload: { actionName, skillName: context.skillName, tier } });
    return { allowed: true, tier };
  }

  // Red: block and queue
  deps.auditLog.insert({ skillName: context.skillName, actionName, permissionTier: tier, outcome: 'queued', sessionId: context.sessionId });
  deps.pendingApprovals.insert({ actionName, skillName: context.skillName, details: `Blocked: ${actionName}`, sessionId: context.sessionId });
  deps.eventBus.emit({ type: 'permission:blocked', payload: { actionName, skillName: context.skillName, tier } });
  return { allowed: false, tier, reason: 'queued-for-approval' };
}
```

### Action Name Extraction

The `actionName` must be provided in `RunOptions` when the agent manager calls `runAgentTask()`. The orchestrator/agent-manager determines which action is being performed from the `AgentTask.payload`. Format: `<skill-name>:<action-name>` (kebab-case, colon-separated).

**If `actionName` is not provided**, the gate should default to Red tier as a safety measure (per FR10: "System defaults all undeclared actions to Red tier").

### Event Types to Add

Add to `packages/shared/src/types/events.ts`:

```typescript
// Permission gate events
export interface PermissionApprovedEvent extends BaseEvent {
  type: 'permission:approved';
  payload: {
    actionName: string;
    skillName: string;
    tier: PermissionTier;
    sessionId?: string;
  };
}

export interface PermissionBlockedEvent extends BaseEvent {
  type: 'permission:blocked';
  payload: {
    actionName: string;
    skillName: string;
    tier: PermissionTier;
    approvalId: string;
    sessionId?: string;
  };
}
```

Add these to the `RavenEvent` union type and `RavenEventType` union.

### Naming Conventions

| Layer | Convention | Example |
|-------|-----------|---------|
| Database columns | snake_case | `action_name`, `requested_at`, `resolved_at` |
| TypeScript interfaces | camelCase | `actionName`, `requestedAt`, `resolvedAt` |
| Action names | kebab-case:kebab-case | `ticktick:create-task`, `gmail:send-email` |

### Backward Compatibility

Permission gate deps are **optional** in `RunOptions`. If not provided, `runAgentTask()` skips gating entirely and executes as before. This ensures:
- Existing tests continue to pass without modification
- Agent sessions without permission context (e.g., system-internal tasks) work normally
- Gradual rollout is possible

### Outcome Values Written by This Story

| Value | Scenario | When |
|-------|----------|------|
| `'executed'` | Green or Yellow tier action passes gate | Before `query()` call |
| `'queued'` | Red tier action blocked | Instead of `query()` call |

Stories 1.6 will handle `'approved'` and `'denied'` outcomes when resolving pending approvals.

### Boot Sequence Changes

In `packages/core/src/index.ts`, after existing audit log initialization (~line 101-103):

```typescript
const pendingApprovals = createPendingApprovals(getDb());
pendingApprovals.initialize();
log.info('Pending approvals initialized');
```

Then pass to agent manager:
```typescript
const agentManager = createAgentManager({
  eventBus,
  mcpManager,
  skillRegistry,
  permissionEngine,   // NEW
  auditLog,           // NEW
  pendingApprovals,   // NEW
});
```

### Testing Strategy

- **Framework:** Vitest (already configured)
- **Database:** Use `mkdtempSync` + `initDatabase(tempPath)` for test isolation, clean up in `afterEach`
- **Mock Claude SDK** (`@anthropic-ai/claude-code`) — never spawn real subprocesses
- **Mock permission engine** — return controlled tier values per test case
- **Real audit log + pending approvals** — use temp SQLite DB for real insert/query validation
- **Event bus** — use real `createEventBus()` with `vi.fn()` listeners to verify event emissions
- **Follow patterns from:** `packages/core/src/__tests__/permission-engine.test.ts` and `packages/core/src/__tests__/audit-log.test.ts`

### Previous Story Learnings (Story 1.4)

From the Story 1.4 implementation record:
- `createAuditLog()` uses DI pattern — accepts `db` parameter (was changed during code review from singleton access)
- `auditLog` is required (not optional) in `ApiDeps` — changed during code review
- `rowToEntry()` helper handles snake_case to camelCase mapping — follow same pattern for pending approvals
- All 133 tests passing after Story 1.4, 0 lint errors
- `z.coerce.number()` needed for query params from Fastify (strings)

### Git Intelligence (Recent Commits)

```
9e2bdcf fix: story 1-4 code review — DI, type consistency, test coverage
a847cab feat: story 1-4 — audit log writer and query API
563b9c7 feat: stories 1-2 and 1-3 — migration system, permission engine
```

Key patterns from recent commits:
- Factory function pattern with DI (not singletons)
- Code review fixed DI inconsistencies — ensure DI from the start
- Tests use temp SQLite DBs for isolation
- Separate concern per file

### Project Structure Notes

- Pending approvals module goes in `packages/core/src/permission-engine/` alongside `permission-engine.ts` and `audit-log.ts`
- Permission gate logic stays in `packages/core/src/agent-manager/agent-session.ts` (inline, not separate file)
- Tests go in `packages/core/src/__tests__/permission-gate.test.ts`
- Event types added to `packages/shared/src/types/events.ts`
- No new directories needed

### References

- [Source: _bmad-output/planning-artifacts/epics.md — Epic 1, Story 1.5]
- [Source: _bmad-output/planning-artifacts/architecture.md — Permission Gate Enforcement Decision]
- [Source: _bmad-output/planning-artifacts/architecture.md — Component Boundaries: permission-engine/ + agent-session.ts]
- [Source: _bmad-output/planning-artifacts/architecture.md — Data Flow: Pipeline Execution (permission gate check)]
- [Source: _bmad-output/planning-artifacts/prd.md — FR2: System enforces permission tiers at the agent spawner level]
- [Source: _bmad-output/planning-artifacts/prd.md — FR10: System defaults all undeclared actions to Red tier]
- [Source: _bmad-output/planning-artifacts/prd.md — NFR3: Permission gate enforcement is code-level middleware]
- [Source: packages/core/src/agent-manager/agent-session.ts — Current runAgentTask() implementation]
- [Source: packages/core/src/permission-engine/permission-engine.ts — resolveTier() interface]
- [Source: packages/core/src/permission-engine/audit-log.ts — insert() interface]
- [Source: packages/core/src/index.ts — Boot sequence dependency chain]
- [Source: migrations/002-permission-tables.sql — pending_approvals table DDL]
- [Source: _bmad-output/implementation-artifacts/1-4-audit-log-writer-and-query-api.md — Previous story learnings]

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6

### Debug Log References

None — clean implementation, no debugging issues.

### Completion Notes List

- Implemented `PermissionApprovedEvent` and `PermissionBlockedEvent` with Zod schemas in shared events
- Added `actionName` field to `AgentTask` and `AgentTaskRequestEvent` for action identification
- Created `createPendingApprovals()` factory with insert/query/resolve/initialize (DI pattern matching audit-log)
- Implemented `enforcePermissionGate()` as exported function in agent-session.ts — code-level enforcement before `query()`
- Green: audit + execute silently; Yellow: audit + execute + emit `permission:approved`; Red: audit + queue + emit `permission:blocked`
- Refactored `AgentManager` constructor to use `AgentManagerDeps` object (fixes max-params lint rule)
- Permission deps are optional throughout — full backward compatibility preserved
- Undeclared actions default to `unknown:undeclared` which resolves to Red tier
- 147 tests pass (14 new tests added), 0 lint errors, build succeeds

### Code Review Fixes Applied

- **H1 — All tasks blocked in production**: Changed gate condition from `if (permissionDeps)` to `if (permissionDeps && actionName)`. Gate only activates when an explicit actionName is provided. Undeclared actions (AC5) still blocked when named explicitly.
- **H2 — Missing integration tests**: Added 3 integration tests for `runAgentTask`: red-tier blocking (verifies SDK `query()` NOT called), green-tier execution, and permissionDeps-without-actionName (verifies gate skipped).
- **M1 — Blocked vs failed indistinguishable**: Added `blocked?: boolean` to `AgentSessionResult`, `'blocked'` to `AgentTask.status` union, agent-manager now sets `task.status = 'blocked'` for permission-gated tasks.
- **M2 — vi.mock inside it() block**: Moved SDK and config mocks to top level (properly hoisted), replaced dynamic import with static import.
- **M3 — resolve() re-resolution guard**: Added `AND resolution IS NULL` to UPDATE query; throws on already-resolved approvals. Added test.

### File List

- `packages/shared/src/types/events.ts` — Added PermissionApprovedEvent, PermissionBlockedEvent, Zod schemas, added to RavenEvent union
- `packages/shared/src/types/agents.ts` — Added optional `actionName` field to AgentTask; added `'blocked'` to status union (code review fix)
- `packages/core/src/permission-engine/pending-approvals.ts` — NEW: PendingApprovals factory module; re-resolution guard added (code review fix)
- `packages/core/src/agent-manager/agent-session.ts` — Added PermissionDeps, GateResult, enforcePermissionGate(), gate call in runAgentTask(); added `blocked` field to result, gate requires explicit actionName (code review fixes)
- `packages/core/src/agent-manager/agent-manager.ts` — Added AgentManagerDeps interface, refactored constructor to deps object, threads permission deps + actionName; blocked status handling (code review fix)
- `packages/core/src/index.ts` — Init pendingApprovals, pass all permission deps to AgentManager
- `packages/core/src/__tests__/permission-gate.test.ts` — NEW: 18 tests covering all tiers, undeclared actions, backward compat, pending approvals CRUD, runAgentTask integration (code review additions)
- `packages/core/src/__tests__/agent-manager.test.ts` — Updated AgentManager constructor to deps object
- `packages/core/src/__tests__/e2e.test.ts` — Updated AgentManager constructor to deps object
