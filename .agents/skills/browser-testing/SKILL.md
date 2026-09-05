---
name: browser-testing
description: Verify Raven dashboard pages, interactions, and acceptance criteria with headless playwright-cli and accessibility snapshots. Use for browser testing of this repository.
---

# Raven browser verification

Read `.agents/skills/playwright-cli/SKILL.md` for CLI syntax. Run commands through
Codex's available shell tool. These instructions do not grant tool permissions;
the active sandbox and approval policy remain authoritative.

## Setup

For automated regression, run `npm run test:e2e`. Its harness starts temporary
backend/frontend definitions, databases and fake model execution on ports
4420–4422, rejects occupied ports, and cleans up its own services. It does not
reuse the owner's .env, running assistant, graph, or Claude credentials.

For manual CLI inspection, first build core with `npm run build:core`, then run
`node e2e/server.mjs` in a managed shell session. Use `http://127.0.0.1:4420` and
stop only that harness process when finished. Wait for its dashboard to load;
do not substitute a live instance if the isolated harness fails.

The check-devserver.sh and start-devserver.sh helpers target the ordinary 4000 /
4001 development instance. Use them only when that instance is explicitly part
of the task; they are not the isolated verification harness. Starting real Raven
core can activate integrations. Named browsers do not isolate the backend data.

Test specifications live in `manual-tests/`. Some describe retired UI paths:
check current routes in `packages/web/src/app/` and flag obsolete expectations.
Do not treat a stale manual spec as the product contract.

## Verify behavior

Always use headless mode; never pass `--headed`. Pick a named session and include
it in every command. Store screenshots/PDFs under `.browser-test-output/`.

```bash
playwright-cli -s=raven-check open http://127.0.0.1:4420
playwright-cli -s=raven-check snapshot
playwright-cli -s=raven-check goto http://127.0.0.1:4420/projects
playwright-cli -s=raven-check snapshot
# Use refs from the latest snapshot for click/fill/select.
playwright-cli -s=raven-check close
```

1. Read the test steps and expected user-visible outcome.
2. Navigate, then take an accessibility snapshot.
3. Interact with refs from the latest snapshot; refresh them after page changes.
4. Assert headings, labels, content, counts, state changes, or absence of content.
5. For dynamic content, retry snapshots with a bounded wait. Report timeout
   honestly rather than silently skipping the assertion.
6. Capture screenshots on failure or when visual verification was requested.
7. Close only sessions created for this task, including on failure.

For extensive independent test groups, use the optional `browser-tester` Codex
agent when delegation is available and authorized. Give each agent the concrete
spec, service URL, unique session name, and expected output. Respect the active
session's concurrency limit. If delegation is unavailable, run groups locally.
Named browsers isolate navigation, not the Raven database: do not run conflicting
project edits concurrently and do not use `close-all`/`kill-all` around other work.

## Report

Return a concise table: test, pass/fail/blocked, and observed evidence. Include
failure steps and artifact paths. Distinguish missing services, obsolete specs,
and actual application failures. Do not claim a browser run from syntax checks.
