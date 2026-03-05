# Story 1.2: Schema Migration System & Permission Tables

Status: done

## Story

As the system operator,
I want database schema changes applied safely through versioned migrations,
so that the database evolves reliably without manual intervention.

## Acceptance Criteria

1. **Given** the system starts with a fresh database **When** migrations run **Then** all migration scripts execute in numeric order, each wrapped in a transaction, and applied versions are tracked in `_migrations`

2. **Given** a migration has already been applied **When** the system restarts **Then** it skips already-applied migrations (idempotent)

3. **Given** a migration script fails mid-execution **When** the transaction rolls back **Then** the database remains in its pre-migration state and the error is logged

4. **Given** the `audit_log` table exists **When** any operation is attempted **Then** only INSERT is exposed at the application layer (no UPDATE/DELETE methods) _(Deferred to Story 1-4: audit log writer — this story creates the table, 1-4 creates the app-layer enforcement)_

## Tasks / Subtasks

- [x] Task 1: Create file-based migration loader (AC: #1, #2)
  - [x] 1.1: Create `packages/core/src/db/migrations.ts` — reads `.sql` files from `migrations/` dir, sorts by numeric prefix, executes in order within transactions
  - [x] 1.2: Track applied migrations in `_migrations` table (reuse existing table structure)
  - [x] 1.3: Skip already-applied migrations on restart
- [x] Task 2: Create migration SQL scripts (AC: #1, #4)
  - [x] 2.1: Create `migrations/001-initial-schema.sql` — codify existing tables from `database.ts` inline migration
  - [x] 2.2: Create `migrations/002-permission-tables.sql` — `audit_log`, `pending_approvals` tables with indexes
  - [x] 2.3: Create `migrations/003-pipeline-runs.sql` — `pipeline_runs` table with indexes
- [x] Task 3: Refactor `database.ts` to use new migration system (AC: #1, #2, #3)
  - [x] 3.1: Replace inline `migrations` array and `runMigrations()` with call to new `migrations.ts` module
  - [x] 3.2: Preserve backward compatibility — existing `_migrations` records for `001-init` must not cause re-execution
- [x] Task 4: Write tests (AC: all)
  - [x] 4.1: Migration ordering and execution tests (fresh DB)
  - [x] 4.2: Idempotency tests (run twice, no errors)
  - [x] 4.3: Transaction rollback on bad SQL
  - [x] 4.4: Verify all new tables exist with correct columns after migration
- [x] Task 5: Build, lint, verify
  - [x] 5.1: `npm run build` (shared then core)
  - [x] 5.2: `npm run check` must pass
  - [x] 5.3: All existing tests still pass (no regressions)

## Dev Notes

### Architecture Compliance

**This story creates the migration infrastructure that all future schema changes depend on.** Stories 1.3-1.7 and Epic 2 all rely on tables created here.

**Critical design decisions from architecture:**

- Versioned SQL scripts in `migrations/` directory with `NNN-*.sql` naming
- Each migration wrapped in a `BEGIN`/`COMMIT` transaction (better-sqlite3 is synchronous — use `db.transaction()`)
- Applied versions tracked in existing `_migrations` table (id, name, applied_at)
- Failed migrations roll back cleanly — the database remains in pre-migration state
- ISO 8601 strings for all timestamps in new tables (NOT integer epochs)

**Backward compatibility concern:** The existing system has a migration named `001-init` already applied. The new file-based system must recognize this. Strategy: name the file `001-initial-schema.sql` but map it to the existing `001-init` migration name in `_migrations`, OR simply check if tables already exist (`CREATE TABLE IF NOT EXISTS`). The simplest approach is to keep using `001-init` as the migration name derived from the filename prefix `001`, and check the `_migrations` table by prefix number.

### Technical Requirements

**New file: `packages/core/src/db/migrations.ts`**

Core function: `runMigrations(db: Database.Database, migrationsDir: string): void`

Implementation approach:
1. Read all `.sql` files from `migrationsDir` using `node:fs` `readdirSync`, sort by numeric prefix
2. Query `_migrations` table for already-applied names
3. For each unapplied migration, execute within a transaction:
   ```typescript
   const migrate = db.transaction((sql: string, name: string) => {
     db.exec(sql);
     db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(name, Date.now());
   });
   ```
4. On error: transaction auto-rolls back (better-sqlite3 behavior), log error, throw

**better-sqlite3 transaction behavior:** `db.transaction()` returns a function. If the inner function throws, the transaction is automatically rolled back. This is the correct pattern — do NOT manually `BEGIN`/`ROLLBACK`.

**Migration name derivation:** Use the SQL filename without extension as the migration name (e.g., `001-initial-schema.sql` -> `001-initial-schema`). For backward compat with existing `001-init`, either rename the file to `001-init.sql` or handle the mapping.

### New Table Schemas

**`audit_log` table (INSERT-ONLY):**
```sql
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,           -- ISO 8601
  skill_name TEXT NOT NULL,
  action_name TEXT NOT NULL,         -- skill:action format
  permission_tier TEXT NOT NULL,     -- green | yellow | red
  outcome TEXT NOT NULL,             -- executed | approved | denied | queued
  details TEXT,                      -- JSON blob
  session_id TEXT,
  pipeline_name TEXT
);
CREATE INDEX idx_audit_log_timestamp ON audit_log(timestamp);
CREATE INDEX idx_audit_log_skill_name ON audit_log(skill_name);
CREATE INDEX idx_audit_log_outcome ON audit_log(outcome);
```

**`pending_approvals` table:**
```sql
CREATE TABLE pending_approvals (
  id TEXT PRIMARY KEY,
  action_name TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  details TEXT,                      -- JSON blob
  requested_at TEXT NOT NULL,        -- ISO 8601
  resolved_at TEXT,                  -- ISO 8601, NULL = pending
  resolution TEXT,                   -- approved | denied | NULL
  session_id TEXT,
  pipeline_name TEXT
);
CREATE INDEX idx_pending_approvals_resolution ON pending_approvals(resolution);
```

**`pipeline_runs` table:**
```sql
CREATE TABLE pipeline_runs (
  id TEXT PRIMARY KEY,
  pipeline_name TEXT NOT NULL,
  trigger_type TEXT NOT NULL,        -- cron | event | manual | webhook
  status TEXT NOT NULL,              -- running | completed | failed | cancelled
  started_at TEXT NOT NULL,          -- ISO 8601
  completed_at TEXT,                 -- ISO 8601
  node_results TEXT,                 -- JSON blob
  error TEXT
);
CREATE INDEX idx_pipeline_runs_pipeline_name ON pipeline_runs(pipeline_name);
CREATE INDEX idx_pipeline_runs_started_at ON pipeline_runs(started_at);
```

### Database Conventions (from architecture)

- Table names: `snake_case`, plural
- Column names: `snake_case`
- Primary keys: `id TEXT` (UUID via `crypto.randomUUID()`)
- Foreign keys: `<table_singular>_id`
- Indexes: `idx_<table>_<column>`
- Timestamps: ISO 8601 TEXT (sorts correctly, human-debuggable)
- JSON blobs: stored as TEXT, parsed at application layer

### Library & Framework Requirements

- **better-sqlite3 ^11.7** — already installed, synchronous API
- **`node:fs`** — `readdirSync`, `readFileSync` to read `.sql` files from `migrations/` directory
- **`node:path`** — to resolve migration file paths
- **No new dependencies needed**

### File Structure Requirements

**Files to CREATE:**
- `packages/core/src/db/migrations.ts` — migration loader and executor
- `migrations/001-initial-schema.sql` — codified existing schema (from current inline migration)
- `migrations/002-permission-tables.sql` — audit_log + pending_approvals
- `migrations/003-pipeline-runs.sql` — pipeline execution tracking

**Files to MODIFY:**
- `packages/core/src/db/database.ts` — replace inline migration array with call to `migrations.ts`

**Files to CREATE (tests):**
- `packages/core/src/__tests__/migrations.test.ts`

### Testing Requirements

- **Temp SQLite DBs** via `mkdtempSync()` — each test gets a fresh DB, clean up in `afterEach`
- **Test fresh migration:** Create empty DB, run migrations, verify all tables exist with correct columns
- **Test idempotency:** Run migrations twice, no errors, no duplicate entries in `_migrations`
- **Test rollback:** Create a deliberately broken `.sql` file, verify DB state unchanged after failure
- **Test table structure:** After migrations, verify `audit_log`, `pending_approvals`, `pipeline_runs` columns match schema
- **Regression test:** Ensure all existing tests pass (98 tests from Story 1.1)
- **No Claude SDK mocking needed** — this is pure DB infrastructure

### Previous Story Intelligence (Story 1.1)

**Key learnings:**
- Fixed existing test mocks in `orchestrator.test.ts` and `skill-registry.test.ts` — any interface changes to shared types require updating ALL mocks
- `ACTION_NAME_REGEX` was extracted to `@raven/shared` as single source of truth — follow this pattern for any shared constants
- Gmail `getActions()` triggered `max-lines-per-function` guardrail (52 lines vs 50 limit) — long data declarations are acceptable
- All 4 skills return valid `SkillAction` arrays — 98 tests passing, 0 lint errors

**Files created/modified in Story 1.1 (context for avoiding conflicts):**
- `packages/shared/src/types/permissions.ts` (NEW)
- `packages/shared/src/types/skills.ts` (MODIFIED — getActions added to RavenSkill)
- `packages/core/src/skill-registry/base-skill.ts` (MODIFIED)
- `packages/core/src/skill-registry/skill-registry.ts` (MODIFIED — collectActions + isValidActionName)
- All 4 skill index.ts files (MODIFIED)
- Test files in shared and core `__tests__/` (NEW + MODIFIED)

**Patterns established:**
- Zod schemas in shared types for runtime validation
- Export from barrel files (`types/index.ts`)
- Tests in `packages/*/src/__tests__/*.test.ts`

### Git Intelligence

Recent commits show: `feat: first story` (Story 1.1 implementation), preceded by sprint planning and PRD creation. Code review fixes were applied for Story 1.1 (duplicate detection, regex extraction, test description accuracy).

### Existing Database Code Pattern

**Current `database.ts` (lines 38-61):**
- `runMigrations()` creates `_migrations` table if not exists
- Queries applied migration names into a Set
- Iterates inline `migrations` array, skips applied ones
- Uses `db.exec()` for SQL, then inserts into `_migrations`
- **NOT transaction-wrapped** — this is a gap to fix

**Current schema (001-init):** projects, sessions, agent_tasks, events (with indexes), schedules, preferences

The new migration system must produce the exact same schema when starting fresh, while being backward-compatible with DBs that already have `001-init` applied.

### Project Structure Notes

- `kebab-case.ts` for all files
- `node:` prefix for Node.js builtins (`node:fs`, `node:path`)
- `import type` for type-only imports
- `.ts` extensions in all relative imports
- Max 300 lines per file
- `createLogger('migrations')` for logging — never `console.log`
- One concern per file

### References

- [Source: _bmad-output/planning-artifacts/architecture.md#Database Patterns — Migration System]
- [Source: _bmad-output/planning-artifacts/architecture.md#Database Naming Convention]
- [Source: _bmad-output/planning-artifacts/architecture.md#New Tables — audit_log, pending_approvals, pipeline_runs]
- [Source: _bmad-output/planning-artifacts/epics.md#Story 1.2: Schema Migration System & Permission Tables]
- [Source: _bmad-output/planning-artifacts/prd.md#Trust & Autonomy — FR7 (audit trail)]
- [Source: _bmad-output/project-context.md#Critical Implementation Rules]
- [Source: packages/core/src/db/database.ts — Current migration pattern]

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6

### Debug Log References

None

### Completion Notes List

- Created `runFileMigrations()` function that reads `.sql` files from a directory, sorts by filename, and executes each in a `db.transaction()` wrapper
- Backward compatibility: detects legacy `001-init` migration name and renames it to `001-initial-schema` in `_migrations` table
- Refactored `database.ts` to delegate to file-based migrations via optional `migrationsDir` parameter (defaults to repo root `migrations/`)
- Removed 70+ lines of inline migration SQL from `database.ts`
- All 3 migration SQL scripts use `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` for safety
- New tables use ISO 8601 TEXT timestamps per architecture spec
- 5 new tests: ordering, idempotency, rollback, table structure verification, backward compatibility
- 103 total tests passing (98 existing + 5 new), 0 regressions
- `npm run build` and `npm run check` pass (0 errors, 40 pre-existing warnings)

### Change Log

- 2026-03-05: Story 1.2 implementation complete — file-based migration system with permission tables
- 2026-03-05: Code review fixes — H1: added error logging on migration failure (AC #3), M1: added existsSync guard for migrations dir, M2: added UNIQUE constraint on _migrations.name, M3: documented INTEGER applied_at backward compat decision, H2: AC #4 deferred to story 1-4

### File List

**Created:**
- `packages/core/src/db/migrations.ts` — migration loader and executor
- `migrations/001-initial-schema.sql` — codified existing schema
- `migrations/002-permission-tables.sql` — audit_log + pending_approvals tables
- `migrations/003-pipeline-runs.sql` — pipeline_runs table
- `packages/core/src/__tests__/migrations.test.ts` — 5 migration tests

**Modified:**
- `packages/core/src/db/database.ts` — replaced inline migrations with call to `runFileMigrations()`
