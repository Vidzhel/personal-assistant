---
title: Isolate composition tests from owner definitions and services
created: 2026-09-05
type: bugfix
status: done
baseline_commit: 8ebf1db
context: [AGENTS.md]
---

# R0 — Complete the existing test boundary

The owner authorized reliability fixes and regression tests. Before running the
broad suite, stop tests loading or reconciling the owner's project definitions,
memories, schedules, or writable library. Preserve real composition and SQLite.

## Tasks

- In `packages/core/src/__tests__/fixtures/`, provide minimal deterministic
  project/library fixture helpers that supply only the named agents, templates,
  schedules and skill/action definitions the tests need. Reading a specific
  shipped template for an explicit contract test is acceptable; copying the
  owner's whole `projects/` tree is not.
- Update all `createRaven()` tests with explicit temp projects/library roots.
  Known missing overrides: boot-smoke, e2e-schedule-roundtrip,
  e2e-email-triage, e2e-approval-flow. Remove whole real-tree copies in chat,
  memory, and self-test E2Es.
- Extend `RavenOverrides` only as needed for library/config root isolation and
  optional external boundaries. Keep existing production defaults unchanged.
  Reject unsafe/missing mutable roots in the default Vitest composition path
  before initializing logs/DB/registries, so new tests cannot regress silently.
- Keep env and Neo4j guards. Do not spawn real model calls or deliver messages.
  Ensure all timers/listeners started by these fixtures stop after each test.
- Add a meaningful test proving unsafe composition options are rejected without
  creating/modifying a sentinel owner directory; verify scaffold skill writes
  and registry reload stay inside the temp fixture.

## Acceptance and verification

Given a developer's checkout contains extra projects, memories and schedules,
when default E2E tests run, then none are read, copied, fired, or mutated by the
composition. Given missing explicit temporary mutable roots, the test fails
before mutation with a useful message. Existing chat, memory, schedule, approval,
intent and scaffold round trips still reach their terminal outcomes.

Run focused E2Es, npm run check, then full npm test -- --maxWorkers=2 with local
socket access. Do not alter the owner's databases, Git index, or external services.
