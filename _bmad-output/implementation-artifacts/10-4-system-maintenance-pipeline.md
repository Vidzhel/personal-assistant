# Story 10.4: System Maintenance Pipeline

Status: done

## Story

As the system operator,
I want Raven to periodically self-inspect and report on system health, outdated packages, and improvement opportunities,
So that the system stays healthy without me having to manually audit it.

## Acceptance Criteria

1. **Given** the maintenance pipeline is configured **When** its schedule triggers (default: weekly Sunday 2am, configurable via `config/schedules.json`) **Then** it launches a maintenance agent that performs a full system review
2. **Given** the maintenance agent runs **When** it inspects logs **Then** it identifies recurring errors, silent failures, and degraded services from the last period
3. **Given** the maintenance agent runs **When** it checks dependencies **Then** it reports packages with available updates, distinguishing patch/minor/major and flagging security advisories
4. **Given** the maintenance agent runs **When** it reviews the suite ecosystem **Then** it suggests new suites or MCP integrations based on detected usage patterns and available MCP servers
5. **Given** the maintenance agent runs **When** it checks system resource usage **Then** it reports on database size, log volume, and any resource concerns
6. **Given** the maintenance report is generated **When** it is delivered **Then** it is posted to the Raven Telegram supergroup as a formatted summary with sections: Issues Found, Package Updates, Suite Suggestions, Resource Status
7. **Given** each suite has a `suites/<name>/UPDATE.md` file **When** the maintenance agent reviews a suite **Then** it reads `UPDATE.md` for instructions on where to check for API changes, version updates, and migration steps specific to that suite's external dependencies
8. **Given** the user says "Run maintenance now" or "Change maintenance to daily" **When** the command is processed **Then** the schedule is updated or an immediate run is triggered
9. **Given** the maintenance agent encounters recurring errors or degraded services **When** it analyzes them **Then** it searches the web for known fixes, alternative approaches, and best practices others use for the same problem (e.g. Stack Overflow, GitHub issues, blog posts)
10. **Given** the maintenance agent reviews the suite ecosystem **When** it looks for improvement opportunities **Then** it searches GitHub for relevant MCP servers, automation tools, and integration packages that could extend Raven's capabilities based on current usage patterns and installed suites
11. **Given** the maintenance agent checks dependencies **When** it finds outdated or vulnerable packages **Then** it searches for migration guides, changelog highlights, and community reports of breaking changes before recommending upgrades

## Tasks / Subtasks

- [x] Task 1: Create maintenance pipeline YAML (AC: #1, #8)
  - [x] 1.1 Create `config/pipelines/system-maintenance.yaml` with weekly cron trigger
  - [x] 1.2 Define pipeline nodes: single `run-maintenance` node (simplified — maintenance-runner service handles full orchestration)
  - [x] 1.3 Add schedule entry to `config/schedules.json` for maintenance

- [x] Task 2: Create maintenance orchestration agent prompt (AC: #1, #2, #3, #4, #5, #6, #7, #9, #10, #11)
  - [x] 2.1 Create `suites/_orchestrator/services/maintenance-agent.ts` — builds the comprehensive prompt for the maintenance sub-agent
  - [x] 2.2 Prompt includes all gathered system data (logs, dependencies, resources, suite updates)
  - [x] 2.3 Prompt must instruct agent to use web search for: fixes to recurring errors, alternative approaches from the community, GitHub MCP servers/tools that could extend capabilities, migration guides for outdated packages
  - [x] 2.4 Agent output must be structured Markdown with sections: Issues Found (with web-sourced fixes), Package Updates (with migration notes), Suite Suggestions (with GitHub links), Resource Status

- [x] Task 3: Implement log analysis module (AC: #2)
  - [x] 3.1 Create `suites/_orchestrator/services/log-analyzer.ts` — reads recent log files from `data/logs/`, extracts error/warn entries from last 7 days
  - [x] 3.2 Group recurring errors by component and message pattern, count occurrences
  - [x] 3.3 Detect silent failures: services that stopped emitting logs (expected active but no recent entries)

- [x] Task 4: Implement dependency checker (AC: #3)
  - [x] 4.1 Create `suites/_orchestrator/services/dependency-checker.ts` — runs `npm outdated --json` and `npm audit --json` via `execFile` (use `node:child_process` `execFile`, NOT `exec`, to prevent shell injection)
  - [x] 4.2 Parse output to categorize: patch (safe), minor (review), major (breaking), security (urgent)
  - [x] 4.3 Return structured report with package name, current version, latest version, update type, advisory details

- [x] Task 5: Implement resource monitor (AC: #5)
  - [x] 5.1 Create `suites/_orchestrator/services/resource-monitor.ts` — checks `data/raven.db` size, `data/logs/` total size, `data/sessions/` total size
  - [x] 5.2 Call health endpoint (`GET /api/health`) for current subsystem status, memory, task stats
  - [x] 5.3 Flag concerns: DB > 500MB, logs > 1GB, heap > 80% of total, failure rate > 10%

- [x] Task 6: Implement suite update checker (AC: #4, #7, #10)
  - [x] 6.1 Create `suites/_orchestrator/services/suite-update-checker.ts` — scans `suites/*/UPDATE.md` for update instructions
  - [x] 6.2 For each suite with UPDATE.md, extract: what to check, where to check, last known version
  - [x] 6.3 List suites without UPDATE.md as needing one created
  - [x] 6.4 Provide current suite list and usage context to the maintenance agent so it can search GitHub for complementary MCP servers and integration tools

- [x] Task 7: Create report compiler and delivery (AC: #6)
  - [x] 7.1 Create `suites/_orchestrator/services/maintenance-report.ts` — compiles all module outputs into structured Markdown report
  - [x] 7.2 Emit `maintenance:report:generated` event with report payload
  - [x] 7.3 Store report in `data/maintenance-reports/YYYY-MM-DD.md` for history
  - [x] 7.4 Deliver via Telegram notification to Raven System topic using existing notification event

- [x] Task 8: Wire pipeline trigger and manual invocation (AC: #1, #8)
  - [x] 8.1 Created maintenance-runner service that listens for `maintenance:run` action, triggers full maintenance flow; pipeline triggers via `POST /api/pipelines/system-maintenance/trigger`
  - [x] 8.2 Meta-project agent already has pipeline/schedule API access for schedule changes; orchestrator suite registered with services capability

- [x] Task 9: Create UPDATE.md templates for existing suites (AC: #7)
  - [x] 9.1 Create `suites/notifications/UPDATE.md` — grammy bot framework, Telegram Bot API changes
  - [x] 9.2 Create `suites/email/UPDATE.md` — Gmail API, IMAP protocol changes
  - [x] 9.3 Create `suites/task-management/UPDATE.md` — TickTick API changes
  - [x] 9.4 Create `suites/financial-tracking/UPDATE.md` — Monobank/PrivatBank API changes
  - [x] 9.5 Create `suites/google-workspace/UPDATE.md` — Google Workspace API changes

- [x] Task 10: Tests (all ACs)
  - [x] 10.1 Unit test: log-analyzer — mock log file content, verify error grouping and silent failure detection (6 tests)
  - [x] 10.2 Unit test: dependency-checker — mock `npm outdated`/`npm audit` output, verify categorization (2 tests)
  - [x] 10.3 Unit test: resource-monitor — mock file sizes and health endpoint, verify threshold flagging (3 tests)
  - [x] 10.4 Unit test: suite-update-checker — mock filesystem with/without UPDATE.md files (3 tests)
  - [x] 10.5 Unit test: maintenance-report — verify compiled report structure, event emission, notification (5 tests)
  - [x] 10.6 Unit test: maintenance-agent prompt builder — verify prompt structure (2 tests)
  - [x] 10.7 Integration test: maintenance-runner service — verify event handler registration (1 test)

## Dev Notes

### Architecture Pattern

This story creates a **pipeline-driven maintenance system** using the existing pipeline engine infrastructure. The maintenance pipeline is a standard YAML pipeline that triggers a maintenance sub-agent through the orchestrator's existing delegation model.

**Key architectural decision**: The maintenance agent is a Claude sub-agent spawned via `query()` that receives a carefully crafted prompt containing system data (logs, dependency info, resource stats). The agent analyzes this data, **searches the web** for fixes/alternatives/new tools, and produces a structured report. Pre-gathered system data is passed in the prompt; the agent uses its own web search capability for external research.

**Web research is part of the agent's analysis**, not the data gathering layer. The TypeScript modules collect local system state; the Claude agent then uses web search to contextualize findings — looking up error fixes, searching GitHub for MCP servers and integrations, finding migration guides for outdated packages. This keeps the data gathering layer simple and deterministic while leveraging the agent's ability to search and reason about external information.

**Alternative considered and rejected**: Having the data gathering layer do web requests. This would add complexity and coupling to what should be simple data collection modules. The Claude agent is better suited to formulating search queries based on the specific issues it finds.

### Implementation Approach

The maintenance system has two layers:

1. **Data gathering layer** (TypeScript modules in `suites/_orchestrator/services/`) — these run synchronously to collect system data: parse logs, run npm commands, check file sizes, read UPDATE.md files
2. **Analysis layer** (Claude sub-agent) — receives gathered data as structured prompt context, produces human-readable analysis with recommendations

The pipeline orchestrates this: gather -> analyze -> compile -> deliver.

### Source Tree Components

**New files:**
```
config/pipelines/system-maintenance.yaml          — Pipeline definition
suites/_orchestrator/services/maintenance-agent.ts — Agent prompt builder
suites/_orchestrator/services/log-analyzer.ts      — Log parsing & error grouping
suites/_orchestrator/services/dependency-checker.ts — npm outdated/audit wrapper
suites/_orchestrator/services/resource-monitor.ts  — DB/log/memory size checks
suites/_orchestrator/services/suite-update-checker.ts — UPDATE.md scanner
suites/_orchestrator/services/maintenance-report.ts — Report compiler
suites/_orchestrator/__tests__/maintenance.test.ts — Tests
suites/notifications/UPDATE.md                     — Suite update instructions
suites/email/UPDATE.md                             — Suite update instructions
suites/task-management/UPDATE.md                   — Suite update instructions
suites/financial-tracking/UPDATE.md                — Suite update instructions
suites/google-workspace/UPDATE.md                  — Suite update instructions
data/maintenance-reports/                          — Report storage (gitignored)
```

**Modified files:**
```
config/schedules.json                              — Add maintenance schedule entry
packages/shared/src/types/events.ts                — Add maintenance:report:generated event type
packages/shared/src/suites/constants.ts            — Add SUITE_ORCHESTRATOR if not present
```

### Project Structure Notes

- Maintenance services live in `suites/_orchestrator/services/` because they are system-level orchestration capabilities, not a standalone suite
- The `_orchestrator` suite already exists at `suites/_orchestrator/` — this is the correct home for system-level services
- Pipeline YAML goes in `config/pipelines/` alongside `morning-briefing.yaml`
- Report storage at `data/maintenance-reports/` follows the `data/` convention for runtime state
- Tests follow existing pattern: `suites/_orchestrator/__tests__/maintenance.test.ts`

### Existing Infrastructure to Reuse

| What | Where | How |
|------|-------|-----|
| Pipeline engine | `packages/core/src/pipeline-engine/` | Standard YAML pipeline, triggered by cron |
| Pipeline scheduler | `pipeline-scheduler.ts` | Registers cron from pipeline YAML trigger |
| Pipeline trigger API | `POST /api/pipelines/:name/trigger` | Manual "run maintenance now" |
| Health endpoint | `GET /api/health` | Resource monitor calls this for subsystem status |
| Execution logger | `agent-manager/execution-logger.ts` | `getTaskStats()` for failure rates |
| Telegram notifications | `telegram:send-notification` action | Deliver report to Raven System topic |
| Event bus | `packages/core/src/event-bus/` | Emit `maintenance:report:generated` |
| Meta-project | `project-manager/meta-project.ts` | Maintenance runs under meta-project context |
| `createLogger` | `@raven/shared` | All new modules use structured Pino logging |
| `generateId` | `@raven/shared` | `crypto.randomUUID()` for IDs |
| `getDb()` | `packages/core/src/db/database.ts` | DB access if needed |
| `execFile` | `node:child_process` | Run `npm outdated`/`npm audit` safely (NOT `exec` — prevents shell injection) |
| Existing schedules | `config/schedules.json` | Pattern for adding maintenance schedule |

### Testing Standards

- Framework: Vitest 4 with `test.projects` config
- Test location: `suites/_orchestrator/__tests__/maintenance.test.ts`
- Mock Claude SDK — never spawn real subprocesses
- Mock `execFile` for npm commands — provide canned JSON output
- Mock filesystem reads for log files and UPDATE.md
- Use `vi.mock()` for module-level mocks, `vi.fn()` for function mocks
- Temp directories via `mkdtempSync` if needed for report storage tests
- Clean up in `afterEach`

### Anti-Patterns to Avoid

- Do NOT use `child_process.exec()` — use `execFile` from `node:child_process` to prevent shell injection
- Do NOT spawn the maintenance agent with MCP servers — it receives data in prompt
- Do NOT read the entire SQLite database file into memory — use `statSync` for size
- Do NOT parse logs by reading entire files — use line-by-line streaming or tail last N lines
- Do NOT hardcode thresholds — define as constants at module top
- Do NOT create a new suite for maintenance — it belongs in `_orchestrator`
- Do NOT import `better-sqlite3` directly — use `getDb()` from `database.ts`
- Do NOT use `console.log` — use `createLogger()` from `@raven/shared`
- Do NOT add `.js` import extensions — use `.ts` (rewritten by compiler)

### Previous Story Intelligence (10.3)

Key patterns established in story 10.3 to follow:
- **Meta-project integration**: Maintenance runs under meta-project context with `system_access: "read-write"`
- **Event emission pattern**: Emit events with `generateId()` for ID, `Date.now()` for timestamp, `source: 'maintenance'`
- **Audit logging**: Use `createAuditLog(db).insert()` for recording maintenance runs
- **Prompt layering**: Meta-project agents receive API endpoint documentation — maintenance agent can trigger pipelines and read system state
- **Telegram routing**: Meta-project messages route to "Raven System" topic — maintenance reports go there
- **Zod validation**: All inputs validated with `safeParse()` at boundaries

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Epic 10, Story 10.4]
- [Source: _bmad-output/planning-artifacts/architecture.md#Pipeline Architecture]
- [Source: _bmad-output/planning-artifacts/prd.md#FR65 System Health Monitoring]
- [Source: config/pipelines/morning-briefing.yaml — pipeline YAML pattern]
- [Source: packages/core/src/pipeline-engine/ — all pipeline infrastructure]
- [Source: packages/core/src/api/routes/health.ts — health endpoint structure]
- [Source: suites/_orchestrator/ — orchestrator suite pattern]
- [Source: suites/notifications/services/telegram-bot.ts — Telegram notification delivery]

## Dev Agent Record

### Agent Model Used
Claude Opus 4.6 (1M context)

### Debug Log References
- All 22 tests pass: `npx vitest run suites/_orchestrator/__tests__/maintenance.test.ts`
- `npm run build -w packages/shared` and `npm run build -w packages/core` compile cleanly
- No lint errors from new files (`npm run check` — existing web package errors only)
- Formatting verified via Prettier

### Completion Notes List
- **Architecture decision**: Simplified pipeline to single `run-maintenance` node. The maintenance-runner service handles the full orchestration (gather → analyze → compile → deliver) rather than having multiple pipeline nodes each spawn an agent. This is more efficient and avoids spawning 6 separate agent tasks.
- **Two-layer design implemented**: TypeScript data gathering modules run in parallel (log-analyzer, dependency-checker, resource-monitor, suite-update-checker), then their output is compiled into a prompt for a Claude sub-agent that does web-based analysis and produces the final report.
- **Fallback report**: If the Claude sub-agent times out or fails, a deterministic fallback report is generated from the raw data.
- **Telegram truncation**: Reports longer than 3800 chars are truncated for Telegram delivery; full report is always saved to `data/maintenance-reports/`.
- **Service registration**: Orchestrator suite updated with `services: ['maintenance-runner']` and `capabilities: ['services']`.
- **Event type added**: `maintenance:report:generated` event type with Zod schema, exported from `@raven/shared`.

### Change Log
- 2026-03-22: Implemented story 10.4 — all 10 tasks complete, 22 tests passing

### File List
**New files:**
- `config/pipelines/system-maintenance.yaml` — Pipeline definition (weekly Sunday 2am cron)
- `suites/_orchestrator/services/maintenance-agent.ts` — Agent prompt builder
- `suites/_orchestrator/services/log-analyzer.ts` — Log parsing & error grouping
- `suites/_orchestrator/services/dependency-checker.ts` — npm outdated/audit wrapper
- `suites/_orchestrator/services/resource-monitor.ts` — DB/log/memory size checks
- `suites/_orchestrator/services/suite-update-checker.ts` — UPDATE.md scanner
- `suites/_orchestrator/services/maintenance-report.ts` — Report compiler & delivery
- `suites/_orchestrator/services/maintenance-runner.ts` — Service orchestrator (gather → analyze → compile → deliver)
- `suites/_orchestrator/__tests__/maintenance.test.ts` — 22 tests
- `suites/notifications/UPDATE.md` — Suite update instructions
- `suites/email/UPDATE.md` — Suite update instructions
- `suites/task-management/UPDATE.md` — Suite update instructions
- `suites/financial-tracking/UPDATE.md` — Suite update instructions
- `suites/google-workspace/UPDATE.md` — Suite update instructions

**Modified files:**
- `config/schedules.json` — Added system-maintenance schedule entry
- `packages/shared/src/types/events.ts` — Added MaintenanceReportGeneratedEvent interface and schema
- `packages/shared/src/suites/constants.ts` — Added EVENT_MAINTENANCE_REPORT_GENERATED, SOURCE_MAINTENANCE
- `packages/shared/src/suites/index.ts` — Exported new constants
- `suites/_orchestrator/suite.ts` — Added services capability and maintenance-runner service
