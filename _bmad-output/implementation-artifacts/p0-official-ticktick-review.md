# A2 official TickTick review — 2026-09-06

## Scope and decisions

Replace the in-repository Open API adapter with TickTick's official Streamable HTTP
MCP. Keep the existing Claude Agent SDK and permission engine. TickTick is the
planning authority; Raven board YAML records Raven execution, not a competing
mirror of personal tasks. Cross-project memory and broader planning design remain
follow-up work after these P0 changes.

The official catalog and token instructions were verified against the public
[TickTick guide](https://help.ticktick.com/articles/7438129581631995904).
The [SDK MCP contract](https://code.claude.com/docs/en/agent-sdk/mcp) supports the
HTTP configuration directly; no new execution backend or OAuth service is added.

## Review findings and dispositions

- **Credentials in persisted events:** the previous capability resolver expanded
  environment references before emitting `agent:task:request`. Task/event configs
  now retain references; only the backend boundary materializes credentials.
  Error arrays, thrown diagnostics, failed results and buffered stderr redact
  resolved values. No per-chunk stderr logging can leak a split token.
- **Dedicated execution:** a TickTick-only execution node blocks before model
  work when credentials are missing. Mixed/default agents retain independent
  repository capabilities instead of blocking every tree on an optional connector.
- **Missing connector scope:** omitted SDK sub-agent tool lists can inherit parent
  capabilities. Empty lists are explicit; unavailable generated and explicit MCP
  patterns are removed. Missing optional HTTP credentials leave unrelated chat
  usable, while an explicit connector action fails before queue/model work.
- **Repository cwd changes interpreter entrypoints:** literal script argv is
  anchored to Raven code or configured library roots, preserving direct argv
  execution without shell expansion. Separate runtime data roots cannot redirect
  Raven-owned scripts into an attached repository.
- **False readiness success:** saved credentials alone are not authentication
  evidence. A bounded initialize/tools-list probe verifies the configured HTTP
  connection. Empty catalogs and missing required TickTick tools fail the tools
  requirement. Other capabilities retain independent status. No tool is called.
- **Failure classification:** rejected credentials, connection failures and tool
  catalog failures have separate requirements; network errors never claim the
  token was rejected.
- **Probe lifetime:** one total deadline bounds connect/list work, pagination and
  body sizes are capped, redirects cannot forward authorization, and API shutdown
  or client cancellation aborts active probes. Errors expose fixed diagnostic text.
- **Incomplete planning mirror:** remove the old TickTick-to-board sync and its job
  instead of preserving incompatible title/date/reopen/delete behavior. Adapt
  existing analysis to explicit scope envelopes and disclose their limits. A model
  report is not an independent account audit. The old unattended reorganization
  schedule is disabled; this change does not reorganize the owner's account.
- **Workload coverage and dates:** require explicit complete scope envelopes,
  reject truncation/pagination gaps and conflicting duplicate records, preserve
  timezone/all-day/recurrence fields, and stop analysis/mutations on partial scope
  coverage. Calendar windows use the owner's timezone and provider limits.
- **Durable library activation:** rebuilding an image cannot update an existing
  volume's definitions. The setup command checks stopped services, validates the
  dedicated token and prospective Compose settings, then installs only absent,
  identical or exactly known shipped TickTick definitions. Customized definitions
  conflict; unrelated files, indexes and staged Git work remain intact. Reads are
  bounded and candidate definitions validated before any write.
- **Setup failure semantics:** `.env` replacement compares original bytes after
  validation. Definition files replace atomically individually and are retry-safe;
  host environment plus container-volume updates are not a single transaction.
  A partial setup reports failure rather than claiming activation.
- **Browser list identity:** diagnostics can share requirement names. Distinct
  render keys preserve all rows across connection refreshes without React warnings.
- **Email creation uncertainty:** strict verified evidence is required before a
  task-created notification. Unknown outcomes warn the owner and are not retried
  automatically, but their retention is runtime-only; durable restart and repeated-
  email reconciliation remains recorded in the deferred ledger.

## Verification

Final checkpoint: 2,671 default tests across 266 files passed; all 25 isolated
browser journeys passed; 18 deployment/real-Git installer tests and 22 setup tests
passed. The required check, production builds, library/project validation and
packaged-core restart smoke passed. The smoke fixture now explicitly asserts that
the optional seeded TickTick agent has no remote MCP without credentials.

The browser run initially exposed two stale fixture assumptions about a single
default agent. Tests now target the global agent by identity/scope, and the full
25-journey rerun is green. Final mobile inspection places actionable corrections
before workspace details so a connection failure is visible sooner.
Tests use isolated roots, fake tokens, local protocol servers and fake model
backends. Real account authentication, provider argument schemas and delivery
remain an explicit operator canary after token setup. Docker is unavailable in
this WSL runner; script/Git/protocol checks do not establish container deployment.

### Packaging correction after owner setup report

The owner exposed a missed container input: `.dockerignore` excluded
`deployment/install-ticktick.mjs`, so setup failed with `MODULE_NOT_FOUND` after a
successful image build. Added the installer to the explicit context allowlist.
The context check now requires all three deployment entrypoints and all five
TickTick seed inputs; the core image runs the installer's read-only validation
against its empty library during build. Independent review identified the seed
coverage gap and it was fixed before completion.

Docker became accessible for this follow-up: the actual 409-file context export,
core image build, and network-disabled installer check as the image's non-root
user passed. All 22 setup tests passed. These checks use no owner mounts or
credentials and do not establish live TickTick authentication.
