# Story 1.3: Permission Config Loader & Tier Resolver

Status: done

## Story

As the system operator,
I want to configure permission tier overrides in a JSON file,
so that I can promote or demote trust levels for specific skill actions without code changes.

## Acceptance Criteria (BDD)

### AC 1: Config-based tier override
- **Given** `config/permissions.json` contains `{ "gmail:archive-email": "green" }`
- **When** the permission engine resolves the tier for `gmail:archive-email`
- **Then** it returns `green` (overriding the skill's default `yellow`)

### AC 2: Fallback to skill default
- **Given** an action has no override in `permissions.json`
- **When** the tier is resolved
- **Then** the skill's declared `defaultTier` is used (from `getActions()`)

### AC 3: Default to red for undeclared actions
- **Given** an action is not declared by any skill AND has no config override
- **When** the tier is resolved
- **Then** it defaults to `red` (FR10 compliance — fail-safe)

### AC 4: File watcher hot-reload
- **Given** `config/permissions.json` is modified on disk
- **When** the file watcher detects the change
- **Then** the config is re-parsed, Zod-validated, and swapped in memory
- **And** a `config:reloaded` event is emitted on the event bus

### AC 5: Config validation with rollback
- **Given** an invalid `permissions.json` is saved (malformed JSON or invalid tiers)
- **When** validation fails
- **Then** the previous valid config is retained and an error is logged
- **And** `config:reloaded` is NOT emitted

## Tasks / Subtasks

- [x] Task 1: Add shared types and Zod schema (AC: all)
  - [x] 1.1 Add `PermissionConfig` type and `PermissionConfigSchema` to `packages/shared/src/types/permissions.ts`
  - [x] 1.2 Add `config:reloaded` event type to `packages/shared/src/types/events.ts`
  - [x] 1.3 Verify barrel exports in `packages/shared/src/types/index.ts`
  - [x] 1.4 Build shared package: `npm run build -w packages/shared`

- [x] Task 2: Implement permission engine (AC: #1, #2, #3, #4, #5)
  - [x] 2.1 Create `packages/core/src/permission-engine/permission-engine.ts`
  - [x] 2.2 Implement `loadPermissionConfig()` — read JSON, Zod-validate, return config
  - [x] 2.3 Implement `resolveTier()` — three-tier fallback: override → skill default → red
  - [x] 2.4 Implement file watcher with `node:fs` `watch()` on config directory
  - [x] 2.5 Implement reload logic with validation rollback (AC #5)
  - [x] 2.6 Emit `config:reloaded` event on successful reload only

- [x] Task 3: Create default config file (AC: #1)
  - [x] 3.1 Create `config/permissions.json` with empty `{}` (all actions use defaults)

- [x] Task 4: Integrate into boot sequence (AC: all)
  - [x] 4.1 Instantiate PermissionEngine after skill registration in `packages/core/src/index.ts`
  - [x] 4.2 Call `initialize()` with config directory path
  - [x] 4.3 Store reference for later use by agent-session (Story 1.5)

- [x] Task 5: Write tests (AC: all)
  - [x] 5.1 Config loading: valid JSON, malformed JSON, invalid tiers, missing file
  - [x] 5.2 Tier resolution: override wins, skill default fallback, red fallback for unknown
  - [x] 5.3 File watcher: reload on change, event emission, rollback on invalid
  - [x] 5.4 Integration: PermissionEngine + SkillRegistry + EventBus full flow

- [x] Task 6: Verify (AC: all)
  - [x] 6.1 `npm run check` passes (format + lint + type check)
  - [x] 6.2 `npm test` passes — all existing 103+ tests still green, no regressions

## Dev Notes

### Architecture Decision: File-only config (no DB)
Permission overrides live in `config/permissions.json` — simple, git-tracked, human-editable. No database involvement. Reloaded on file change via `fs.watch()`.

### Tier Resolution Order (from architecture.md)
1. Check `config/permissions.json` for action override
2. Fall back to skill's declared `defaultTier` (via SkillRegistry.collectActions())
3. Default to `red` if action not declared by any skill (FR10)

### Config Reload Flow (from architecture.md)
1. File watcher detects change OR API triggers reload
2. Re-parse JSON and Zod-validate
3. If valid: swap in-memory config, emit `config:reloaded` event
4. If invalid: log error via Pino, keep previous config, do NOT emit event

### No classes rule exception
Architecture shows a `PermissionEngine` — use **functions and composition** instead. Export a factory function that returns an object with `initialize()`, `resolveTier()`, `shutdown()` methods. Do NOT use a class.

### Boot sequence integration point
Current boot order in `packages/core/src/index.ts`:
```
1. loadConfig()  2. initDatabase()  3. EventBus  4. SkillRegistry
5. loadSkillsConfig() + registerSkills()
→ INSERT HERE: createPermissionEngine(skillRegistry, eventBus) + initialize()
6. McpManager  7. SessionManager  8. AgentManager  ...
```

### Project Structure Notes

**Files to CREATE:**
- `packages/core/src/permission-engine/permission-engine.ts` — factory function, loader, resolver, watcher
- `packages/core/src/__tests__/permission-engine.test.ts` — comprehensive tests
- `config/permissions.json` — default empty config `{}`

**Files to MODIFY:**
- `packages/shared/src/types/permissions.ts` — add PermissionConfig + PermissionConfigSchema
- `packages/shared/src/types/events.ts` — add config:reloaded event type
- `packages/core/src/index.ts` — instantiate permission engine in boot sequence

**Files NOT to touch (later stories):**
- `packages/core/src/agent-manager/agent-session.ts` — Story 1.5
- `packages/core/src/api/` routes — Story 1.4+

### Existing Types to Use (from Story 1.1)

```typescript
// packages/shared/src/types/permissions.ts (ALREADY EXISTS)
export type PermissionTier = 'green' | 'yellow' | 'red';
export const PermissionTierSchema = z.enum(['green', 'yellow', 'red']);
export const ACTION_NAME_REGEX = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;
export interface SkillAction { name: string; description: string; defaultTier: PermissionTier; reversible: boolean; }
export const SkillActionSchema = z.object({ ... });
```

### New Zod Schema to Add

```typescript
// ADD to packages/shared/src/types/permissions.ts
export interface PermissionConfig {
  [actionName: string]: PermissionTier;
}

export const PermissionConfigSchema = z.record(
  z.string().regex(ACTION_NAME_REGEX, {
    message: 'Action name must match <skill-name>:<action-name> in kebab-case',
  }),
  PermissionTierSchema,
);
```

### Existing Skill Actions Reference (from Story 1.1)
| Skill | Action | Default Tier |
|-------|--------|-------------|
| ticktick | get-tasks, get-task-details | green |
| ticktick | create-task, update-task, complete-task | yellow |
| ticktick | delete-task | red |
| gmail | search-emails, get-email | green |
| gmail | label-email, archive-email, mark-read | yellow |
| gmail | send-email, reply-email, delete-email | red |
| telegram | send-message, send-notification | green |
| digest | compile-briefing | green |

### SkillRegistry Integration
```typescript
// Already exists — use collectActions() to build action lookup
const allActions = skillRegistry.collectActions(); // SkillAction[]
const actionMap = new Map(allActions.map(a => [a.name, a]));
// Then: actionMap.get(actionName)?.defaultTier ?? 'red'
```

### EventBus Integration
```typescript
// Emit on successful config reload only
eventBus.emit({
  id: generateId(),
  timestamp: Date.now(),
  type: 'config:reloaded',
  payload: { configType: 'permissions', timestamp: new Date().toISOString() },
});
```

### Coding Conventions (enforced by npm run check)
- `.ts` extensions in all relative imports
- `node:` prefix for Node builtins (`import { watch } from 'node:fs'`, `import { readFileSync } from 'node:fs'`)
- `import type` for type-only imports
- `createLogger('permission-engine')` for logging — never `console.log`
- `crypto.randomUUID()` for IDs (or `generateId()` from shared)
- Max 300 lines per file, max 50 lines per function, max 3 params
- kebab-case filenames, camelCase functions, PascalCase types

### Testing Approach
- **Framework:** Vitest (already configured with `test.projects` in root)
- **File:** `packages/core/src/__tests__/permission-engine.test.ts`
- **Temp dirs:** Use `mkdtempSync()` for test config files, clean up in `afterEach`
- **SkillRegistry:** Create real instances with mock skills that return known actions
- **EventBus:** Use real EventBus, subscribe and assert events emitted
- **File watcher:** Test with real filesystem in temp dir (write file, assert reload)
- **No Claude SDK mocking needed** — this is config infrastructure

### Learnings from Previous Stories

**From Story 1.1:**
- `ACTION_NAME_REGEX` is the single source of truth — reuse it in PermissionConfigSchema (don't duplicate)
- Interface changes cascade to existing test mocks — check `orchestrator.test.ts` and `skill-registry.test.ts`
- `collectActions()` already handles deduplication and validation

**From Story 1.2:**
- File-based config loading pattern: read → validate → swap (same pattern for permissions.json)
- Zod validation before committing changes (same pattern for config reload)
- Transaction-style rollback on failure (keep old config if new one invalid)

### References

- [Source: _bmad-output/planning-artifacts/architecture.md — Data Architecture, Permission Config Storage]
- [Source: _bmad-output/planning-artifacts/architecture.md — Config Hot-Reload Flow]
- [Source: _bmad-output/planning-artifacts/prd.md — FR1-10 Trust & Autonomy, FR58 Skill Extensibility]
- [Source: _bmad-output/planning-artifacts/epics.md — Epic 1 Story 3]
- [Source: _bmad-output/implementation-artifacts/1-1-permission-types-and-skill-action-declarations.md]
- [Source: _bmad-output/implementation-artifacts/1-2-schema-migration-system-and-permission-tables.md]
- [Source: _bmad-output/project-context.md — Critical implementation rules]

## Dev Agent Record

### Agent Model Used
Claude Opus 4.6

### Debug Log References
None — clean implementation with no debug issues.

### Completion Notes List
- Task 1: Added `PermissionConfig` interface, `PermissionConfigSchema` (Zod record with ACTION_NAME_REGEX key validation), and `ConfigReloadedEvent` to shared types. Barrel exports already covered.
- Task 2: Created `createPermissionEngine()` factory function using composition (no class). Implements `initialize()`, `resolveTier()`, `shutdown()`, `getConfig()`. Three-tier resolution: config override → skill default → red. File watcher with 100ms debounce. Validation rollback retains previous config on invalid reload.
- Task 3: Created `config/permissions.json` with empty `{}`.
- Task 4: Integrated into boot sequence after skill registration. `permissionEngine` stored in closure for Story 1.5. Shutdown handler calls `permissionEngine.shutdown()`.
- Task 5: 14 tests covering config loading (valid, malformed, invalid tiers, invalid names, missing file, missing dir), tier resolution (override, fallback, red default, promotion, demotion), file watcher (reload + event, rollback on invalid, shutdown safety), and full integration flow.
- Task 6: `npm run check` passes (0 errors), `npm test` passes (118 tests, 15 files, 0 regressions).

### Change Log
- 2026-03-05: Story 1.3 implemented — permission config loader, tier resolver, file watcher, boot integration, 14 tests
- 2026-03-05: Code review fixes — H1: cached action map in resolveTier (perf), M1: fixed duplicate step numbers in index.ts, M2: simplified resolve(join()) to resolve(), M3: added null guard for fs.watch filename

### File List
- `packages/shared/src/types/permissions.ts` (modified — added PermissionConfig, PermissionConfigSchema)
- `packages/shared/src/types/events.ts` (modified — added ConfigReloadedEvent)
- `packages/core/src/permission-engine/permission-engine.ts` (created — factory function, loader, resolver, watcher)
- `packages/core/src/__tests__/permission-engine.test.ts` (created — 14 tests)
- `packages/core/src/index.ts` (modified — permission engine boot integration + shutdown)
- `config/permissions.json` (created — empty default config)
