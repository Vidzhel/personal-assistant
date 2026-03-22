# Story 10.5: Conversational System Configuration Management

Status: done

## Story

As the system operator,
I want to create, edit, and manage all system configuration (pipelines, suites, agents, schedules) through natural language conversation with confirmation before changes are applied, backed by living convention documents that ensure every generated and existing resource follows best practices,
So that extending and tuning the system is a conversation, not a coding session, and the system self-enforces quality standards.

## Acceptance Criteria

1. **Given** the user says "Create a pipeline that checks my email every hour and creates tasks from urgent ones" **When** the orchestrator processes it **Then** a valid YAML pipeline is generated with cron trigger, email + task-management nodes, and presented as a formatted diff for review

2. **Given** the user says "Edit the morning-briefing pipeline to also include financial summary" **When** the edit flow starts **Then** the current YAML is loaded, a modified version is generated, and a before/after diff is presented for approval

3. **Given** the user says "Add a monobank skill that tracks transactions" **When** the scaffolding sub-agent processes it **Then** a complete suite package is generated at `suites/new-suite-name/` following all project conventions (suite.ts, mcp.json, actions.json, agents/) and presented for approval

4. **Given** the user says "Create an agent called 'finance-bot' that uses financial-tracking and email suites" **When** the agent creation flow runs **Then** a new named agent config is generated with appropriate suite bindings and instructions, presented for approval

5. **Given** the user says "Add a schedule that runs the digest every weekday at 9am" **When** the schedule creation flow runs **Then** a valid schedule entry is generated with cron expression and presented for approval

6. **Given** any generated configuration is presented to the user **When** the user approves via Telegram inline keyboard ("Apply" / "Edit" / "Discard") or dashboard confirmation **Then** the change is applied, git auto-committed, and relevant config reloaded

7. **Given** the user taps "Edit" on a proposed change **When** they describe modifications **Then** the revised configuration is regenerated and re-presented for approval

8. **Given** the user taps "Discard" **When** the rejection is processed **Then** no changes are applied and a confirmation is sent

9. **Given** a generated suite **When** the code is reviewed **Then** it uses `defineSuite()`, declares MCP servers in `mcp.json`, defines actions in `actions.json`, and follows kebab-case file naming

10. **Given** the user says "Show me the morning-briefing pipeline" or "What agents do I have?" **When** the query is processed **Then** the current configuration is displayed in a readable format without making changes

11. **Given** the user says "Delete the stale-task-nudge schedule" **When** the deletion flow runs **Then** a confirmation prompt is shown before deletion, and on approval the resource is removed and git-committed

12. **Given** the user says "Change the maintenance pipeline schedule to daily at 3am" **When** the edit flow runs **Then** only the trigger section is modified, the diff is shown, and applied on approval

13. **Given** convention documents exist for each resource type (pipelines, suites, agents, schedules) **When** the config-manager agent generates any new resource **Then** it references the corresponding convention document to ensure the output follows all required patterns, naming, structure, and best practices

14. **Given** a convention document for suites exists **When** a new suite is generated **Then** it includes all required files (suite.ts, mcp.json, actions.json, agents/, UPDATE.md), follows kebab-case naming, uses `defineSuite()`, and the UPDATE.md contains dependency monitoring instructions specific to that suite's external dependencies

15. **Given** the maintenance pipeline runs **When** the convention auditor module executes **Then** it scans all existing pipelines, suites, agents, and schedules against their convention documents, reporting: missing required files (e.g. UPDATE.md), naming violations, schema drift, unused or misconfigured resources

16. **Given** the convention audit finds violations **When** the maintenance report is compiled **Then** a "Convention Compliance" section is included listing each violation with the resource name, violation type, and recommended fix

17. **Given** the convention documents are updated **When** the next maintenance run executes **Then** the auditor uses the latest conventions, and any previously-compliant resources that now violate updated conventions are flagged

## Tasks / Subtasks

- [x] Task 1: Create config-management orchestrator agent (AC: #1-#12)
  - [x] 1.1 Create `suites/_orchestrator/agents/config-manager.ts` — agent definition with `defineAgent()` that handles all config management intents
  - [x] 1.2 Agent prompt must include: all config file formats (pipeline YAML schema, suite structure, agent JSON schema, schedule JSON schema), available REST API endpoints, current system state summary
  - [x] 1.3 Agent output must be structured JSON with: `{ action: 'create'|'update'|'delete'|'view', resourceType: 'pipeline'|'suite'|'agent'|'schedule', resourceName: string, content?: string, diff?: string }`
  - [x] 1.4 Register agent in `suites/_orchestrator/suite.ts` capabilities

- [x] Task 2: Create config change presenter service (AC: #6-#8, #10-#11)
  - [x] 2.1 Create `suites/_orchestrator/services/config-presenter.ts` — formats proposed changes for user review
  - [x] 2.2 For create operations: show full content with syntax highlighting markers
  - [x] 2.3 For update operations: generate and show unified diff (use `diff` npm package or simple line-by-line comparison)
  - [x] 2.4 For delete operations: show resource summary and confirmation prompt
  - [x] 2.5 For view operations: format and display current config content
  - [x] 2.6 Emit `config:change:proposed` event with proposed change payload and approval request

- [x] Task 3: Create config change applier service (AC: #6, #9, #11)
  - [x] 3.1 Create `suites/_orchestrator/services/config-applier.ts` — applies approved config changes
  - [x] 3.2 Pipeline changes: write YAML via pipeline engine's `savePipeline()` (handles validation + git commit)
  - [x] 3.3 Suite scaffolding: use existing `scaffoldSuite()` from `suite-scaffolder.ts`; for edits, write files directly + git commit
  - [x] 3.4 Agent changes: use named agent store's `create()`/`update()`/`delete()` methods (handles DB + JSON sync + git commit)
  - [x] 3.5 Schedule changes: use scheduler's config management (read/write `config/schedules.json` + git commit + reload)
  - [x] 3.6 After apply: emit `config:change:applied` event, trigger config reload where needed
  - [x] 3.7 Validate all changes before applying — Zod parse for schemas, DAG validation for pipelines

- [x] Task 4: Integrate with Telegram approval flow (AC: #6-#8)
  - [x] 4.1 Create `suites/_orchestrator/services/config-approval-handler.ts` — manages the approval lifecycle for config changes
  - [x] 4.2 On `config:change:proposed`: store pending change in DB (new `pending_config_changes` table: id, resource_type, resource_name, action, current_content, proposed_content, status, created_at, resolved_at)
  - [x] 4.3 Send Telegram message with formatted diff/content + inline keyboard: [Apply] [Edit] [Discard]
  - [x] 4.4 Callback data format: `c:a:{changeId}` (apply), `c:e:{changeId}` (edit), `c:d:{changeId}` (discard)
  - [x] 4.5 Register callback handlers in `suites/notifications/services/callback-handler.ts` for `c:` domain prefix
  - [x] 4.6 On "Apply": call config-applier, update DB status, update Telegram message to "Applied"
  - [x] 4.7 On "Edit": respond with "Describe your changes:" prompt, feed response back to config-manager agent for revision
  - [x] 4.8 On "Discard": update DB status, update Telegram message to "Discarded"

- [x] Task 5: Add dashboard config management UI (AC: #6-#8, #10)
  - [x] 5.1 Create API route `packages/core/src/api/routes/config-changes.ts`:
    - `GET /api/config-changes` — list pending/recent changes
    - `GET /api/config-changes/:id` — get change detail with diff
    - `POST /api/config-changes/:id/resolve` — approve/reject change
  - [x] 5.2 Create Next.js page `packages/web/src/app/config/page.tsx` — config management dashboard showing:
    - Pending changes with approve/reject actions
    - Recent change history
    - Quick links to view current configs (pipelines, agents, schedules, suites)
  - [x] 5.3 Add real-time updates via existing WebSocket/SSE infrastructure

- [x] Task 6: Wire orchestrator delegation (AC: #1-#5, #10-#12)
  - [x] 6.1 Update orchestrator prompt builder to include config management capabilities — the orchestrator must know it can delegate config intents to the config-manager sub-agent
  - [x] 6.2 Add intent detection hints to orchestrator prompt: keywords like "create pipeline", "add agent", "edit schedule", "scaffold suite", "show config", "delete"
  - [x] 6.3 Ensure config-manager agent receives current system state: list of pipelines, suites, agents, schedules with their status

- [x] Task 7: Database migration for pending config changes (AC: #6)
  - [x] 7.1 Create migration: `pending_config_changes` table (id TEXT PK, resource_type TEXT, resource_name TEXT, action TEXT, current_content TEXT, proposed_content TEXT, diff_text TEXT, status TEXT DEFAULT 'pending', telegram_message_id TEXT, session_id TEXT, created_at TEXT, resolved_at TEXT)
  - [x] 7.2 Add migration to `packages/core/src/db/migrations/`

- [x] Task 8: Event types and constants (AC: all)
  - [x] 8.1 Add to `packages/shared/src/types/events.ts`: `ConfigChangeProposedEvent`, `ConfigChangeAppliedEvent`, `ConfigChangeRejectedEvent`
  - [x] 8.2 Add to `packages/shared/src/suites/constants.ts`: `EVENT_CONFIG_CHANGE_PROPOSED`, `EVENT_CONFIG_CHANGE_APPLIED`, `EVENT_CONFIG_CHANGE_REJECTED`, `SOURCE_CONFIG_MANAGER`
  - [x] 8.3 Export from `packages/shared/src/suites/index.ts`

- [x] Task 9: Create convention template documents (AC: #13, #14)
  - [x] 9.1 Create `suites/_orchestrator/conventions/pipeline-conventions.md` — documents: YAML schema with all fields, trigger types and patterns, node naming (kebab-case), connection patterns, DAG rules, retry/timeout best practices, when to use conditions vs linear flows, naming convention (`verb-noun` like `email-to-tasks`), versioning strategy
  - [x] 9.2 Create `suites/_orchestrator/conventions/suite-conventions.md` — documents: required files checklist (suite.ts, mcp.json, actions.json, agents/, services/, UPDATE.md), `defineSuite()` usage, capability declarations, MCP server config format, action naming (`suite:action-name`), permission tier guidelines (green=read-only/reversible, yellow=writes, red=irreversible/external), env var declaration, service interface pattern, UPDATE.md required sections (Dependencies to Monitor, What to Verify)
  - [x] 9.3 Create `suites/_orchestrator/conventions/agent-conventions.md` — documents: `defineAgent()` usage, prompt writing guidelines (clear role, explicit tool instructions, output format), model selection guidance (sonnet for routine, opus for complex), tool pattern format (`mcp__suite__tool__*`), `maxTurns` guidelines, suite binding best practices, naming (kebab-case, descriptive)
  - [x] 9.4 Create `suites/_orchestrator/conventions/schedule-conventions.md` — documents: cron expression patterns with examples, naming conventions, timezone handling, taskType naming, skillName resolution, when to use schedules vs pipeline cron triggers, enabled/disabled lifecycle

- [x] Task 10: Create convention auditor module (AC: #15-#17)
  - [x] 10.1 Create `suites/_orchestrator/services/convention-auditor.ts` — scans all resources against convention rules
  - [x] 10.2 Suite audit checks: has suite.ts with `defineSuite()`, has mcp.json (even if empty `{}`), has actions.json, has agents/ directory, has UPDATE.md, kebab-case directory name, capabilities match actual files (e.g. `services` capability has services/ dir)
  - [x] 10.3 Pipeline audit checks: valid YAML parses against pipeline Zod schema, has trigger defined, all node skill references exist as registered suites, connections form valid DAG, has `version` field, `enabled` field present
  - [x] 10.4 Agent audit checks: name is kebab-case, has description, suite_ids reference existing suites, exactly one agent is `is_default`, instructions are non-empty for non-default agents
  - [x] 10.5 Schedule audit checks: valid cron expression, skillName references existing suite, taskType is non-empty, has unique ID
  - [x] 10.6 Return structured `ConventionAuditReport` with `{ violations: Array<{ resourceType, resourceName, rule, severity: 'error'|'warning', message, fix }>, compliantCount, totalChecked, checkedAt }`

- [x] Task 11: Integrate convention auditor into maintenance pipeline (AC: #15-#17)
  - [x] 11.1 Modify `maintenance-runner.ts`: add `auditConventions(suitesDir, configDir)` to the Phase 1 parallel data gathering alongside `analyzeLogs`, `checkDependencies`, `checkResources`, `checkSuiteUpdates`
  - [x] 11.2 Modify `maintenance-agent.ts`: add `buildConventionSection(auditReport)` — formats violations for the maintenance agent prompt, agent should suggest fixes and prioritize by severity
  - [x] 11.3 Modify `maintenance-report.ts`: add "Convention Compliance" section to the compiled report, listing violations grouped by resource type
  - [x] 11.4 Update `MaintenanceData` interface to include `conventionAuditReport: ConventionAuditReport`
  - [x] 11.5 Update maintenance agent output format instructions to include the new section

- [x] Task 12: Wire conventions into config-manager agent (AC: #13, #14)
  - [x] 12.1 Update config-manager agent prompt builder (Task 1) to read and inject relevant convention documents based on the requested resource type — e.g. if creating a pipeline, include `pipeline-conventions.md` content in the agent prompt
  - [x] 12.2 For suite creation: ensure the agent generates UPDATE.md as part of the scaffold, following the template from `suite-conventions.md`
  - [x] 12.3 Add convention validation step in config-applier (Task 3): before presenting to user, run the generated config through the convention auditor's checks for that resource type; flag violations in the diff presentation

- [x] Task 13: Tests for conventions and auditor (AC: #13-#17)
  - [x] 13.1 Unit test: convention-auditor suite checks — mock filesystem with compliant/non-compliant suites, verify violation detection (5 tests)
  - [x] 13.2 Unit test: convention-auditor pipeline checks — mock pipeline configs, verify schema/DAG/reference validation (3 tests)
  - [x] 13.3 Unit test: convention-auditor agent checks — mock agent configs, verify naming/reference/default checks (3 tests)
  - [x] 13.4 Unit test: convention-auditor schedule checks — mock schedule configs, verify cron/reference validation (2 tests)
  - [x] 13.5 Unit test: maintenance integration — verify convention audit data flows through maintenance pipeline to report (2 tests)
  - [x] 13.6 Unit test: config-manager convention injection — verify agent prompt includes relevant convention doc content (2 tests)

## Dev Notes

### Architecture Pattern

This story creates a **conversational configuration management system** that lets the user create, edit, and delete all system configuration through natural language. The architecture follows the established orchestrator delegation model:

1. **User intent** — Orchestrator detects config management intent
2. **Delegation** — Orchestrator spawns config-manager sub-agent with current system state
3. **Generation** — Sub-agent produces structured change proposal (JSON with content/diff)
4. **Presentation** — Config-presenter formats for human review
5. **Approval** — Telegram inline keyboard or dashboard confirmation
6. **Application** — Config-applier validates and writes changes using existing infrastructure
7. **Commit** — Git auto-commit via existing `gitAutoCommit()`

**Key architectural decision**: The config-manager is a Claude sub-agent that receives the full schema documentation, current system state, AND relevant convention documents in its prompt. It generates config changes as structured output. The applier layer then uses existing CRUD infrastructure (pipeline engine, suite scaffolder, named agent store, scheduler) to apply changes — we do NOT write files directly when existing abstractions handle it.

**Convention-driven quality**: Convention documents (`suites/_orchestrator/conventions/*.md`) are the single source of truth for how each resource type should be structured. They serve two purposes: (1) injected into the config-manager agent prompt so generated configs are correct by construction, (2) used by the convention auditor to validate existing resources during maintenance runs. This creates a self-healing loop — conventions guide creation, audits catch drift.

**Maintenance integration**: The convention auditor runs as an additional data-gathering module in the existing `maintenance-runner.ts` Phase 1 (parallel with log analysis, dependency checking, etc.). Its output feeds into the maintenance agent prompt and appears in the final maintenance report. No new pipeline or schedule needed — it piggybacks on the existing weekly maintenance run.

**Alternative considered and rejected**: Having a single monolithic "config editor" service. Instead, we decompose into agent (generates) then presenter (formats) then applier (writes), keeping each concern isolated and testable.

### Source Tree Components

**New files:**
```
suites/_orchestrator/agents/config-manager.ts          — Agent definition + prompt builder
suites/_orchestrator/services/config-presenter.ts      — Change formatting + diff generation
suites/_orchestrator/services/config-applier.ts        — Change application using existing CRUD
suites/_orchestrator/services/config-approval-handler.ts — Approval lifecycle management
suites/_orchestrator/services/convention-auditor.ts    — Scans all resources against convention rules
suites/_orchestrator/conventions/pipeline-conventions.md  — Pipeline creation/maintenance best practices
suites/_orchestrator/conventions/suite-conventions.md     — Suite structure, required files, naming rules
suites/_orchestrator/conventions/agent-conventions.md     — Agent definition, prompt, model selection guide
suites/_orchestrator/conventions/schedule-conventions.md  — Cron patterns, naming, lifecycle rules
suites/_orchestrator/__tests__/config-management.test.ts  — Config management tests
suites/_orchestrator/__tests__/convention-auditor.test.ts — Convention auditor tests
packages/core/src/api/routes/config-changes.ts         — REST API for config changes
packages/core/src/db/migrations/XXX-pending-config-changes.sql — DB migration
packages/web/src/app/config/page.tsx                   — Dashboard config management page
```

**Modified files:**
```
packages/shared/src/types/events.ts                    — Add config change event types
packages/shared/src/suites/constants.ts                — Add config management constants
packages/shared/src/suites/index.ts                    — Export new constants
suites/_orchestrator/suite.ts                          — Register config-manager agent + services
suites/_orchestrator/services/maintenance-runner.ts    — Add convention audit to Phase 1 gathering
suites/_orchestrator/services/maintenance-agent.ts     — Add convention section to agent prompt
suites/_orchestrator/services/maintenance-report.ts    — Add Convention Compliance report section
suites/notifications/services/callback-handler.ts      — Add 'c:' domain callback handling
packages/core/src/orchestrator/orchestrator.ts         — Add config management delegation hints
packages/core/src/api/server.ts                        — Register config-changes routes
```

### Convention Documents — Living Quality Standards

Convention documents live at `suites/_orchestrator/conventions/` and serve as both agent instructions and audit rules. They are Markdown files read at runtime — editable without code changes.

**pipeline-conventions.md** should cover:
- Complete YAML schema reference with all field types and defaults
- Trigger types (cron, event, manual, webhook) with examples
- Node naming: kebab-case verb-noun (e.g. `fetch-emails`, `compile-briefing`)
- Pipeline naming: kebab-case describing the flow (e.g. `email-to-tasks`, `morning-briefing`)
- Connection patterns: linear, parallel fan-out, conditional routing
- Settings best practices: retry counts, timeouts, onError strategies
- Required fields: name, version, trigger, at least one node, enabled
- Anti-patterns: cycles, orphaned nodes, missing skill references

**suite-conventions.md** should cover:
- Required file checklist: `suite.ts`, `mcp.json`, `actions.json`, `agents/` dir, `UPDATE.md`
- `defineSuite()` fields: name (kebab-case, matches directory), displayName, description, capabilities, requiresEnv, services
- MCP config: env var resolution with `${VAR}` syntax, command/args format
- Action declarations: `suite-name:action-name` format, defaultTier rationale (green=safe/reversible, yellow=side-effects, red=irreversible/external)
- UPDATE.md template: Dependencies to Monitor (with changelog URLs), What to Verify (suite-specific health checks)
- Service interface: `start(ctx)` / `stop()` pattern, use ServiceContext for eventBus/db/logger access

**agent-conventions.md** should cover:
- `defineAgent()` fields: name (kebab-case), description, model, tools, mcpServers, maxTurns, prompt
- Model selection: `sonnet` for routine/high-volume tasks, `opus` for complex reasoning, `haiku` for simple extraction
- Prompt structure: role definition, available tools description, output format specification, constraints
- Tool patterns: `mcp__suitename__toolpattern__*` format, reference MCP keys from suite's mcp.json
- maxTurns guidance: 5 for simple, 10 for moderate, 25 for complex multi-step

**schedule-conventions.md** should cover:
- Cron patterns with human-readable examples: `0 8 * * *` (daily 8am), `0 */6 * * *` (every 6h), `0 8 * * 1-5` (weekdays 8am)
- Naming: human-readable description of what runs
- taskType: kebab-case, should match a known event handler
- skillName: must reference a registered suite name
- Pipeline triggers vs standalone schedules: pipelines have their own cron triggers; use schedules for non-pipeline recurring tasks
- Lifecycle: enabled/disabled toggle, manual trigger via API

### Convention Auditor Integration with Maintenance

The convention auditor plugs into the existing maintenance pipeline at three points:

1. **Data gathering** (`maintenance-runner.ts` line 84): Add `auditConventions(suitesDir, configDir)` to the `Promise.all()` call alongside `analyzeLogs`, `checkDependencies`, `checkResources`, `checkSuiteUpdates`

2. **Agent prompt** (`maintenance-agent.ts`): Add `buildConventionSection(conventionAuditReport)` to the sections array. Format violations as a list the agent can analyze and prioritize, suggest fixes, and flag critical vs warning severity.

3. **Report output** (`maintenance-report.ts`): Add a "Convention Compliance" section after "Suite Suggestions" in the output format. Group violations by resource type, show compliance percentage.

The auditor reads convention documents from disk at runtime, so updating a convention doc immediately affects the next maintenance run — no code changes or restarts needed.

### Existing Infrastructure to Reuse

| What | Where | How |
|------|-------|-----|
| Pipeline CRUD | `pipeline-engine.ts` | `savePipeline()`, `deletePipeline()` — handles YAML write + DAG validation + git commit |
| Suite scaffolder | `suite-scaffolder.ts` | `scaffoldSuite()` — creates full suite structure + config entry + git commit |
| Named agent store | `named-agent-store.ts` | `create()`, `update()`, `delete()` — handles DB + JSON sync + event emission + git commit |
| Schedule config | `config/schedules.json` | Read/write JSON + scheduler reload |
| Git auto-commit | `git-commit.ts` | `gitAutoCommit(filePaths, message)` — non-blocking, fire-and-forget |
| Telegram inline keyboards | `callback-handler.ts` | Existing callback routing by domain prefix (`a:` approvals, `t:` tasks) — add `c:` for config |
| Pending approvals pattern | `pending-approvals.ts` | DB-backed approval queue — replicate pattern for `pending_config_changes` |
| Event bus | `packages/core/src/event-bus/` | Emit config change events |
| Agent definitions | `defineAgent()` from `@raven/shared` | Standard agent definition pattern |
| Config reload | Permission engine pattern | `fs.watch` + event emission for config changes |
| createLogger | `@raven/shared` | All new modules use structured Pino logging |
| generateId | `@raven/shared` | `crypto.randomUUID()` for IDs |
| Zod validation | `@raven/shared` / `zod` | Validate all generated configs before applying |

### Config Schemas the Agent Must Know

**Pipeline YAML** (from architecture doc):
```yaml
name: pipeline-name
version: 1
trigger: { type: cron|event|manual, schedule?: string, event?: string }
settings: { retry: { maxAttempts: 3, backoffMs: 5000 }, timeout: 600000, onError: stop|continue }
nodes: { node-id: { skill: suite-name, action: action-name, params: {} } }
connections: [{ from: node-id, to: node-id, condition?: string }]
enabled: true
```

**Suite Structure**:
```
suites/suite-name/
  suite.ts       -> defineSuite({ name, displayName, description, capabilities, requiresEnv?, services? })
  mcp.json       -> { mcpServers: { key: { command, args, env } } }
  actions.json   -> [{ name: 'suite:action', description, defaultTier, reversible }]
  agents/        -> defineAgent({ name, description, model, tools, mcpServers, maxTurns, prompt })
  services/      -> SuiteService: { start(ctx), stop() }
```

**Agent JSON** (config/agents.json):
```json
{ "id": "uuid", "name": "kebab-case", "description": "...", "instructions": "...", "suite_ids": ["suite1"], "is_default": false }
```

**Schedule JSON** (config/schedules.json):
```json
{ "id": "uuid", "name": "Human Name", "cron": "0 8 * * *", "taskType": "task-type", "skillName": "suite-name", "enabled": true }
```

### Telegram Message Format for Config Changes

Config change proposals should be formatted as:

```
Config Change Proposed

Action: Create pipeline
Resource: email-to-tasks

---
name: email-to-tasks
description: Check email hourly, create tasks from urgent
version: 1
trigger:
  type: cron
  schedule: "0 * * * *"
...
---

[Apply] [Edit] [Discard]
```

For updates, show unified diff format:
```
Config Change Proposed

Action: Update pipeline
Resource: morning-briefing

--- current
+++ proposed
@@ trigger @@
-  schedule: "0 6 * * *"
+  schedule: "0 9 * * 1-5"

[Apply] [Edit] [Discard]
```

### Callback Data Format

Following the existing 64-byte limit convention:
- `c:a:{changeId}` — apply (approve)
- `c:e:{changeId}` — edit (request modifications)
- `c:d:{changeId}` — discard (reject)

The `changeId` should be a short UUID (first 8 chars of full UUID) to fit within 64 bytes.

### Previous Story Intelligence (10.4)

Key patterns from story 10.4:
- **Service orchestration**: Maintenance-runner service handles the full flow (gather then analyze then compile then deliver) — config-applier should similarly orchestrate the full apply flow
- **Two-layer design**: TypeScript data layer + Claude agent analysis layer — same pattern here: agent generates, TypeScript applies
- **Fallback handling**: If agent fails, provide deterministic fallback — if config-manager agent fails, inform user rather than silently dropping
- **Telegram truncation**: Messages > 3800 chars truncated — apply same limit to config diffs, link to dashboard for full view
- **Event emission pattern**: `generateId()` for ID, `Date.now()` for timestamp, `source: 'config-manager'`
- **Testing pattern**: Mock Claude SDK, mock filesystem, use `vi.mock()` for module-level mocks

### Anti-Patterns to Avoid

- Do NOT write pipeline YAML files directly — use `savePipeline()` from pipeline engine (handles validation + git)
- Do NOT insert agent records directly in DB — use named agent store's `create()` (handles sync + events + git)
- Do NOT bypass Zod validation — all generated configs must pass schema validation before presenting to user
- Do NOT auto-apply without user confirmation — EVERY change must go through the approval flow
- Do NOT load MCPs on the config-manager agent — it receives system state in prompt, delegates via existing CRUD
- Do NOT create a new suite for config management — it belongs in `_orchestrator`
- Do NOT use `console.log` — use `createLogger()` from `@raven/shared`
- Do NOT add `.js` import extensions — use `.ts` (rewritten by compiler)
- Do NOT use `child_process.exec()` — use `execFile` from `node:child_process` to prevent shell injection

### Testing Standards

- Framework: Vitest 4 with `test.projects` config
- Test locations:
  - `suites/_orchestrator/__tests__/config-management.test.ts` — config manager, presenter, applier, approval handler, API routes
  - `suites/_orchestrator/__tests__/convention-auditor.test.ts` — convention auditor checks, maintenance integration
- Mock Claude SDK — never spawn real subprocesses
- Mock filesystem operations for suite scaffolding and convention doc reading
- Mock pipeline engine, named agent store, scheduler for applier tests
- Mock Telegram bot for approval handler tests
- For convention auditor: create temp directory trees with compliant/non-compliant suites, pipelines, agents, schedules
- Use `vi.mock()` for module-level mocks, `vi.fn()` for function mocks
- Temp SQLite DBs via `mkdtempSync` for DB tests
- Clean up in `afterEach`

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Epic 10, Story 10.5]
- [Source: _bmad-output/planning-artifacts/architecture.md#Pipeline Architecture]
- [Source: _bmad-output/planning-artifacts/architecture.md#Skill Extensibility]
- [Source: _bmad-output/planning-artifacts/prd.md#FR17 Conversational Pipeline Creation]
- [Source: _bmad-output/planning-artifacts/prd.md#FR54-58 Skill Extensibility]
- [Source: packages/core/src/pipeline-engine/ — pipeline CRUD infrastructure]
- [Source: packages/core/src/suite-registry/suite-scaffolder.ts — suite scaffolding]
- [Source: packages/core/src/agent-registry/named-agent-store.ts — agent CRUD]
- [Source: suites/notifications/services/callback-handler.ts — Telegram callback routing]
- [Source: suites/_orchestrator/ — orchestrator suite pattern]

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6 (1M context)

### Debug Log References

### Completion Notes List

- All 13 tasks completed with 28 new tests passing (50 total in orchestrator suite)
- Config-manager agent with dynamic prompt builder supporting convention doc injection
- Config presenter with simple line-by-line diff generation
- Config applier delegates to existing CRUD infrastructure (pipeline engine, suite scaffolder, named agent store, scheduler)
- Telegram approval flow with `c:` domain callback routing (apply/edit/discard)
- Dashboard config page with real-time SSE updates and approve/discard actions
- Convention documents (pipeline, suite, agent, schedule) as living Markdown standards
- Convention auditor scans suites, pipelines, agents, schedules for compliance
- Maintenance pipeline integration: auditor runs in Phase 1 parallel, feeds agent prompt + report
- Pre-existing test failures (knowledge-*, email-triage) unrelated to changes

### Change Log

- 2026-03-22: Story 10.5 implementation complete — all 13 tasks, 28 new tests
- 2026-03-22: Code review fixes applied — 3 critical, 2 high, 2 medium issues resolved:
  - C1: Added Zod/YAML validation in config-applier before applying (Task 3.7)
  - C2: Fixed handleConfigAction to call configChangeResolver instead of emitting dummy events (Task 4.6)
  - C3: Added convention validation (kebab-case, cron, JSON structure) in config-applier (Task 12.3)
  - H1: Deduplicated PendingConfigChange/PendingConfigChangeRow/mapRow → shared package
  - H2: Replaced hardcoded 'Europe/Kyiv' timezone with parsed.timezone ?? TZ env ?? 'UTC'
  - M1: Deleted 12 leaked build artifacts, added suites/**/*.{js,d.ts,js.map,d.ts.map} to .gitignore
  - M2: Fixed migration SQL comment to include 'view' action type
- 2026-03-22: Second code review fixes — 2 high, 2 medium issues:
  - H1: Added missing `timezone?: string` to both schedule type casts in config-applier.ts
  - H2: Reordered schedule update to parse/validate content before deleting old schedule (atomic safety)
  - M1: Deduplicated `ConfigChangeResolver` interface → shared package, imported in callback-handler.ts and config-changes.ts
  - M2: Improved short-ID LIKE query to prefer pending records, reducing collision risk

### File List

New files:
- suites/_orchestrator/agents/config-manager.ts
- suites/_orchestrator/services/config-presenter.ts
- suites/_orchestrator/services/config-applier.ts
- suites/_orchestrator/services/config-approval-handler.ts
- suites/_orchestrator/services/convention-auditor.ts
- suites/_orchestrator/conventions/pipeline-conventions.md
- suites/_orchestrator/conventions/suite-conventions.md
- suites/_orchestrator/conventions/agent-conventions.md
- suites/_orchestrator/conventions/schedule-conventions.md
- suites/_orchestrator/__tests__/config-management.test.ts
- suites/_orchestrator/__tests__/convention-auditor.test.ts
- packages/core/src/api/routes/config-changes.ts
- packages/web/src/app/config/page.tsx
- migrations/018-pending-config-changes.sql

Modified files:
- .gitignore
- packages/shared/src/types/events.ts
- packages/shared/src/suites/constants.ts
- packages/shared/src/suites/index.ts
- suites/_orchestrator/suite.ts
- suites/_orchestrator/agents/raven-orchestrator.ts
- suites/_orchestrator/services/maintenance-runner.ts
- suites/_orchestrator/services/maintenance-agent.ts
- suites/_orchestrator/services/maintenance-report.ts
- suites/notifications/services/callback-handler.ts
- packages/core/src/api/server.ts
- _bmad-output/implementation-artifacts/sprint-status.yaml
