---
title: Workspace deployment and final verification
status: complete
baseline: f4869c4
date: 2026-09-06
---

# Workspace deployment and final verification

W1a–W1d implement the repository workflow and browser experience. This checkpoint
packages the minimum usable runtime, validates replacement-container persistence,
and closes the current plan with reviewed evidence.

## Contract

- Keep the application image independent of the owner's repositories, credentials
  and runtime definitions. Public generic deployment seeds explicitly bind native
  repository-work, with no external MCP/vendor dependencies. Existing nonempty
  definition roots are never silently merged or overwritten.
- Ship Bash, Git/SSH, Python/venv, C++ build tools, HTTP/archive/search/JSON/file
  utilities, Pandoc, Poppler and FFmpeg for the documented general workflow.
  Repository-specific frameworks, TeX/Quarto/.NET and Python/Node packages stay in
  the repository environment or an operator image extension. Runtime remains the
  node user; full mode is access as that process user, not privilege escalation.
- Provide an optional explicit host directory bind at /workspace. Refuse an unset
  path or implicit creation of a missing host folder. The base Compose deployment
  continues to work without attachments. Persist only settings/links in Raven's
  project YAML; repository files and Git history stay in the mounted repository.
- Extend offline container smoke tests with temporary repositories, shell/file/Git
  work, real local Git push, source registration, file API reads and restart.
  Verify actual project memory/settings and bundled PDF worker serving. Retain
  existing core boot, current definitions/history and standalone web checks.
- Review deployment instructions, architecture, README, assessment and deferred
  ledger. Record remaining provider/format limits with a concrete next step.

## Acceptance

Required checks and definition validators; 2,466-test default baseline and 19
browser journeys from W1d; full disposable graph suite; deployment initializer
and context-allowlist checks; current core/web images built from public inputs;
offline replacement-container persistence and artifact access. Use fake execution
and temporary roots only. Live Claude/authentication/account delivery are separate
canaries; no outbound owner message or production deployment is claimed.

## Review and verification — September 6

- The parent reviewed the Docker tool list, explicit mount, native skill binding,
  initializer behavior and container assertions. A missing final Git paragraph
  in the proposed seed was corrected by copying the canonical public workflow;
  an exact byte-parity test now covers both config and instructions. The test's
  js-yaml import uses its actual Node ESM default export. Existing nonempty roots
  and owner-staged changes remain protected by the initializer tests.
- `npm run check`, `validate:library` and `validate:projects` pass. The deployment
  scripts pass Node syntax checks. `npm run test:deployment` passes all **10** tests.
- `npm run test:knowledge -- --maxWorkers=1` passes **9 files / 150 tests** against
  disposable Neo4j with APOC. The owner's graph and provider accounts were not used.
- `npm run test:docker-context` verifies **381 deliberate build inputs** with no
  owner runtime state or development artifacts. Compose configuration rejects an
  unset workspace root and preserves an explicit temporary path containing spaces
  with `create_host_path: false`, alongside the ordinary named volumes.
- Current core/web images build successfully. The final core image was rebuilt
  after correcting the public seed. Offline `test:containers` passes with temporary
  named volumes and a temporary bind mount: native tool presence, runnable FFmpeg
  and Poppler, a Python virtual environment, Pandoc HTML generation, a Unicode
  artifact and a real commit/push to a local bare repository. The file API serves
  the report with sandbox headers. Replacement preserves project identity,
  execution settings, memory, repository artifact bytes and both Git histories.
  The new web container serves a page, static JavaScript and the bundled PDF worker.
  Both core stops exit cleanly; the harness removes its containers/volumes/folders.
- W1d's unchanged application-source baseline remains **242 files / 2,466 tests**
  with six explicit live skips, **19 browser journeys**, production builds and
  compiled restart. Its browser journey exercises the SDK options/hook boundary
  with a fake model and real shell/file/Git work; W1e executes native commands
  directly inside the packaged container. Neither is a live Claude model canary.

Local evidence is in `/tmp/raven-w1e-{check,library,projects,deployment,knowledge,
docker-context,core-image,web-image,containers}.log`. W1d's linked specification
records its separate full/browser/build evidence. No npm dependency changed here.

## Completion and remaining limits

F1–F9 and W1 are complete. Current guides and the deferred ledger describe the
implemented behavior. Public deployment seeds are independent of the owner's
actual definitions and repositories; no private source material was copied.

The image remains an unprivileged runtime. Repository-specific Quarto/TeX/.NET,
LibreOffice or package dependencies need a chosen image extension or repository
environment, followed by that repository's own build/render checks. Browser
previews support text, images, PDF and static self-contained HTML; other formats
can be downloaded or rendered with those tools. Full mode is trusted execution
as the process user. Live Claude authentication, model behavior, Git credentials
for an external remote and account delivery require a separately chosen canary.
The optional managed project-transcription integration has a concrete scoped-tool
and cancellation test plan in the deferred ledger.
