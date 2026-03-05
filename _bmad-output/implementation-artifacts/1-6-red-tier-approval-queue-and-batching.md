# Story 1.6: Red-Tier Approval Queue & Batching

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the system operator,
I want pending Red-tier actions batched into approval requests that I can approve or deny,
so that high-risk actions only execute with my explicit consent.

## Acceptance Criteria

1. **Query Pending Approvals** — Given 3 Red-tier actions are queued, When the user queries `GET /api/approvals/pending`, Then all 3 are returned with action details, skill name, and requested timestamp.

2. **Approve Pending Approval** — Given a pending approval exists, When `POST /api/approvals/:id/resolve` is called with `{ "resolution": "approved" }`, Then the sub-agent executes via `query()`, `pending_approvals.resolution` is set to `approved`, `resolved_at` is set, and an audit entry records `outcome: approved`.

3. **Deny Pending Approval** — Given a pending approval exists, When `POST /api/approvals/:id/resolve` is called with `{ "resolution": "denied" }`, Then no execution occurs, `pending_approvals.resolution` is set to `denied`, and an audit entry records `outcome: denied`.

4. **Batch Approve/Deny** — Given multiple pending approvals, When `POST /api/approvals/batch` is called with `{ "ids": [...], "resolution": "approved" }`, Then each is resolved individually, sub-agents execute for approved items, and all audit entries are written.

5. **Already-Resolved Guard** — Given an approval that has already been resolved, When resolve is attempted again, Then a 409 Conflict is returned and no action is taken.

6. **Post-Approval Execution** — Given a Red-tier approval is approved, When the resolution is processed, Then the original sub-agent task is re-executed via `runAgentTask()` with the stored action context, and the execution result is captured.

7. **Event Emissions** — Given an approval or denial occurs, When resolution completes, Then `permission:approved` or `permission:denied` event is emitted with Zod-validated payload.

## Tasks / Subtasks

- [x] Task 0: Prerequisite Type & Wiring Changes (AC: #7)
  - [x] 0.1 Create `PermissionDeniedEvent` type + `PermissionDeniedPayloadSchema` in `packages/shared/src/types/events.ts` (mirror `PermissionApprovedEvent`)
  - [x] 0.2 Add `'permission:denied'` to `RavenEventType` union and `RavenEvent` discriminated union
  - [x] 0.3 Add `pendingApprovals` to `ApiDeps` interface in `packages/core/src/api/server.ts`
  - [x] 0.4 Pass `pendingApprovals` from boot sequence in `packages/core/src/index.ts` to `createApiServer()`
  - [x] 0.5 Build shared package to verify type exports

- [x] Task 1: API Routes for Approval Queue (AC: #1, #5)
  - [x] 1.1 Create `packages/core/src/api/routes/approvals.ts` with route registration
  - [x] 1.2 `GET /api/approvals/pending` — query unresolved approvals, return array
  - [x] 1.3 Zod validation for query params (optional `skillName` filter)
  - [x] 1.4 Register routes in `packages/core/src/api/server.ts`

- [x] Task 2: Single Approval Resolution (AC: #2, #3, #5, #7)
  - [x] 2.1 `POST /api/approvals/:id/resolve` — accept `{ resolution: 'approved' | 'denied' }`
  - [x] 2.2 Zod request body schema: `{ resolution: z.enum(['approved', 'denied']) }`
  - [x] 2.3 Call `pendingApprovals.resolve(id, resolution)` — handle already-resolved (409)
  - [x] 2.4 Write audit log entry with `outcome: 'approved'` or `outcome: 'denied'`
  - [x] 2.5 Emit `permission:approved` or `permission:denied` event

- [x] Task 3: Post-Approval Execution (AC: #6)
  - [x] 3.1 On approved resolution, retrieve stored action context from pending approval
  - [x] 3.2 Re-execute the original task via `agentManager.runAgentTask()` with stored `actionName`, `skillName`, `details`
  - [x] 3.3 Capture execution result and write follow-up audit entry with `outcome: executed`
  - [x] 3.4 Handle execution failures gracefully — audit with `outcome: failed`, do not re-queue

- [x] Task 4: Batch Resolution (AC: #4)
  - [x] 4.1 `POST /api/approvals/batch` — accept `{ ids: string[], resolution: 'approved' | 'denied' }`
  - [x] 4.2 Zod request body schema with array validation
  - [x] 4.3 Iterate IDs, resolve each individually (skip already-resolved with partial success response)
  - [x] 4.4 Return summary: `{ resolved: number, skipped: number, results: [...] }`

- [x] Task 5: Tests (AC: all)
  - [x] 5.1 Unit tests for approval resolution logic (approve, deny, already-resolved guard)
  - [x] 5.2 Integration tests for API routes (GET pending, POST resolve, POST batch)
  - [x] 5.3 Post-approval execution test (mock `runAgentTask`, verify it's called on approve)
  - [x] 5.4 Event emission tests (permission:approved, permission:denied)
  - [x] 5.5 Batch resolution tests (mixed success/skip scenarios)

## Dev Notes

### Architecture Constraints

- **API naming:** `/api/approvals/pending`, `/api/approvals/:id/resolve`, `/api/approvals/batch` — plural nouns, kebab-case
- **Direct responses, no envelope** — success returns data array/object, errors return `{ error: string, code?: string }`
- **HTTP status codes:** 200 (success), 400 (bad request), 404 (approval not found), 409 (already resolved), 500 (server error)
- **Fastify route registration pattern** — follow `packages/core/src/api/routes/audit-logs.ts` exactly

### Existing Infrastructure (DO NOT RECREATE)

The following already exist from Stories 1-2 through 1-5. Use them directly:

| Component | Location | Interface |
|-----------|----------|-----------|
| `pending_approvals` table | Migration 002 | `id, action_name, skill_name, details, requested_at, resolved_at, resolution, session_id, pipeline_name` |
| `PendingApproval` type | `packages/core/src/permission-engine/pending-approvals.ts` (defined alongside factory) | `id, actionName, skillName, details?, requestedAt, resolvedAt?, resolution?, sessionId?, pipelineName?` |
| `createPendingApprovals()` | `packages/core/src/permission-engine/pending-approvals.ts` | `{ insert, query, resolve, initialize }` |
| `createAuditLog()` | `packages/core/src/permission-engine/audit-log.ts` | `{ insert, query }` |
| `EventBus` | `packages/core/src/event-bus/event-bus.ts` | `{ emit, on }` |
| `AgentManager` | `packages/core/src/agent-manager/agent-manager.ts` | `{ runAgentTask }` |
| Permission events | `packages/shared/src/types/events.ts` | `permission:approved`, `permission:blocked` exist; **`permission:denied` must be CREATED in this story** |
| Audit log routes | `packages/core/src/api/routes/audit-logs.ts` | Pattern to follow for new routes |

### Key Code Patterns to Follow

**Route Registration (from audit-logs.ts):**
```typescript
import type { FastifyInstance } from 'fastify';
import type { AuditLog } from '../../permission-engine/audit-log.ts';

export function registerApprovalRoutes(
  app: FastifyInstance,
  deps: { pendingApprovals: PendingApprovals; auditLog: AuditLog; agentManager: AgentManager; eventBus: EventBus }
): void {
  // Routes registered here
}
```

**Factory Function with DI (established pattern):**
- All modules receive dependencies via constructor/factory params
- No global singletons — everything injected from boot sequence (`index.ts`)

**Database Row Mapping:**
```typescript
// snake_case (SQLite) -> camelCase (TypeScript)
function rowToApproval(row: PendingApprovalRow): PendingApproval { ... }
```

**Zod Validation for Request Bodies:**
```typescript
import { z } from 'zod';
const resolveSchema = z.object({
  resolution: z.enum(['approved', 'denied']),
});
```

**Event Emission:**
```typescript
eventBus.emit({
  type: 'permission:approved',
  payload: { actionName, skillName, tier: 'red', approvalId },
  timestamp: new Date().toISOString(),
});
```

### Post-Approval Execution Flow

When a Red-tier approval is approved:
1. `pendingApprovals.resolve(id, 'approved')` updates the DB row
2. Audit log entry written: `outcome: 'approved'`, `tier: 'red'`
3. `permission:approved` event emitted
4. Retrieve stored action context from the approval record (`actionName`, `skillName`, `details`)
5. Call `agentManager.runAgentTask()` to re-execute the original task
6. If execution succeeds: audit log entry with `outcome: 'executed'`
7. If execution fails: audit log entry with `outcome: 'failed'`, error details in `details` field

**Important:** The `details` field on `pending_approvals` stores JSON with the original task context needed for re-execution. Story 1-5 stores this when inserting into the queue.

### Resolve Guard (Idempotency)

`pendingApprovals.resolve()` already includes `WHERE resolution IS NULL` — if the row is already resolved, it throws. Catch this error and return 409 Conflict.

### Boot Sequence Wiring

Approval routes need: `pendingApprovals`, `auditLog`, `agentManager`, `eventBus`.

**CRITICAL:** `pendingApprovals` is NOT currently in `ApiDeps` interface or passed to `createApiServer()`. You must:
1. Add `pendingApprovals: PendingApprovals` to the `ApiDeps` interface in `packages/core/src/api/server.ts`
2. Pass `pendingApprovals` from boot sequence in `packages/core/src/index.ts` when calling `createApiServer()`
3. Register the new approval routes in `registerRoutes()` alongside existing ones

### Project Structure Notes

- New file: `packages/core/src/api/routes/approvals.ts`
- Modified: `packages/core/src/api/server.ts` (register new routes)
- Modified: `packages/core/src/index.ts` (pass agentManager to route registration if not already)
- New test: `packages/core/src/__tests__/approvals.test.ts`
- No new migrations needed — `pending_approvals` table already exists
- New shared type needed: `PermissionDeniedEvent` + `PermissionDeniedPayloadSchema` in `packages/shared/src/types/events.ts` (follow `PermissionApprovedEvent` pattern exactly)
- Add `'permission:denied'` to `RavenEventType` union and `RavenEvent` discriminated union

### Testing Strategy

- **Integration tests** for API routes using Fastify's `inject()` method
- **Mock `agentManager.runAgentTask()`** — verify it's called on approve, not called on deny
- **Real SQLite temp DB** for pending approvals and audit log (established pattern)
- **Real EventBus** with `vi.fn()` listeners to verify event emissions
- **Test already-resolved guard** — attempt double-resolve, expect 409
- **Test batch resolution** — mix of valid and already-resolved IDs

### Previous Story Intelligence

**From Story 1-5 code review:**
- Gate condition requires explicit `actionName` — tasks without it skip gating
- `blocked?: boolean` added to `AgentSessionResult` — check for this in post-approval flow
- `vi.mock` must be at top level (hoisted), not inside `it()` blocks
- DI pattern: use object-based deps, not positional params
- `AND resolution IS NULL` guard already in resolve() — just catch the throw

**From Story 1-5 dev notes:**
- `resolve()` method was explicitly created for Story 1-6 to consume
- `query()` returns only unresolved (`resolution IS NULL`), ordered by `requestedAt ASC`
- Outcomes: Story 1-5 writes `'executed'` (green/yellow) and `'queued'` (red); Story 1-6 adds `'approved'` and `'denied'`

### Git Intelligence

**Recent commit patterns:**
- Commit message format: `feat: story X-Y — description` for features, `fix: story X-Y code review — specifics` for fixes
- Two-phase commit: feature implementation, then code review fixes
- Files follow kebab-case naming strictly
- Tests in `packages/core/src/__tests__/` directory

**Files most recently touched (for reference):**
- `packages/core/src/permission-engine/pending-approvals.ts` (created in 1-5)
- `packages/core/src/agent-manager/agent-session.ts` (modified in 1-5)
- `packages/core/src/api/routes/audit-logs.ts` (created in 1-4)
- `packages/core/src/api/server.ts` (modified in 1-4)

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Epic-1-Story-1.6]
- [Source: _bmad-output/planning-artifacts/architecture.md#Permission-Engine-Subsystem]
- [Source: _bmad-output/planning-artifacts/architecture.md#API-Naming-Conventions]
- [Source: _bmad-output/planning-artifacts/prd.md#FR5-FR6]
- [Source: _bmad-output/implementation-artifacts/1-5-permission-gate-enforcement-in-agent-session.md]
- [Source: packages/core/src/permission-engine/pending-approvals.ts]
- [Source: packages/core/src/api/routes/audit-logs.ts]

## Dev Agent Record

### Agent Model Used
Claude Opus 4.6

### Debug Log References
- Build passed after adding `'failed'` to `AuditOutcome` type
- Split `emitPermissionEvent` into `emitApprovedEvent`/`emitDeniedEvent` due to different payload shapes (`PermissionApprovedEvent` lacks `approvalId`, `PermissionDeniedEvent` includes it)

### Completion Notes List
- Task 0: Added `PermissionDeniedEvent` type + schema, added `pendingApprovals` to `ApiDeps`, wired in boot sequence. Fixed existing test files (api.test.ts, e2e.test.ts) to include new dep.
- Task 1-4: Created `approvals.ts` route file with GET pending (with skillName filter), POST resolve (approve/deny with 409 guard), POST batch, and post-approval execution via `agentManager.executeApprovedAction()`.
- Added `executeApprovedAction()` to `AgentManager` — stores mcpManager/skillRegistry refs, emits `agent:task:request` event to re-execute approved tasks.
- Added `'failed'` to `AuditOutcome` union for post-approval execution failure tracking.
- Task 5: 16 integration tests covering all ACs — pending query, approve, deny, 409 guard, batch (mixed), post-approval execution (success + failure audit), event emissions, validation.
- Code review fixes: 19 tests after adding 404, batch not_found, Zod schema validation tests.

### File List
- `packages/shared/src/types/events.ts` — added `PermissionDeniedEvent`, `PermissionDeniedPayloadSchema`, added to `RavenEvent` union
- `packages/shared/src/types/permissions.ts` — added `'failed'` to `AuditOutcome`/`AuditOutcomeSchema`
- `packages/core/src/api/routes/approvals.ts` — **NEW** approval queue routes
- `packages/core/src/api/server.ts` — added `pendingApprovals` to `ApiDeps`, registered approval routes
- `packages/core/src/index.ts` — pass `pendingApprovals` to `createApiServer()`
- `packages/core/src/agent-manager/agent-manager.ts` — added `executeApprovedAction()`, `ApprovedActionParams`, directly runs task and returns result
- `packages/core/src/permission-engine/pending-approvals.ts` — typed error codes for not-found vs already-resolved
- `packages/core/src/__tests__/approvals.test.ts` — **NEW** 19 integration tests
- `packages/core/src/__tests__/api.test.ts` — added `pendingApprovals` to test deps
- `packages/core/src/__tests__/e2e.test.ts` — added `pendingApprovals` to test deps

### Change Log
- 2026-03-05: Story 1-6 implementation complete — approval queue API, post-approval execution, batch resolution, event emissions, 16 tests
- 2026-03-05: Code review fixes — executeApprovedAction awaits task completion, 404 vs 409 error distinction, typed error codes, batch not_found tracking, Zod schema validation in tests
