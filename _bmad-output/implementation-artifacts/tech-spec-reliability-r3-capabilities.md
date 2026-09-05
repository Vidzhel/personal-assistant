---
title: Make capability and knowledge availability truthful
created: 2026-09-05
type: bugfix
status: done
baseline_commit: b2b49cf
context: [AGENTS.md, ARCHITECTURE.md]
---

# R3 — Capability resolution and degraded knowledge startup

Finish the existing runtime contracts without replacing graph storage, adding
repository retrieval, or widening agent permissions.

## Implementation boundaries

- Remove orchestration's full-library fallback. Resolution failure must produce
  a clear failed/rejected turn and recover session status without invoking an
  overprivileged task. An intentionally unconfigured test/embedding caller may
  use empty capability bindings; it must never inherit the entire library.
  Heartbeat has the same broad fallback in `resolveCapabilities`; remove it too.
  Preserve its running-flag cleanup and surface a failed scheduled fire without
  dispatching an overprivileged task or an empty owner notification.
  Named-agent resolution must reject missing skill/MCP/vendor definition
  references instead of silently returning partial capabilities. Generic library
  collection methods retain their contracts; runtime executable/account
  availability is a separate deployment/integration check.
  The project validator must inspect the current `agents/<name>/agent.yaml`
  layout as well as flat legacy YAML; it currently misses nested definitions
  that the runtime loads. Cover malformed configuration and binding references
  so validation can catch a broken default agent before dispatch.
- Remove the unconditional, unusable knowledge specialist from chat and
  heartbeat. Use the already implemented, role-filtered Raven MCP retrieval
  surface. Expose each knowledge tool only when its backing dependency exists;
  keep knowledge writes restricted to the roles already authorized to write.
  Prompt text must describe the actual available contract. Verify the SDK
  session options/MCP server boundary with a fake SDK, including unavailable
  graph and explicitly empty agent skill cases.
- Correct `mcp-server/tools/scaffold.ts` create_skill tier description: it
  currently describes yellow as approval-required and red as fully autonomous,
  contradicting actual policy (red requires approval). Verify descriptions
  against enforced tier semantics without changing the authorization policy.
- Stop accepting knowledge input fields that are silently ignored. Implement
  supported filters end to end only where existing interfaces support them;
  otherwise remove the misleading schema/prompt claim and document the bounded
  future implementation. Do not apply filters after a limited search and claim
  complete filtered retrieval. Knowledge save must never pretend to persist an
  unsupported domain assignment.
- Make knowledge startup transactional with respect to listeners, timers and
  MCP dependency publication: publish only after initialization succeeds; stop
  each partially initialized processor and close the driver on failure. Make
  processor start/stop lifecycle explicit where needed, reusing existing modules.
  Retain normal agent-memory learning in graph-unavailable mode.
  Include clustering's nested hub/clustering response handlers and outstanding
  ingestion completion listeners/timers in the lifecycle audit. Stop accepting
  work before disposal; do not claim cancellation of already-running external
  model work unless the implementation actually provides it.
- Provide an explicit graph-disabled setting usable by packaged smoke tests and
  deployments without a graph. Disabled means no driver creation or connection
  attempt. Preserve existing enabled behavior by default for current installs;
  Compose can deliberately choose disabled until its optional graph is enabled.
  Audit `services/proactive-intelligence/cross-domain-detector.ts`, which creates
  a separate client before main knowledge startup and currently reads credentials
  from env with literal defaults. It must honor the same setting/config and
  close its client on failed startup or stop; no hidden graph attempt when off.
- Neo4j schema setup must surface connectivity/required schema failure rather
  than log success after swallowing every error. Preserve idempotency using
  explicit Neo4j error semantics, with fake-driver tests in the default suite.
  Preserve the default factory guard and opt-in testcontainers isolation.
- Routine boot reindex must not delete all Bubble nodes. The existing
  `reindexAll()` erases relationships and project memberships before rebuilding
  files. Merge by durable ID; refresh file-owned fields/tags while preserving
  graph-owned metadata, embeddings and other relationships. Preserve unmatched
  graph records until an explicit backed-up reconciliation defines their
  ownership. Test repeat reindex, changed tags, unknown nodes and membership/link
  retention; reject conflicting duplicate file IDs instead of overwriting one.
- Remove the unused context-injector allocation and stale wiring claims. Do not
  implement the deferred automatic file/project retrieval design in this task.

## Acceptance and verification

- Failed agent resolution never exposes unrelated MCPs, plugins or subagents;
  subsequent valid turns remain usable and the dashboard receives an error.
- Without a graph, ordinary chat, memory and health remain usable; knowledge
  tools and nonexistent specialist instructions are absent from SDK requests.
- With fake graph dependencies, authorized retrieval tools are callable through
  the SDK MCP boundary and write tools remain denied to chat/task roles.
- Injected failure after each started knowledge processor leaves no active
  listeners/timers or published closed backend; cleanup continues if a stop fails.
- Focused behavioral tests and `npm run check` pass. Only isolated composition
  roots may be used. Record unsupported integration verification precisely.

Project-local agent identity, memory ownership and attachment confinement remain
in the deferred workspace design; this task must not pretend to solve them.
