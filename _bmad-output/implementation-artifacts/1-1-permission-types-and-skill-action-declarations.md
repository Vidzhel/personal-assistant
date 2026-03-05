# Story 1.1: Permission Types & Skill Action Declarations

Status: done

## Story

As the system operator,
I want each skill to declare its available actions with default permission tiers,
So that the system knows what actions exist and their trust defaults.

## Acceptance Criteria

1. **Given** a skill implements RavenSkill **When** `getActions()` is called **Then** it returns an array of `SkillAction` objects with name, description, defaultTier, and reversible flag

2. **Given** the TickTick skill **When** its actions are declared **Then** read operations default to `green`, task creation defaults to `yellow`, task deletion defaults to `red`

3. **Given** the Gmail skill **When** its actions are declared **Then** read/search operations default to `green`, labeling/archiving defaults to `yellow`, send/delete defaults to `red`

4. **Given** the Telegram skill **When** its actions are declared **Then** sending messages defaults to `green` (notification sink), no high-risk actions

5. **Given** the Digest skill **When** its actions are declared **Then** compilation defaults to `green` (read-only aggregation)

6. **Given** any skill action name **When** it is validated **Then** it follows the pattern `<skill-name>:<action-name>` in kebab-case, colon-separated

7. **Given** an action that is not declared by any skill **When** the tier is resolved **Then** it defaults to `red` (FR10)

8. **Given** `BaseSkill` **When** a skill does not override `getActions()` **Then** it returns an empty array (safe default)

## Tasks / Subtasks

- [x] Task 1: Create permission types in `@raven/shared` (AC: #1, #6, #7)
  - [x] 1.1: Create `packages/shared/src/types/permissions.ts` with `PermissionTier`, `SkillAction`, and Zod schemas
  - [x] 1.2: Export from `packages/shared/src/types/index.ts`
  - [x] 1.3: Verify barrel export in `packages/shared/src/index.ts` (already re-exports types/index)
- [x] Task 2: Extend `RavenSkill` interface and `BaseSkill` (AC: #1, #8)
  - [x] 2.1: Add `getActions(): SkillAction[]` to `RavenSkill` interface in `packages/shared/src/types/skills.ts`
  - [x] 2.2: Add default `getActions()` returning `[]` to `BaseSkill` in `packages/core/src/skill-registry/base-skill.ts`
- [x] Task 3: Retrofit TickTick skill with action declarations (AC: #2, #6)
  - [x] 3.1: Add `getActions()` to `packages/skills/skill-ticktick/src/index.ts`
- [x] Task 4: Retrofit Gmail skill with action declarations (AC: #3, #6)
  - [x] 4.1: Add `getActions()` to `packages/skills/skill-gmail/src/index.ts`
- [x] Task 5: Retrofit Telegram skill with action declarations (AC: #4, #6)
  - [x] 5.1: Add `getActions()` to `packages/skills/skill-telegram/src/index.ts`
- [x] Task 6: Retrofit Digest skill with action declarations (AC: #5, #6)
  - [x] 6.1: Add `getActions()` to `packages/skills/skill-digest/src/index.ts`
- [x] Task 7: Add action registration to SkillRegistry (AC: #1, #7)
  - [x] 7.1: Extend `packages/core/src/skill-registry/skill-registry.ts` with `collectActions()` method and action name validation
  - [x] 7.2: Add action name validation utility (regex: `/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/`)
- [x] Task 8: Write tests (AC: all)
  - [x] 8.1: Unit tests for permission types and Zod schemas
  - [x] 8.2: Unit tests for SkillRegistry `collectActions()` and action name validation
  - [x] 8.3: Verify all 4 skills return valid SkillAction arrays
- [x] Task 9: Build, lint, verify (all ACs)
  - [x] 9.1: `npm run build` (shared first, then core, then skills)
  - [x] 9.2: `npm run check` must pass

## Dev Notes

### Architecture Compliance

**Permission types are the foundation of the entire trust system.** Stories 1.2–1.7 all depend on these types. Get them right.

**Critical architecture decisions from `architecture.md`:**

- `PermissionTier` = `'green' | 'yellow' | 'red'` — string union, not enum
- Action naming: `<skill-name>:<action-name>` — kebab-case, colon-separated (matches event naming convention)
- Undeclared actions default to `red` tier (FR10) — this is resolved at the permission engine level (Story 1.3), but the type system must support it
- `SkillAction` shape: `{ name, description, defaultTier, reversible }`

**From architecture — Structure Patterns:**
```typescript
// Every skill's getActions() returns this shape
{
  name: 'ticktick:create-task',      // skill:action (kebab-case, colon-separated)
  description: 'Create a new task in TickTick',
  defaultTier: 'green',              // green | yellow | red
  reversible: true,
}
```

### Technical Requirements

**New file: `packages/shared/src/types/permissions.ts`**

Types to define:
- `PermissionTier` — `'green' | 'yellow' | 'red'` string union
- `SkillAction` — `{ name: string; description: string; defaultTier: PermissionTier; reversible: boolean }`
- `PermissionTierSchema` — Zod schema for `PermissionTier` (used in Story 1.3 for config validation)
- `SkillActionSchema` — Zod schema for `SkillAction` (used for runtime validation of skill declarations)

**Extend `RavenSkill` interface (in `skills.ts`):**
- Add `getActions(): SkillAction[]` — required method
- This is a breaking change for all 4 existing skills — they must all be updated in this story

**Extend `BaseSkill` (in `base-skill.ts`):**
- Add `getActions(): SkillAction[]` returning `[]` — safe default for skills that don't declare actions

**NOTE:** All 4 existing skills implement `RavenSkill` directly via private classes (not extending `BaseSkill`). Each must have `getActions()` added manually.

### Library & Framework Requirements

- **Zod ^3.23** — already installed. Use `z.enum(['green', 'yellow', 'red'])` for tier, `z.object({...})` for SkillAction
- **No new dependencies needed** — this is a pure type + interface story

### File Structure Requirements

**Files to CREATE:**
- `packages/shared/src/types/permissions.ts` — permission types + Zod schemas

**Files to MODIFY:**
- `packages/shared/src/types/index.ts` — add `export * from './permissions.ts'`
- `packages/shared/src/types/skills.ts` — add `import type { SkillAction }` and `getActions()` to `RavenSkill`
- `packages/core/src/skill-registry/base-skill.ts` — add default `getActions()` implementation
- `packages/core/src/skill-registry/skill-registry.ts` — add `collectActions()` method
- `packages/skills/skill-ticktick/src/index.ts` — add `getActions()`
- `packages/skills/skill-gmail/src/index.ts` — add `getActions()`
- `packages/skills/skill-telegram/src/index.ts` — add `getActions()`
- `packages/skills/skill-digest/src/index.ts` — add `getActions()`

**Files to CREATE (tests):**
- `packages/shared/src/__tests__/permissions.test.ts` — Zod schema validation tests
- `packages/core/src/__tests__/skill-actions.test.ts` — SkillRegistry collectActions + action name validation tests

### Testing Requirements

- **Mock pattern:** No Claude SDK mocking needed for this story — it's pure types and interfaces
- **Zod schema tests:** Verify PermissionTierSchema accepts valid tiers, rejects invalid values
- **SkillAction validation:** Verify action name regex enforces `skill:action` pattern
- **Skill action declarations:** Instantiate each skill class, call `getActions()`, verify:
  - Returns array of valid SkillAction objects
  - All action names match `<skill-name>:<action-name>` pattern
  - All tiers are valid PermissionTier values
  - TickTick: read ops green, create yellow, delete red
  - Gmail: read green, label/archive yellow, send/delete red
  - Telegram: send green
  - Digest: compile green
- **SkillRegistry `collectActions()`:** Register skills, call collectActions, verify merged action list
- Tests go in `packages/shared/src/__tests__/` and `packages/core/src/__tests__/`

### Skill Action Declarations Reference

**TickTick skill actions (suggested):**
| Action Name | Description | Default Tier | Reversible |
|---|---|---|---|
| `ticktick:get-tasks` | Retrieve tasks and lists | green | true |
| `ticktick:get-task-details` | Get details of a specific task | green | true |
| `ticktick:create-task` | Create a new task | yellow | true |
| `ticktick:update-task` | Update an existing task | yellow | true |
| `ticktick:complete-task` | Mark a task as complete | yellow | true |
| `ticktick:delete-task` | Permanently delete a task | red | false |

**Gmail skill actions (suggested):**
| Action Name | Description | Default Tier | Reversible |
|---|---|---|---|
| `gmail:search-emails` | Search and read emails | green | true |
| `gmail:get-email` | Read a specific email | green | true |
| `gmail:label-email` | Apply labels to an email | yellow | true |
| `gmail:archive-email` | Archive an email | yellow | true |
| `gmail:mark-read` | Mark email as read | yellow | true |
| `gmail:send-email` | Send a new email | red | false |
| `gmail:reply-email` | Reply to an email | red | false |
| `gmail:delete-email` | Permanently delete an email | red | false |

**Telegram skill actions (suggested):**
| Action Name | Description | Default Tier | Reversible |
|---|---|---|---|
| `telegram:send-message` | Send a message to user | green | false |
| `telegram:send-notification` | Send a system notification | green | false |

**Digest skill actions (suggested):**
| Action Name | Description | Default Tier | Reversible |
|---|---|---|---|
| `digest:compile-briefing` | Compile a digest briefing from skill data | green | true |

### Project Structure Notes

- All files follow kebab-case naming convention
- Types centralized in `packages/shared/src/types/` — permissions.ts is the right location
- One concern per file, max 300 lines — permissions.ts should be well under this
- `.ts` extensions required in all relative imports
- `import type` for type-only imports (enforced by ESLint `consistent-type-imports`)

### References

- [Source: _bmad-output/planning-artifacts/architecture.md#Structure Patterns — Permission Action Declaration]
- [Source: _bmad-output/planning-artifacts/architecture.md#Core Architectural Decisions — Authentication & Security]
- [Source: _bmad-output/planning-artifacts/architecture.md#Implementation Patterns & Consistency Rules — Naming Patterns]
- [Source: _bmad-output/planning-artifacts/epics.md#Story 1.1: Permission Types & Skill Action Declarations]
- [Source: _bmad-output/planning-artifacts/prd.md#Trust & Autonomy — FR1, FR8, FR9, FR10]
- [Source: _bmad-output/planning-artifacts/prd.md#Skill Integration Contract — Permission contract]
- [Source: _bmad-output/project-context.md#Critical Implementation Rules]

## Dev Agent Record

### Agent Model Used
Claude Opus 4.6

### Debug Log References
- Fixed existing test mocks in `orchestrator.test.ts` and `skill-registry.test.ts` — added missing `getActions` to mock skill objects after `RavenSkill` interface breaking change.
- Gmail `getActions()` triggers `max-lines-per-function` guardrail warning (52 lines vs 50 limit) — acceptable for a data declaration method.

### Completion Notes List
- Created `PermissionTier` type (`'green' | 'yellow' | 'red'`) and `SkillAction` interface with Zod schemas for runtime validation
- Extended `RavenSkill` interface with required `getActions()` method
- Added safe default `getActions()` returning `[]` in `BaseSkill`
- Retrofitted all 4 skills (TickTick, Gmail, Telegram, Digest) with action declarations matching architecture spec
- Added `collectActions()` to `SkillRegistry` with `isValidActionName()` validation utility
- 98 tests passing (13 test files), 0 lint errors, build clean across all packages
- Action name validation regex: `/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/`

### File List
- `packages/shared/src/types/permissions.ts` (NEW) — PermissionTier, SkillAction types + Zod schemas
- `packages/shared/src/types/index.ts` (MODIFIED) — added permissions.ts export
- `packages/shared/src/types/skills.ts` (MODIFIED) — added getActions() to RavenSkill interface
- `packages/core/src/skill-registry/base-skill.ts` (MODIFIED) — added default getActions()
- `packages/core/src/skill-registry/skill-registry.ts` (MODIFIED) — added collectActions() + isValidActionName()
- `packages/skills/skill-ticktick/src/index.ts` (MODIFIED) — added getActions() with 6 actions
- `packages/skills/skill-gmail/src/index.ts` (MODIFIED) — added getActions() with 8 actions
- `packages/skills/skill-telegram/src/index.ts` (MODIFIED) — added getActions() with 2 actions
- `packages/skills/skill-digest/src/index.ts` (MODIFIED) — added getActions() with 1 action
- `packages/shared/src/__tests__/permissions.test.ts` (NEW) — 11 tests for Zod schema validation
- `packages/core/src/__tests__/skill-actions.test.ts` (NEW) — 15 tests for collectActions + action name validation
- `packages/core/src/__tests__/skill-registry.test.ts` (MODIFIED) — added getActions to mock
- `packages/core/src/__tests__/orchestrator.test.ts` (MODIFIED) — added getActions to mock

### Change Log
- 2026-03-05: Code review fixes — M1: collectActions() now detects and skips duplicate action names across skills. M2: ACTION_NAME_REGEX extracted to @raven/shared permissions.ts as single source of truth (removed duplicate in skill-registry.ts). M3: Test descriptions in skill-actions.test.ts corrected to not falsely claim AC verification.
- 2026-03-04: Story 1.1 implemented — Permission types, skill action declarations, SkillRegistry collectActions, all tests passing
