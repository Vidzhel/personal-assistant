---
title: Flexible project workspaces and direct repository execution
type: feature
created: 2026-09-06
status: in-progress
baseline_commit: 60459bb
context:
  - AGENTS.md
  - ARCHITECTURE.md
  - _bmad-output/implementation-artifacts/file-first-completion-2026-09-05.md
---

# Flexible project workspaces and direct repository execution

## Intent

Raven currently stores project context and URI records, but executes agents in its
own checkout. The owner authorized project-specific working directories, attached
repositories, shell/file/Git operations and browser/mobile artifact access after
F1–F9. Those prerequisites are complete. The earlier September 5 workspace proposal
is superseded by this implementation plan and the owner's subsequent requirements.

Read-only inspection of the actual dissertation and teaching repositories confirms
they already provide agent instructions, authoritative overview files, local skills,
and reproducible scripts. Their folder structures differ and evolve. Raven will
link to these entrypoints and use the existing SDK and orchestration paths.

## Boundaries

- `context.md` retains project identity/settings and human context. `project.yaml`
  owns workspace execution settings and data sources. No duplicated SQL authority.
- Each project has a managed home. Attached folders remain in place; a selected
  attachment becomes cwd, with other attachments available as additional roots.
  The default working layout is a suggestion, not a fixed content taxonomy.
- `project.yaml`, `context.md`, agent/schedule definitions and Raven task records
  remain stable anchors. Project-specific pipelines and private material remain
  in their repositories. Shared runtime skills describe reusable workflows.
- Folder paths are server paths. Resolve relative attachment input against the
  explicitly configured Raven root, canonicalize it, and persist the absolute
  path. File APIs use project/source IDs and relative paths, never arbitrary paths.
- Offer Raven permission checks, SDK auto mode, and explicit full control. Full
  shell access is trusted host execution, not filesystem isolation. Preserve task
  lifetime and project ownership checks in SDK hooks even when permissions bypass
  ordinary callbacks. Never silently downgrade or broaden a selected mode.
- Keep project memory isolated by project identity; share it among that project's
  agents. Keep explicit knowledge links and graph memberships. No repository
  embeddings, legacy migration/export, new execution engine, or private content
  copied into Raven's public repository.
- Verification uses temporary repositories, fake provider execution, and a local
  bare Git remote. Live owner accounts and sibling repository mutations are not
  test fixtures. Commit and push reviewed checkpoints as already authorized.

## Scenarios

| State/action                                                 | Required behavior                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| No attachment                                                | Execute in managed home; agent may organize its own working files        |
| Multiple folders                                             | Explicit selected cwd; stable source IDs and linked context files        |
| Malformed manifest or unavailable folder                     | Current diagnostic and actionable failure; no broad fallback             |
| Source/config changes while queued or running                | Reject stale execution; cancel/deny subsequent work; preserve transcript |
| SDK resume after cwd, policy or local agent changes          | Start a fresh SDK lineage                                                |
| Duplicate agent names in different projects                  | Nearest project definition wins without sharing private memory           |
| Generated HTML                                               | Sandboxed preview without Raven origin/API privileges                    |
| Traversal, symlink escape or detached source in file request | Refuse access and retain owner files                                     |

## Ordered implementation checkpoints

- [x] **W1a — file-owned workspace configuration.** Replace
      `project-manager/project-data-sources.ts` SQL CRUD with a registry-resolved YAML
      store; add shared schemas, `project.yaml` diagnostics, and workspace API settings.
      Remove `project_data_sources` from the sole initial schema and all consumers.
      Preserve source CRUD URLs with project-scoped IDs. Extend new-project staging
      and create/archive recovery to verify both anchors together. Test restart, concurrent
      changes, malformed files, invalid references and ownership isolation.
- [x] **W1b — project execution.** The first runtime checkpoint groups project-aware
      agent selection and project-owned memory to prevent namesake leaks; see
      [its specification](tech-spec-w1b-project-context.md). Then extend dispatch events,
      Manager/session/backend options and permission hooks. Resolve a workspace snapshot
      before admission and revalidate before execution/tool calls. Persist SDK resume
      revision with sessions. Test native SDK
      option forwarding, local defaults, stale queued/running tasks and interruption.
- [x] **W1c — repository context and skills.** Project memory moved to the first W1b
      checkpoint alongside agent selection. Provide bounded overview/index links and
      source locations in project prompts.
      Update existing document runtime skills and add reusable repository/rendering
      instructions with project-owned output paths. Test same-name agent isolation,
      cross-agent sharing within a project, and unsuccessful consolidation retention.
- [x] **W1d — browser workspace and artifacts.** Extend project API/client/components
      with attachment/settings controls, file navigation, download and safe previews
      for text/Markdown, images, PDF and HTML. Add explicit project selection and
      server-side project filtering for knowledge graph views. Discover generated files directly; reuse
      repository render pipelines for other document previews. Test mobile attachment
      management and command→file→commit/push→browser using a real temporary repository.
- [ ] **W1e — complete review and deployment verification.** Update architecture,
      guides and deployment mounts/tools. Run required checks, default suite, relevant
      graph tests, production builds, browser journeys, compiled restart and offline
      container checks. Record concrete remaining limits and resolution plans.

## Acceptance

- Given two temporary repositories with different layouts and local agents, when
  each project dispatches work, then the backend receives its selected cwd, local
  conventions, effective capabilities and isolated memory.
- Given a full-control task, when it runs a repository script and commits/pushes
  the result to a temporary bare remote, then Raven reports the actual output and
  serves the generated artifact through a mobile browser.
- Given an agent reorganizes working content, when anchors remain intact, then
  project tasks, context and artifact access continue to work after restart.
- Given changed or revoked workspace settings, when a prior task or SDK session
  attempts work, then Raven rejects stale ownership and starts new context only
  through a fresh dispatch.

## SDK evidence and verification

Installed Claude Agent SDK 0.3.224 supports cwd, additional directories, explicit
settings sources, auto mode and bypass permissions. PreToolUse hooks run before
mode decisions; allowedTools/canUseTool alone cannot enforce every invocation in
bypass mode. Project settings enable repository instructions, skills and hooks.
See the primary [permissions documentation](https://code.claude.com/docs/en/agent-sdk/permissions),
[filesystem features](https://code.claude.com/docs/en/agent-sdk/claude-code-features),
and [hooks documentation](https://code.claude.com/docs/en/agent-sdk/hooks).

`npm run check` and relevant behavioral tests are required per checkpoint. The
default suite must pass before reporting a green baseline. Account-free SDK tests
verify execution contracts, not real model quality or subscription delivery.

## Progress and review

Planning: actual sibling repositories inspected read-only; no private datasets,
student content, credentials or project files copied or modified. Parent review
identified global agent precedence, fixed SDK cwd, unversioned session resume and
SQL data sources as existing paths to replace. W1a and the first W1b project
context checkpoint are implemented and verified; direct SDK execution is next.

Parent review: anchor staging and create/archive recovery move into W1a so an
empty newly created project remains safely archivable with its workspace manifest.

### W1a verification — September 6, 2026

Parent review fixed a YAML timestamp parser mismatch, the source API error
response shape, invalid partial source updates, manifest size overflow, incomplete
published-create classification, missing/edited archive anchors, unsafe staged
symlinks and the scaffold activation Git path list. Canonical text reads now use
bounded non-following descriptors with identity checks and exact UTF-8/BOM handling.
Current in-process mutations serialize and check prior bytes before rename; this
is not cross-process transactional compare-and-swap or a filesystem sandbox.

- Required `npm run check`: passed (`/tmp/raven-w1a-check-final.log`).
- Default suite: 228 files, 2,384 passed, six explicit live-account skips
  (`/tmp/raven-w1a-full-final.log`).
- Browser regression: all 16 journeys passed (`/tmp/raven-w1a-browser.log`).
- Fresh shared/core build and compiled HTTP/chat/persistence restart: passed,
  including two clean process exits (`/tmp/raven-w1a-build-core.log`,
  `/tmp/raven-w1a-compiled.log`).
- Existing 87-file definition baseline is preserved except for the already
  authorized F9b maintenance template change. Unrelated owner work remains intact.

Folder source reads intentionally remain available when an attachment disappears,
so the owner can repair or remove its configuration. W1b adds current availability,
execution rejection and revision checks; storing execution settings in W1a does
not yet change SDK cwd or permissions. Existing graph links remain unchanged.

### W1b project context checkpoint — September 6, 2026

Project-local agent defaults/identity and project-owned memory are complete;
[the checkpoint specification](tech-spec-w1b-project-context.md) records parent
review and verification. Required checks, 2,397 default tests (six explicit skips),
17 browser journeys across regression/focused runs, production builds and compiled
restart pass. This moves the memory portion of W1c alongside local agent selection.
The next W1b checkpoint wires workspace cwd, SDK autonomy modes, invocation
revalidation and revision-bound session resume. Workspace execution settings still
do not change backend cwd or permission mode until that checkpoint lands.

### W1b direct execution checkpoint — September 6, 2026

Direct repository execution is complete; the
[execution checkpoint](tech-spec-w1b-workspace-execution.md) records the contract,
parent review fixes and validation. Project tasks now use their managed home or
selected repository, SDK default/auto/full modes, current grants, scoped
integration policy, and persisted resume revisions. Verification includes 2,431
default tests, real SDK subprocess flags, actual temporary shell/file/commit/push,
production core build and compiled restart. This supersedes the earlier W1a and
first-W1b notes above that configuration does not yet affect execution.
Repository context links/shared skills are next, followed by mobile artifacts and
explicit graph project scope.

## W1c checkpoint — current context and repository workflows

[W1c](tech-spec-w1c-workspace-context.md) is complete. Current project instructions
and bounded repository links reach chat, execution and SDK skill agents. Explicit
nested anchors preserve flexible working layouts; generic document/media workflows
follow local scripts and project output conventions. Parent review, the required
check, both definition validators, 2,443 default tests, 17 browser journeys,
production core build and compiled restart pass. W1d is next.

## W1d checkpoint — browser workspaces, artifacts and project graph views

[W1d](tech-spec-w1d-browser-workspaces.md) is complete. The Workspace tab owns
attachment/settings controls and bounded file navigation/previews/downloads. Task
file artifacts must exist and persist their source identity. Mobile acceptance
runs an actual command, commits/pushes to a local remote and displays/downloads
the output, including rendered PDF pages. Graph selection is explicit and backed
by current project membership. Parent review resolved descriptor races, stale
forms/searches, blank native PDF frames and the duplicate source editor.
2,466 default tests (six explicit skips), 40 disposable graph route tests, all 19
browser journeys, required checks, validators, production builds and compiled
restart pass. W1e deployment packaging and final container verification are next.
