---
title: Repair packaging and make deployment inputs reproducible
created: 2026-09-05
type: bugfix
status: done
baseline_commit: 1fc47cc
context: [AGENTS.md, ARCHITECTURE.md]
---

# R4 — Current build and deployment

Repair the existing Node/Docker deployment. Do not deploy into the owner's live
service or mount real data, credentials, projects or Neo4j for verification.

## Implementation boundaries

- Core image must use the current four workspace manifests and lockfile, build
  shared/core, and include migrations and runtime inputs. Remove every reference
  to the deleted skills package. Include the in-repo TickTick server input if its
  library definition remains shipped. Do not claim unavailable vendor binaries
  are working integrations; document their installation/availability boundary.
- Add a restrictive `.dockerignore` before any image build. Exclude secrets,
  owner data/memories, local IDE files, caches and development-agent settings.
  Package only deliberate seed definitions. Runtime definitions must persist
  outside the disposable image, with documented upgrade behavior.
- Package Next standalone output correctly, including monorepo server/static
  locations. Remove the nonexistent public copy. Confirm the actual output by
  building; preserve pre-existing user edits in next-env.d.ts.
- Give browser API/WS endpoints one consistent configuration contract. Explicit
  build arguments are acceptable; label build-time values truthfully, set both
  in Compose build configuration, and document remote-host/TLS examples. Avoid
  an unused runtime variable that implies a proxy exists.
- Make Neo4j opt-in in Compose and remove unconditional Docker startup from the
  core development lifecycle. Document how to intentionally start/use the graph
  while keeping ordinary graph-unavailable startup useful.
- Persist data, project definitions/memory and the capability library. Document
  deliberate CLI authentication and SDK-session persistence mounts; never bake
  credentials into images. Ensure runtime git commits have git and a suitable
  persisted repository, or explicitly implement/report the disabled history
  mode. Test chosen versioning behavior with a disposable Git repository.
- Add a compiled-artifact boot smoke command using fake model boundaries,
  temporary roots and definitively disabled graph/integrations. It must verify
  migrations, real HTTP service startup/health and clean shutdown. A source-only
  import with service startup skipped is insufficient packaging evidence.
- Update CI to exercise reproducible checks/build/smoke and container builds as
  appropriate. Keep browser journeys for R5. No production start/restart needed.

## Verification and acceptance

- Shared/core and web production builds pass. Try Webpack separately if this
  restricted runner blocks Turbopack child-process sockets; distinguish an
  environment limitation from an application build failure.
- Docker configuration validates without reading the owner's .env; both images
  build where daemon/network availability allows. Smoke images with no external
  network and temporary volumes only. Do not silently call a source test a
  container pass. Record exact blocked commands and a CI resolution plan.
- Restart against temporary persisted roots retains definitions/memory/history
  under the chosen supported layout. Missing optional integrations are clear.
- Focused regression checks and `npm run check` pass; deployment documentation
  names the required inputs, seed/upgrade behavior and supported launch commands.
