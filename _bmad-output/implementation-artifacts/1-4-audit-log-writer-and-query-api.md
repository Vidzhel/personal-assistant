# Story 1.4: Audit Log Writer & Query API

Status: done

## Story

As the system operator,
I want a complete, queryable audit trail of all gated actions,
so that I can review what Raven did, when, and why.

## Acceptance Criteria

1. **AC1: Audit Entry Query Response** — Given an audit entry is written, when queried via `/api/audit-logs`, then it returns entries with: `id`, `timestamp`, `skillName`, `actionName`, `permissionTier`, `outcome`, `details`

2. **AC2: Query Parameter Filtering & Sorting** — Given query params `?skillName=gmail&tier=green&limit=50`, when the API is called, then only matching entries are returned, limited to 50, sorted by timestamp descending

3. **AC3: Append-Only Enforcement** — Given an attempt to UPDATE or DELETE an audit entry, when executed through the audit-log module, then no such method exists — only `insert()` and `query()` are exposed

## Tasks / Subtasks

- [x] Task 1: Add shared types for audit log (AC: #1, #2, #3)
  - [x] 1.1 Add `AuditEntry` interface to `packages/shared/src/types/permissions.ts`
  - [x] 1.2 Add `AuditOutcome` type (`'executed' | 'approved' | 'denied' | 'queued'`)
  - [x] 1.3 Add `AuditLogFilter` interface with Zod schema (`AuditLogFilterSchema`)
  - [x] 1.4 Export new types from `packages/shared/src/types/index.ts`
  - [x] 1.5 Build shared: `npm run build -w packages/shared`

- [x] Task 2: Create audit log module (AC: #1, #3)
  - [x] 2.1 Create `packages/core/src/permission-engine/audit-log.ts`
  - [x] 2.2 Implement factory function `createAuditLog(db)` returning `{ insert, query, initialize }`
  - [x] 2.3 `insert()` — INSERT-only, generates UUID, ISO 8601 timestamp, parameterized query
  - [x] 2.4 `query()` — dynamic WHERE clause builder with parameterized bindings, LIMIT/OFFSET, ORDER BY timestamp DESC
  - [x] 2.5 `initialize()` — verify audit_log table exists (already created by migration 002)
  - [x] 2.6 NO update/delete methods — enforce immutability at module boundary

- [x] Task 3: Create API route (AC: #1, #2)
  - [x] 3.1 Create `packages/core/src/api/routes/audit-logs.ts`
  - [x] 3.2 Implement `registerAuditLogRoutes(app, deps)` following existing route patterns
  - [x] 3.3 `GET /api/audit-logs` with query params: `skillName`, `tier`, `outcome`, `from`, `to`, `limit`, `offset`
  - [x] 3.4 Validate query params with Zod (`AuditLogFilterSchema`)
  - [x] 3.5 Map snake_case DB columns to camelCase JSON response
  - [x] 3.6 Return array directly (no envelope), sorted timestamp DESC

- [x] Task 4: Boot sequence integration (AC: #1)
  - [x] 4.1 In `packages/core/src/index.ts`, instantiate audit log after database init
  - [x] 4.2 Call `auditLog.initialize()` during boot
  - [x] 4.3 Pass audit log reference to API server deps
  - [x] 4.4 Register audit log routes in `packages/core/src/api/server.ts`

- [x] Task 5: Tests (AC: #1, #2, #3)
  - [x] 5.1 Create `packages/core/src/__tests__/audit-log.test.ts`
  - [x] 5.2 Test insert: single entry with all fields verified
  - [x] 5.3 Test insert: auto-generated id and timestamp
  - [x] 5.4 Test query: no filters returns all entries
  - [x] 5.5 Test query: filter by skillName
  - [x] 5.6 Test query: filter by tier
  - [x] 5.7 Test query: filter by outcome
  - [x] 5.8 Test query: filter by date range (from/to)
  - [x] 5.9 Test query: combined filters
  - [x] 5.10 Test query: limit and offset pagination
  - [x] 5.11 Test query: sort order (timestamp DESC)
  - [x] 5.12 Test immutability: no update/delete methods on returned object
  - [x] 5.13 Test API route: GET /api/audit-logs returns 200 with array
  - [x] 5.14 Test API route: query param filtering works end-to-end
  - [x] 5.15 Test API route: invalid params return 400
  - [x] 5.16 Test API route: response uses camelCase keys

- [x] Task 6: Verify (AC: #1, #2, #3)
  - [x] 6.1 `npm run check` passes (format, lint, types)
  - [x] 6.2 `npm test` passes (all existing + new tests)
  - [x] 6.3 Build succeeds: `npm run build`

## Dev Notes

### Database Schema (Already Exists — Migration 002)

The `audit_log` table was created in Story 1.2 via `migrations/002-permission-tables.sql`:

```sql
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  action_name TEXT NOT NULL,
  permission_tier TEXT NOT NULL,
  outcome TEXT NOT NULL,
  details TEXT,
  session_id TEXT,
  pipeline_name TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_log_skill_name ON audit_log(skill_name);
CREATE INDEX IF NOT EXISTS idx_audit_log_outcome ON audit_log(outcome);
```

**Do NOT create a new migration.** The table already exists. The audit-log module's `initialize()` should simply verify it exists.

### Naming Conventions

| Layer | Convention | Example |
|-------|-----------|---------|
| Database columns | snake_case | `skill_name`, `action_name`, `permission_tier` |
| API query params | camelCase | `skillName`, `tier`, `outcome` |
| API response fields | camelCase | `skillName`, `actionName`, `permissionTier` |
| TypeScript interfaces | camelCase | `skillName: string` |

The audit-log module must handle the snake_case ↔ camelCase mapping when reading from/writing to the database.

### Outcome Values (Fixed Set)

| Value | Scenario | Written By |
|-------|----------|------------|
| `'executed'` | Green/Yellow tier executed | Story 1.5 (permission gate) |
| `'approved'` | Red-tier approved then executed | Story 1.6 (approval queue) |
| `'denied'` | Red-tier denied | Story 1.6 (approval queue) |
| `'queued'` | Red-tier queued pending approval | Story 1.5 (permission gate) |

Story 1.4 creates the write/query infrastructure. Stories 1.5-1.6 will call `insert()`.

### Module Design: Factory Function Pattern

```typescript
// packages/core/src/permission-engine/audit-log.ts
import type { DatabaseInterface } from '../db/database.ts';
import type { AuditEntry, AuditLogFilter } from '@raven/shared';

export interface AuditLog {
  insert(entry: Omit<AuditEntry, 'id' | 'timestamp'>): AuditEntry;
  query(filters: AuditLogFilter): AuditEntry[];
  initialize(): void;
}

export function createAuditLog(db: DatabaseInterface): AuditLog {
  // Return object with insert/query/initialize — NO update, NO delete
}
```

**Critical:** No classes (per project conventions). Factory function returns a plain object.

### API Route Pattern (Follow Existing)

Follow the pattern established in `packages/core/src/api/routes/events.ts`:
- Fastify generic types for `Querystring`
- Build WHERE conditions array + params array dynamically
- Parameterized queries only (prevent SQL injection)
- Return parsed rows with camelCase keys

```typescript
// packages/core/src/api/routes/audit-logs.ts
export function registerAuditLogRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): void {
  app.get<{ Querystring: { skillName?: string; tier?: string; /* ... */ } }>(
    '/api/audit-logs',
    async (req, reply) => { /* ... */ }
  );
}
```

### Boot Sequence Integration Point

In `packages/core/src/index.ts`, add after database initialization (around line 94-97 where permissionEngine is created):

```typescript
const auditLog = createAuditLog(database);
auditLog.initialize();
log.info('Audit log initialized');
```

Then pass `auditLog` through ApiDeps to route handlers. Add `auditLog: AuditLog` to the `ApiDeps` interface in `packages/core/src/api/server.ts`.

### Query Implementation

Build SQL dynamically from filter params:
```sql
SELECT * FROM audit_log
WHERE skill_name = ?      -- if skillName provided
  AND permission_tier = ? -- if tier provided
  AND outcome = ?         -- if outcome provided
  AND timestamp >= ?      -- if from provided
  AND timestamp <= ?      -- if to provided
ORDER BY timestamp DESC
LIMIT ? OFFSET ?
```

Default limit: 100, max: 1000. Default offset: 0.

### Shared Types to Add

Add to `packages/shared/src/types/permissions.ts`:

```typescript
export type AuditOutcome = 'executed' | 'approved' | 'denied' | 'queued';
export const AuditOutcomeSchema = z.enum(['executed', 'approved', 'denied', 'queued']);

export interface AuditEntry {
  id: string;
  timestamp: string;
  skillName: string;
  actionName: string;
  permissionTier: PermissionTier;
  outcome: AuditOutcome;
  details?: string;
  sessionId?: string;
  pipelineName?: string;
}

export interface AuditLogFilter {
  skillName?: string;
  tier?: PermissionTier;
  outcome?: AuditOutcome;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export const AuditLogFilterSchema = z.object({
  skillName: z.string().optional(),
  tier: PermissionTierSchema.optional(),
  outcome: AuditOutcomeSchema.optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
});
```

**Note:** Use `z.coerce.number()` for query params since Fastify delivers them as strings.

### Project Structure Notes

- Audit log module goes in `packages/core/src/permission-engine/` alongside `permission-engine.ts` — both are part of the trust/permission subsystem
- Route file goes in `packages/core/src/api/routes/audit-logs.ts` following existing route organization
- Tests go in `packages/core/src/__tests__/audit-log.test.ts`
- No new directories needed

### Database Access Pattern

Use `getDb()` singleton from `packages/core/src/db/database.ts`:

```typescript
import { getDb } from '../db/database.ts';
const db = getDb();
db.prepare('INSERT INTO audit_log ...').run(...params);
db.prepare('SELECT * FROM audit_log ...').all(...params);
```

Or accept `db` as a dependency (preferred for testability — the factory function approach).

### Testing Strategy

- **Framework:** Vitest (already configured)
- **Database:** Use `mkdtempSync` + `initDatabase(tempPath)` for test isolation, clean up in `afterEach`
- **API tests:** Use `app.inject()` (Fastify's built-in test helper) — no HTTP server needed
- **No Claude SDK mocking** — this story is pure data infrastructure
- **Follow patterns from:** `packages/core/src/__tests__/permission-engine.test.ts` and `packages/core/src/__tests__/api.test.ts`

### Previous Story Learnings (Story 1.3)

- Permission engine uses factory function pattern (`createPermissionEngine`) — follow same for audit log
- `config:reloaded` event pattern exists on EventBus for hot-reload scenarios
- Story 1.3 established `packages/core/src/permission-engine/` as the directory for permission subsystem code
- Tests use `makeSkillWithActions()` helper to create mock skills — reuse if needed
- `PermissionTier` and `PermissionTierSchema` already exported from `@raven/shared`

### Git Intelligence (Recent Commits)

Last relevant commit: `563b9c7 feat: stories 1-2 and 1-3 — migration system, permission engine`
- Created migration 002 with `audit_log` table (the table this story writes to)
- Created permission engine with tier resolution
- All 118 tests passing, 0 lint errors
- Established the permission-engine directory structure

### References

- [Source: _bmad-output/planning-artifacts/epics.md — Epic 1, Story 1.4]
- [Source: _bmad-output/planning-artifacts/architecture.md — Audit Log Schema, API Endpoints]
- [Source: _bmad-output/planning-artifacts/prd.md — NFR: Audit & Compliance]
- [Source: migrations/002-permission-tables.sql — audit_log table DDL]
- [Source: packages/core/src/permission-engine/permission-engine.ts — factory function pattern]
- [Source: packages/core/src/api/routes/events.ts — query param filtering pattern]
- [Source: packages/core/src/api/server.ts — route registration pattern]
- [Source: packages/core/src/__tests__/api.test.ts — API test patterns]
- [Source: packages/core/src/__tests__/permission-engine.test.ts — unit test patterns]

## Dev Agent Record

### Agent Model Used
Claude Opus 4.6

### Debug Log References
- All 133 tests passing (16 test files), 0 lint errors
- Build succeeds across all packages (shared, core, web, skills)

### Completion Notes List
- Task 1: Added `AuditOutcome`, `AuditEntry`, `AuditLogFilter`, `AuditLogFilterSchema` to shared types. Used `z.coerce.number()` for query params.
- Task 2: Created `createAuditLog()` factory function (no-arg, uses `getDb()` internally). Returns `{ insert, query, initialize }` — no update/delete. `rowToEntry()` helper handles snake_case→camelCase mapping. Optional fields spread conditionally to avoid `null` in JSON.
- Task 3: Created `GET /api/audit-logs` route with Zod validation. Returns 400 on invalid params (e.g. invalid tier). Returns array directly, sorted timestamp DESC.
- Task 4: Integrated audit log into boot sequence (after permission engine). Added `auditLog` as optional field on `ApiDeps` for backward compatibility with existing tests.
- Task 5: 16 tests covering insert, query filtering, pagination, sort order, immutability, and full API route integration.
- Task 6: `npm run check` passes (0 errors), `npm test` passes (133 tests), `npm run build` succeeds.

### Change Log
- 2026-03-05: Story 1.4 implemented — audit log writer, query module, and API route
- 2026-03-05: Code review fixes — DI for createAuditLog(db), auditLog required in ApiDeps, insert/query return consistency, cleaner Zod error format, integration test coverage in api.test.ts

### File List
- packages/shared/src/types/permissions.ts (modified — added AuditOutcome, AuditEntry, AuditLogFilter, AuditLogFilterSchema)
- packages/core/src/permission-engine/audit-log.ts (new — createAuditLog factory with DB DI, AuditLog interface)
- packages/core/src/api/routes/audit-logs.ts (new — GET /api/audit-logs route with structured Zod errors)
- packages/core/src/api/server.ts (modified — auditLog required in ApiDeps, registered audit log routes)
- packages/core/src/index.ts (modified — audit log initialization with getDb() DI)
- packages/core/src/__tests__/audit-log.test.ts (new — 16 tests for audit log module and API)
- packages/core/src/__tests__/api.test.ts (modified — added auditLog to deps, integration test for audit route)
- packages/core/src/__tests__/e2e.test.ts (modified — added auditLog to createApiServer deps)
