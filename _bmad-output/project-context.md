---
project_name: 'personal-assistant'
user_name: 'User'
date: '2026-09-05'
status: 'complete'
optimized_for_llm: true
canonical_guide: '../AGENTS.md'
---

# Raven context for BMAD workflows

Read [AGENTS.md](../AGENTS.md) before implementing code. It is the canonical
development guide for both Claude and Codex and replaces this file's March 2026
rules about skill workspaces, suites, execution backends and deployment paths.
Do not revive those retired systems from historical stories.

- [ARCHITECTURE.md](../ARCHITECTURE.md) describes the current runtime and storage.
- The [completion record](implementation-artifacts/reliability-completion-2026-09-05.md)
  is the current task queue and dated verification evidence.
- The [deferred ledger](implementation-artifacts/deferred-work.md) records remaining
  defects, limitations and concrete resolution plans.
- [CLAUDE.md](../CLAUDE.md) preserves Claude's entry point and workflow; Codex
  reads the same shared guide directly.

Raven serves one owner through a small composed runtime and the Claude Agent SDK.
Extend the existing capability library and scaffold-and-activate path. An empty
agent skill list grants no capability bindings. File definitions and memory remain
owner-readable; SQLite holds operational state and some unmigrated legacy project
settings, while Neo4j still owns durable knowledge relationships and membership.

Workspace attachments, project-owned memory and graph replacement remain deferred.
The proposal and old unchecked phase plans are not instructions to implement them
during the reliability pass. Use the shared guide's isolated tests and report
external-account verification separately from fake-model and local-file evidence.
