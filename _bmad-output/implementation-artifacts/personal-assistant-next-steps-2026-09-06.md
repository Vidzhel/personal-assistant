# Personal assistant delivery queue — September 6, 2026

Companion to the [product and architecture plan](../../docs/assessments/2026-09-06-personal-assistant-roadmap.md).
The owner requested assessment, a creative plan, integration research and SDK
maintenance. Feature work below is proposed; do not interpret the queue as a
claim of delivery. F1–F9/W1 stay complete. No legacy migration is required.

## Owner implementation decision

The owner subsequently authorized the first three P0 **product priorities**:
project Telegram (T0/T1), session model/thinking controls (M0), and readiness/phone
access (O0), plus the official TickTick MCP and effective usage skills (A2).
Implement and review these sequentially, committing/pushing completed slices.
The [Telegram specification](tech-spec-p0-project-telegram.md) starts execution.
Implementation drafts are prepared for [session controls](tech-spec-p0-session-models.md),
[readiness and phone access](tech-spec-p0-readiness-phone.md), and the
[official TickTick integration](tech-spec-p0-official-ticktick.md).
Plan the remaining product work after these deliverables.

Preserve the owner's clarification for that later planning: TickTick is the
planning authority, including work-related workload; Raven should help the owner
plan and manage calendar commitments with an understanding of that workload.
Linked knowledge should span all areas of life and be created and maintained by
project agents. Learned planning preferences are one part of that knowledge, not
a separate planning-only profile. Retrospectives should learn from experience
and ask useful follow-up questions. Capture represents incoming material awaiting
processing, not a replacement or competing store for linked knowledge. No inbox,
workload reorganization or broader memory redesign is implemented under this P0
scope, and live task changes require the owner's actual planning request.

## Release sequence

Estimates are focused engineering days including review and relevant tests, with
uncertainty for provider behavior. They are not commitments or a sum to schedule
blindly. Ship a usable vertical slice before starting its successor. Cheap agents
may implement independent pieces; the parent reviews the actual diff and outcomes.

| Order | Item                                                  | Priority                          | Effort                       | Depends on                                  | State                                                       |
| ----- | ----------------------------------------------------- | --------------------------------- | ---------------------------- | ------------------------------------------- | ----------------------------------------------------------- |
| 1     | A0: narrow SDK maintenance                            | P0                                | 1–2 days                     | Existing SDK contract tests                 | Complete; validated review image, not deployed              |
| 2     | T0: delivery truth and message ownership              | P0                                | 2–4 days                     | Current notification/session paths          | Complete; reviewed and tested                       |
| 3     | T1: project topics and session continuity             | P0                                | 3–5 days                     | T0                                          | Complete; reviewed and tested                       |
| 4     | M0: next-turn model/effort controls                   | P0                                | 3–5 days                     | A0                                          | Complete; reviewed and tested                          |
| 5     | O0: readiness and reliable phone access               | P0                                | 2–4 days                     | T0 for delivery diagnostics                 | Complete; reviewed and tested                          |
| 6     | A1: repair skills maintenance and integration catalog | P0                                | 1–3 days                     | Capability library                          | Ready to specify                                            |
| 7     | A2: official TickTick compatibility trial             | P0/P1                             | 2–4 days                     | A1; deliberate account setup for live phase | Official endpoint and tools verified; runtime trial pending |
| 8     | C0: durable capture inbox and source links            | P1                                | 3–5 days                     | T1, O0                                      | Proposed                                                    |
| 9     | U0: personal context and correction                   | P1                                | 3–5 days                     | C0; project memory                          | Proposed                                                    |
| 10    | D0: Today, commitments and one daily brief            | P1                                | 3–5 days                     | T1, C0, useful account reads                | Proposed                                                    |
| 11    | R0: routine contract repairs                          | P1; blocking unattended expansion | 3–6 days                     | Current engine/registries                   | Source findings below                                       |
| 12    | W0: native SDK workflow comparison                    | P1                                | 1–3 days, bounded experiment | A0, R0 baseline                             | Proposed                                                    |
| 13    | L0: dissertation and teaching packs                   | P1                                | 3–6 days per pack            | M0, O0, verification skills                 | Proposed                                                    |
| 14    | D1: weekly review and flexible calendar               | P1                                | 3–5 days                     | D0, U0, calendar connection                 | Proposed                                                    |
| 15    | R1: teach and evolve a recurring process              | P1/P2                             | 3–6 days                     | R0, W0 decision, one successful pack        | Proposed                                                    |
| 16    | L1: meetings and wider life packs                     | P2                                | 2–5 days per selected pack   | C0, U0, delivery and required connectors    | Proposed                                                    |

The first useful release is T0/T1/M0 with the small A0 maintenance change. Phone
access should accompany it if the owner wants remote artifacts immediately.
R0 fixes should precede enabling additional unattended routines. A2 can proceed
as a separate compatibility investigation; a new TickTick transport is not a
prerequisite for improving the existing local integration.

## Maintenance inventory and decisions

Versions were inspected locally and checked against official releases or public
package metadata on September 6. Recheck before a later implementation.

The direct npm registry check returned SDK `0.3.263`, MCP SDK `1.30.0` and gws
`0.22.5`. The fetched official Agent SDK changelog/release page still ended at
`0.3.261`. A0 deliberately pins that reviewed release; it does not claim to install
the newest npm tag. Follow up on `0.3.263` when its release changes can be assessed,
then apply the same SDK contract and clean-install gates.
[SDK registry metadata](https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk/latest),
[official changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md).

| Component                        | Observed baseline                                                           | Verified candidate / decision                                                                                                                                                                                                                                                                                        |
| -------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Agent SDK                 | `0.3.224`, upgraded in `d5518aa` on August 7; bundles Claude Code `2.1.224` | Upgrade to `0.3.261`, released September 4, with Claude Code `2.1.261` parity. Its fixes include plugin initialization delivery and disposal behavior in older Node VM contexts. [Release](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.261)                                          |
| Anthropic Messages SDK peer      | Installed `0.115.0`; Raven does not directly import it                      | Audit peer resolution during A0; do not introduce a second runtime client merely to change model settings                                                                                                                                                                                                            |
| MCP TypeScript SDK               | `@modelcontextprotocol/sdk` `1.30.0`                                        | Public package metadata still reports `1.30.0` for this package. The v2 split packages are a separate migration; v1.x continues to publish. [Versioning](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/VERSIONING.md), [v2](https://ts.sdk.modelcontextprotocol.io/v2/)                           |
| TickTick                         | In-repo stdio server with 17 tools and Open API v1 token authentication     | Official TickTick now advertises MCP. Compare the official offering before retiring the local adapter; do not assume parity from branding. [Homepage](https://ticktick.com/home), [official setup article](https://help.ticktick.com/articles/7438129581631995904)                                                   |
| Google Workspace CLI             | Host `gws 0.18.1`; the generic runtime image does not bundle it             | Evaluate `0.22.5` against the actual service commands in an isolated environment. Pre-v1 changes can break behavior; the repository says it is not an officially supported Google product. [Release](https://github.com/googleworkspace/cli/releases/tag/v0.22.5), [project](https://github.com/googleworkspace/cli) |
| General dependency security      | Reviewed September 5, not months ago                                        | Preserve the scoped Sharp override and dependency guard. Refresh audit metadata for new package changes; do not perform an unrelated major-version sweep. [Review](../../docs/assessments/2026-09-05-dependency-review.md)                                                                                           |
| Raven document/repository skills | Updated September 6 during W1                                               | Keep these current local workflows. Add missing use cases and actual runtime readiness rather than reinstalling everything                                                                                                                                                                                           |
| Vendor skill submodules          | Four pinned gitlinks are uninitialized in this checkout                     | Check selected upstream diffs/licenses and actual consumers before initializing or updating. A marketplace repository is not itself a usable, vetted runtime capability                                                                                                                                              |

**A0 acceptance:** review the exact manifest/lock diff; maintain Node 22 and npm
10.9.8; test real SDK serialization against a fake executable, first-turn Raven
MCP availability, scoped nested tools, cancellation/drain, budget settlement,
resume and workspace revisions. Pass required check, default tests, production
core build and compiled restart. Account-level model availability is a separate
canary. Keep the previous lock/image usable for rollback. Do not silently refresh
the owner's running test container as part of a planning task.

**A0 result:** exact `0.3.261` manifest/lock update complete. Required check,
2,467 default tests (6 explicit live skips), the 9-test real SDK subprocess
contract, production core build, compiled restart and a clean Docker image build
passed. The isolated image reports SDK/native package `0.3.261` and Claude Code
`2.1.261`. No runtime adapter changes or running-container replacement were needed.
See the [maintenance evidence](../../docs/assessments/2026-09-06-sdk-maintenance.md)
for scope and verification limits.

**A1 maintenance defect:** `scripts/update-gws-skills.sh` still writes to
`suites/google-workspace/skills-reference`, fetches unpinned `main`, expects the old
`docs/skills-index.md`, and implicitly runs `npm update -g`. No current runtime
consumer of that references directory was found. The upstream index is now
[docs/skills.md](https://github.com/googleworkspace/cli/blob/main/docs/skills.md).
Remove the obsolete command, or replace it with a pinned import into the actual
capability library with an explicit consumer. Stage downloads in a temporary
directory, validate the selected set, then replace atomically. Separate CLI
installation from reference updates. Test network failure, changed upstream
format, partial download and preservation of local skill edits.

The capability catalog should distinguish installed, executable available,
authenticated, configured for this project, and recently verified. Store upstream
revision/license and a small functional check for imported skills. Preview update
diffs and activate through the existing library reload path. Public deployment
seeds must be deliberately updated when a canonical shipped skill changes.

**A2 primary-source result:** public Chromium rendering of the official setup
article confirmed `https://mcp.ticktick.com`, Streamable HTTP (not SSE), OAuth and
Bearer authentication. The table lists 47 tools spanning tasks, lists, habits,
focus records, countdowns, tags, comments, sections and other operations. The
article describes automatic OAuth refresh with reauthorization after revocation
or long inactivity, and says advanced features remain unsupported. This is
documentation verification, not an authenticated tool-discovery or account test.
[Official TickTick MCP guide](https://help.ticktick.com/articles/7438129581631995904).

Prefer a migration toward the official service if the compatibility trial passes:
it offers meaningful whole-life capabilities absent from Raven's 17-tool adapter.
Keep one selected backend per connection; a temporary rollback option must not
send each action to both implementations.

**A2 TickTick compatibility:** Raven's MCP definitions currently require
`command/args/env`; its SDK supports HTTP MCP but the library schema and resolved
types do not expose that transport. Add a discriminated transport only if the
official service passes the trial. Credentials belong in the runtime secret store,
not project YAML or committed MCP headers. Evaluate unattended authentication,
refresh/expiry, rate limits, tool discovery and project scoping.

Compare all existing operations: list projects, create/update/archive-equivalent
behavior where available, open/completed tasks, due dates/timezones, filtering,
move/complete/delete, pagination and error results. Local TickTick skill actions
cover six named operations while the server exposes seventeen tools; review the
full tool-to-permission mapping and default behavior, including newly advertised
remote tools. Missing mappings are a compatibility issue to investigate, not
evidence of a confirmed permission bypass.

Test remote MCP with a local fake HTTP server before authenticating. For a later
owner-authorized account canary, use a dedicated temporary list with a known
cleanup plan, verify read-back after mutations, and record exact capabilities.
Cut over one implementation only when parity, auth and error behavior are known;
otherwise retain the local server and document missing official capabilities.

## Telegram and delivery slices

**T0 problem:** `sendMessageWithFallback()` in
`packages/core/src/services/notifications/telegram-bot.ts` catches both send
failures; `deliverTelegramNotification()` subsequently calls `markDelivered()`.
The completion listener also accepts general AgentManager completions without an
explicit originating Telegram address. These are source-confirmed paths; no live
Telegram message was sent during this assessment.

Propagate origin, project/session IDs, request/task ID and a transport reply
address through admission, run completion and notification delivery. Address a
specific Telegram chat/topic/message when appropriate. Keep notification policy
separate from origin: an explicitly configured background routine or browser task
may notify Telegram, but unrelated completions must not appear there by accident.

Return explicit send outcomes. Persist attempt/provider-message IDs and bounded
retries in the existing notification delivery path. An API success means Telegram
accepted the message, not that the owner read it. Timeout after possible acceptance
is unknown; reconcile where possible rather than promising exactly-once delivery.
Treat text and attachment outcomes separately. A stale-topic error must not
silently move a project conversation into General.

Expose failures and unknown attempts through the notification API/dashboard:
destination project, retry count, last error and provider message ID when known.
If T0/T1 require new operational columns or indexes, update
`migrations/001-initial-schema.sql` and fresh-schema fixtures together, preserving
atomic initialization. This is current-schema work, not a legacy migration project.

**T0 acceptance:** failed first/fallback send never marks delivery successful;
timeout retains unknown; partial attachment failure is visible; stop/restart keeps
pending attempts; web/background tasks need an explicit notification policy to
reach Telegram. Progress messages are correlated by request/task, including two
concurrent tasks in the same project and two in different projects.

**T1 problem:** persisted project topic bindings exist, but startup primarily
hydrates agent topics; routing also derives synthetic project IDs from topic
names and relies on in-memory maps. Incoming Telegram events lack explicit session
selection. Intents retain a source session but do not carry project routing into
their delivered reminder.

Reuse `telegram_topics` for unique chat/topic ↔ stable project bindings. Restore
them on startup; coordinate project rename/archive and topic deletion. Topic
creation may be lazy. Route unknown threads to a visible Inbox decision without
inventing another project. General is Inbox / Today. Retire agent-topic routing
when project routing replaces it; do not build two active routing schemes.

Bind Telegram input/replies to the existing Raven session model. Persist the
reply-to-message association and selected session. `/new` and `/model` affect that
session; worker names are message attribution. Carry project ownership through
intents, approvals and proactive producers. Remove hardcoded category destinations
as each producer adopts the common routing contract.

Inventory every notification and intent producer. Enforce that project-bound
messages carry the stable project ID; global/system messages declare their
destination explicitly. Test the producers as well as the central router so a
forgotten category route cannot reintroduce unrelated General posts.

**T1 acceptance:** rename/restart and equal display names preserve identity;
replying to an old result reaches its original session; new conversations retain
project memory; main and nested workers have accurate attribution; no unrelated
topic receives tool progress; intent replies/callbacks stay scoped; an isolated
mobile-viewport browser journey opens the resulting artifact through the existing
local test server and artifact route, without depending on O0's private endpoint.
Actual remote phone access is verified in O0. Support private bot chat with explicit
project selection when forum mode is unavailable.

## Model and readiness slices

**M0 implementation surface:** `packages/shared/src/types/agents.ts`,
`packages/shared/src/library/schemas.ts`, project/session settings, the resolver,
`BackendOptions`, SDK adapter, admission/budget/history, web composer and Telegram
commands. Skills also contain a closed model enum, so changing named-agent UI
alone is insufficient. Discover/cache model capabilities without a billable test
prompt; handle stale discovery and unavailable authentication explicitly.

Apply the precedence and presets in the product plan. A session change affects
newly admitted turns; already admitted work retains its configuration. Preserve
the Raven conversation across model changes and provider-session restarts.
Store selected and resolved model IDs, effort and thinking mode for diagnostics.
Do not display an off switch for mandatory thinking or silently substitute a
cheaper model. Existing budgets are estimates, not subscription billing limits.

**M0 acceptance:** UI and Telegram overrides agree; restart preserves selection;
invalid model/effort combinations reject before admission; nested workers inherit
the intended defaults; a queue holds its captured configuration; earlier context
survives switching; stale workspace access still blocks; cancellation and budget
settlement remain correct. Add current-account Fable availability only after an
explicit diagnostic/canary, not a hardcoded promise.

**O0 implementation:** a project readiness view for working directory, execution
mode, required executables, connected capabilities and accessible context indexes.
Expose sanitized recent failures and actionable corrections. Runtime-owned probes
should use disposable files and documented commands; no arbitrary model-generated
“health check.” Show unavailable optional capabilities without failing the whole
assistant. Provide a supported authenticated private HTTPS deployment with one
browser origin for API, WebSocket and file links; preserve loopback defaults.

**O0 acceptance:** missing mount, missing renderer, expired connector auth and
blocked tool settings are distinguishable; phone browser loads the app, sends a
message and opens/downloads the result through the private endpoint; unauthorized
requests and invalid origins fail; old localhost links do not leak into replies.
Include a backup/restore drill for current project files, operational data and
graph relationships as usage becomes valuable. This is future recovery, not a
legacy migration.

## Capture, memory and planning slices

**C0:** save original capture plus source identity before enrichment. Use existing
project files/task records for durable items and existing services for media.
Support correction/reclassification, source links, message batching and exact
deduplication. Link external TickTick/calendar objects rather than creating another
editable task/event authority. Test failed transcription, reconnect, duplicate
webhook/message, later correction and restart. A receipt must resolve to a saved
item even if the model is unavailable.

**U0:** store a compact personal profile as ordinary memory in a selected personal
project, with explicit sharing into other projects. Add fact provenance, observed
date, status and correction/supersession. Reuse candidates/consolidation and graph
membership; define which routines may propose memories. Test an outdated preference,
a conflicting source, “remember only here,” forgetting and stale derived content.
Explain what remains in transcripts/backups. Do not treat confidence as permission
to share private project content.

**D0:** unify commitments, scheduled time, running work, waiting items and decisions
as a projection over current authorities. Consolidate or clearly distinguish
`morning-digest` and `morning-briefing`; deliver actual findings and artifact links.
Prioritize decisions and deadlines instead of a wall of unread messages. Include
source timestamps and “unavailable” for failed inputs. Test stale/partial providers,
duplicate tasks, timezone boundaries and one final notification after retries.

**D1:** add weekly review, protected work blocks and flexible replanning within
standing calendar authority. Preview changes outside that authority. Test fixed
teaching sessions, deadlines, DST, travel timezones, external calendar edits and
insufficient available time. Evaluate whether suggestions help the owner over two
weeks; do not infer success from how many calendar events were created.

## Routine reliability and adaptive work

R0 findings below come from current source inspection. Add focused failing tests
before repair. These do not reopen the historical August engine failures.

| Finding                                                                               | Concrete resolution and acceptance                                                                                                                                                              |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Template event `filter` is schema-valid but unused by `template-scheduler.ts`         | Implement a bounded validated filter or reject it. An unrelated event must not start work; malformed filters must surface diagnostics                                                           |
| Event handlers capture templates at `start()`; registry reload does not refresh them  | Rebind through the existing lifecycle on activation. A changed/removed trigger takes effect without duplicate listeners or a process restart                                                    |
| `resyncScheduleEngine()` in `scaffold-and-activate.ts` supplies global schedules only | Wire project-scoped schedules with current project/template identity. Prove project rename, reload, disable and restart do not duplicate or misroute runs                                       |
| `plan.parallel: false` is not forwarded/enforced                                      | Enforce sequential admission or remove/reject the unsupported setting; do not advertise an ignored control                                                                                      |
| Runtime-output `forEach` is reduced to an unexpanded ordinary node                    | Fail explicitly until supported, or use a verified native workflow for dynamic expansion. Static parameter expansion already works and must remain covered                                      |
| Bridge fallback completion supplies `artifacts: []`                                   | Preserve verified registered artifacts/output references through runtime completion. The existing `complete_task` path already records real artifacts; test both paths and downstream retrieval |
| `needsReplan`/`NEEDS_REPLAN` has no complete runtime transition                       | Remove the misleading promise or provide a bounded operation after W0. A text marker must not imply that replanning occurred                                                                    |
| Schema permits `run.kind: agent`, while scheduling records it blocked                 | Implement through existing admission or reject unsupported definitions at validation with a clear correction                                                                                    |

**W0 experiment:** one synthetic research or document task, one outer Raven run,
bounded native SDK inner workflow. Verify current invocation requirements, native
tool availability, per-worker capabilities, meaningful progress/result reporting,
cost accounting and artifact evidence. Kill/restart at a controlled boundary;
establish exactly what can resume and what requires deliberate retry. Do not mark
the outer task complete while inner work is still running. Run against temporary
repositories with a fake executable where possible; a later live model experiment
needs a deliberately selected prompt/budget and account availability.

**Decision:** adopt native workflow execution if it reduces custom coordination
and satisfies the lifecycle contract. Otherwise retain normal tasks/trees; add
only the missing bounded operation to the current engine. Do not automatically
implement a custom adaptive DAG after the experiment. Comparison criteria are
output quality, review effort, recovery, cost and maintenance burden.

**R1:** let “make this a routine” capture outcome, inputs, trigger, project,
permitted effects, budgets, completion checks and delivery. Agents may edit scripts
and supporting files under existing workspace authority. Reusable routine changes
get a diff, isolated test, recorded revision and rollback. Automatic activation is
allowed within standing policy; authority changes remain explicit. For external
mutations, persist effect identity and reconcile uncertain outcomes before retry.

Test: changed repository layout; missing source; malformed generated script;
quality regression; repeated trigger; partial external success; cancellation;
budget exhaustion; and rollback to the last working version. Limit repeated
attempts and make a stalled routine visible. Use existing scaffold/activation,
task history and notification delivery rather than introducing another engine.

## Skills, tools and agents to add deliberately

Development skills under `.agents/` and Raven runtime skills under `library/` are
different systems. This plan concerns runtime capability. Do not bulk-install
development plugins into the running assistant.

| Candidate                           | Implementation preference                                                                            | Priority / proof of usefulness                                                        |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Research verification               | Runtime skill for source/claim/citation checks; optional Zotero API adapter; local citation tooling  | P1: cited research packet with independently checked claims                           |
| Reproducible analysis               | Skill that follows repository environments, scripts, data provenance and tests                       | P1: rebuild a reported figure/table from its recorded inputs                          |
| Teaching preparation                | Project-local instructions + reusable global lesson/rubric/render methods                            | P1: real lesson pack and rendered previews                                            |
| Weekly planning / commitment review | Skill using existing task/calendar sources and bounded profile context                               | P1: one useful weekly review without duplicating tasks                                |
| Meeting preparation and notes       | Reuse transcription service through project-scoped MCP input/output; retain cleanup ownership        | P1/P2: agenda → transcript → decisions → linked commitments                           |
| Browser operation                   | Maintained browser tool with an isolated profile and resumable owner handoff                         | P2: one specific task unsupported by current APIs; do not default to browser scraping |
| Personal administration / travel    | Skills around chosen document sources, calendar and follow-up rules                                  | P2: a complete renewal or travel packet                                               |
| Finance review                      | Extend existing transaction services and explain source freshness; document exact supported accounts | P2: reconciled monthly review with evidence                                           |

Keep Raven as the conversation lead. Add a research reviewer, lesson reviewer or
automation maintainer only when their separate context/tool access or review role
improves results. Reuse the current quality reviewer/evaluator where appropriate.
Do not create a permanent “agent for everything.” Each new skill needs a trigger,
required tools, output contract, small fixture and a failure example. Repository
index links and conventions remain the source of project-specific instructions.

## Validation and operating trial

For each implementation slice: parent review, relevant behavioral tests, required
`npm run check`, default suite before claiming a new green baseline, and appropriate
browser/compiled/container coverage when those boundaries change. Commit and push
reviewed slices independently. Do not overwrite owner WIP, activate new accounts or
send external messages during isolated verification.

After the first useful release, run an owner-chosen two-week trial with a small
number of daily/weekly routines. Record useful deliverables, mistakes corrected,
missed/duplicate actions, model cost and interruption quality. Include actual phone
use and account delivery canaries. Advance wider-life integrations according to
observed usefulness. No package version, green unit suite or model's “done” message
alone establishes that Raven helped the owner.
