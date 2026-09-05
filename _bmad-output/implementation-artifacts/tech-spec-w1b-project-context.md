---
title: Project-owned agents and durable memory
type: feature
created: 2026-09-06
status: complete
baseline_commit: ba01755
context:
  - AGENTS.md
  - ARCHITECTURE.md
  - _bmad-output/implementation-artifacts/tech-spec-w1-project-workspaces.md
---

# Project-owned agents and durable memory

This is W1b's first runtime checkpoint. Project-local selection and memory move
together: introducing local agents while retaining global name-owned memory would
share private notes between unrelated projects. Direct SDK cwd/permission/session
revision wiring follows this prerequisite in W1b's second checkpoint. The memory
portion previously listed in W1c moves here; W1c retains overview/skill integration.

## Contract

- Resolve a project's nearest local agent/default through its existing ancestor
  chain. Explicit local definitions override ancestors by name. Missing project or
  agent references fail; no search through unrelated projects or full-library
  fallback. Projectless system work may use the global default.
- Global agents keep their current IDs. Local IDs include stable project identity
  and agent name, so list/edit/delete cannot accidentally select a namesake in
  another project. Current validated definition bytes provide a revision for the
  subsequent SDK resume/workspace grant check. Native repository skills remain a
  separate SDK concept.
- Memory belongs to a Raven project, shared by its agents. Resolve current project
  IDs through the W1a workspace store and write under `<managed-home>/memory/`.
  Remove the global `projects/agents/<name>/memory` resolver and budget reader;
  there is no migration, fallback store or automatic copying of old memory.
- Preserve `MEMORY.md` as a bounded prompt index. Other Markdown notes may use
  nested relative paths, allowing project-specific organization and ordinary
  links. Protect `candidates/` and temporary/internal paths from normal note tools.
- Project YAML may configure the memory budget; default limits remain 30 files
  and 64 KiB. Validate limits; serialize writes and budget checks with project
  mutations, flush atomic file replacement and reject symlink/traversal escapes.
  This governs Raven memory tools, not unrestricted native shell execution.
- Retrospectives write candidates only to their session's current project.
  Candidate names are unique even for the same title/date; preserve provenance.
  Consolidation processes projects, uses the applicable default agent's model,
  and archives candidates only after successful application and index generation.
  Failed, partial or cancelled work retains candidates for review/retry.
- Memory HTTP access is explicitly project-scoped. The agent details UI must
  select/display project ownership; it must not aggregate unrelated project notes.
  Keep existing graph knowledge links and project memberships.

## Implementation map

- `agent-registry/yaml-named-agent-store.ts`, shared agent types and focused tests:
  add project-aware lookup, stable local IDs and definition revisions.
- `agent-memory/memory-store.ts`, project YAML schemas and store tests: replace
  global agent ownership with injected current project-home/budget resolution,
  nested note operations and safe persistence. Reuse W1a bounded file reads.
- `agent-memory/memory-candidates.ts`, `memory-consolidation.ts`,
  `session-manager/session-retrospective.ts`: move the existing learning path to
  project identity; do not create a new learning engine.
- `orchestrator/`, `task-execution/execution-bridge.ts`, `agent-manager/agent-session.ts`,
  `mcp-server/memory-mcp.ts`, `api/routes/`, `raven.ts`, web agent/project views:
  pass the actual project through selection, prompts, tools and UI. Retain current
  admission, ownership, budget and cancellation checks.
- Update unit/composed/compiled/browser fixtures to create explicit temporary
  projects. Preserve owner directories and use fake providers only.

## Acceptance

- Given two projects with identically named agents, when each dispatches chat and
  task work, then its nearest agent settings are used and only its memory index
  and tools are available.
- Given different agents in one project, when one saves a nested note and index,
  then the other can read it after restart. A request through another project's
  URL or tool scope cannot read or mutate that note.
- Given concurrent writes near a project budget, when both attempt admission,
  then the persisted result stays within the limit without dropping prior files.
- Given a candidate title repeats in separate sessions, when retrospectives run,
  then both proposals remain reviewable with their provenance.
- Given failed or partial consolidation, when the job settles or is cancelled,
  then source candidates remain pending; successful consolidation regenerates
  the project's linked index and archives only applied candidates.
- Given an inactive project or an unsafe memory path, when a read/write starts,
  then it fails without creating directories or touching unrelated files.

## Verification

Run required checks, meaningful store/learning/selection regressions and composed
project isolation tests. Run the default suite, fresh core build, compiled restart
and affected browser journeys before committing/pushing. Account-free tests verify
local execution contracts, not real model quality or account delivery.


## Parent review

Review corrected global-only lookup, nearest default selection with local shadows,
stale project metadata and registry health, source write safety, rename Git paths
and commit shutdown drain. Agent deletion preserves extra files. Project memory
reads do not create directories; note writes use fresh per-operation snapshots,
while consolidation carries explicit snapshots across model calls. Recursive scans
share a whole-tree entry limit. Internal validators receive no project memory.

Candidate names include UUIDs, reads are bounded, and archive checks bind to exact
reviewed bytes. Changed notes, candidates or indexes reject stale consolidation.
Rejected or partial work retains pending candidates and reports job failure while
valid sibling projects can finish. Retrospective persistence failures are explicit.
Browser selection ignores stale responses after a project switch or panel close.

Verification uses actual isolated stores, composed HTTP/runtime paths, real MCP
transports, temporary Git repositories and fake model execution. It verifies local
ownership/persistence, not real model quality or account actions. Atomic replacement
and in-process locks do not establish cross-process transactions or host isolation.

## Verification evidence

- Required check: passed (`/tmp/raven-w1b-check-final.log`).
- Default suite: 231 files, 2,397 passed and six explicit live-account skips
  (`/tmp/raven-w1b-full-2.log`).
- Production shared/core and dashboard builds: passed. The owner's existing
  `next-env.d.ts` bytes were restored exactly after the dashboard build.
- Compiled restart: HTTP/chat, persisted definitions/project memory/Git history and
  two clean process exits passed (`/tmp/raven-w1b-compiled.log`).
- Browser journeys: 16 regressions passed, then the new mobile memory journey
  passed after correcting a fixture-name assertion and labeling the Memory action
  (`/tmp/raven-w1b-browser.log`, `/tmp/raven-w1b-browser-memory.log`).

The first full run caught an in-progress candidate rename import change and stale
consumer fixtures. Those failures were fixed, including the new `apply` mutation
used by the admitted-write shutdown test; the subsequent full suite passed.
The 87-file owner definition baseline is unchanged except for the previously
approved F9b maintenance template edit. Unrelated owner work remains unstaged.
