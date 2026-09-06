---
title: Project readiness and private phone access
type: feature
created: 2026-09-06
status: complete
context:
  - ../../AGENTS.md
  - ../../ARCHITECTURE.md
  - personal-assistant-next-steps-2026-09-06.md
---

# Project readiness and private phone access

## Intent

The owner approved readiness and reliable phone access as the third P0 product
priority. Expose actionable project/capability readiness and supply one private
HTTPS origin for the dashboard, chat, WebSocket and artifacts. Extend existing
routes and deployment tooling. Implement after Telegram and model controls.

## Gateway feasibility evidence

A September 6 isolated experiment used official Caddy 2.11.4 (release archive
checked against the upstream SHA512 manifest), fake credentials and a temporary
HTTP/WebSocket backend. Unauthenticated HTTP and WebSocket requests returned 401.
Chromium authenticated through a browser challenge with no Playwright
`httpCredentials`, connected a native WebSocket, reconnected, and reloaded
successfully after challenge handling was disabled. This verifies browser credential
caching locally; it does not establish Tailscale HTTPS or phone behavior. Convert
the experiment into repository tests against the final gateway routes.
[Official release](https://github.com/caddyserver/caddy/releases/tag/v2.11.4).

## Boundaries

Keep default Compose services on loopback. Remote access must have an explicit
owner access boundary; merely changing CORS is not authentication. Supply an
optional Caddy gateway with owner HTTP Basic authentication, reachable only via
loopback and Tailscale Serve's private HTTPS endpoint. Protect every route,
including API, WebSocket and artifacts, with the same gateway authentication.
Use a hashed password and a setup helper; never put plaintext credentials into
URLs, process arguments or committed configuration. Tailscale ACLs further scope
access; other tailnet members must still authenticate as the Raven owner.
No public port exposure, new production model calls or service activation during
tests. Preserve the owner's environment values; setup scripts use actual files
and never execute dotenv contents. Do not print tokens or resolved MCP headers.

This uses standard proxy behavior instead of adding a second application session
system. The direct loopback core remains a trusted local interface; it is not a
public authenticated endpoint. Caddy HTTP Basic must only be used over the
private HTTPS connection remotely. [Caddy authentication](https://caddyserver.com/docs/caddyfile/directives/basic_auth),
[Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve).

Gateway routing: publish only `127.0.0.1:4002`; authenticate before routing `/api`
and `/api/*` plus `/ws` to core, and all remaining paths (including `/_next/*`)
to web. In Compose use service names internally, not the gateway container's own
loopback. Tailscale Serve targets this one gateway. Allow absent Origin for
trusted direct health/internal clients; validate any supplied browser Origin on
both REST and WebSocket. Use `caddy hash-password` with stdin, omitting
`--plaintext`; upstream documents that stdin is supported. Test actual browser
authentication followed by WebSocket connect/reload and direct artifact previews,
not only requests with manually injected Authorization headers.
[Caddy password command](https://caddyserver.com/docs/command-line#caddy-hash-password).

## Code map and tasks

- [x] `packages/core/src/api/routes/project-readiness.ts` and static readiness collector:
      aggregate current definition diagnostics, effective working directory and mode,
      accessible source/context indexes, selected agent capabilities and executable
      dependencies. Reuse project/workspace resolution; inspect bounded metadata and
      static executable/configuration checks instead of invoking an agent.
- [x] Selected capability library definitions: expose required
      tools and configuration readiness, distinguishing unavailable, configured,
      verified, failed and unverified optional integrations. Credentials present must
      never be reported as authenticated without a successful check.
- [x] `packages/web/src/components/project/ProjectWorkspaceTab.tsx` and `ProjectReadiness.tsx`:
      show readable readiness findings and corrections; optional failures do not make
      every other capability appear broken. Keep mobile layout usable.
- [x] `packages/core/src/config.ts`, API server and WebSocket handshake:
      validate canonical browser origin, reject disallowed origins consistently,
      support the selected owner access boundary, preserve isolated test endpoints.
- [x] `packages/web/src/lib/core-endpoints.ts` and API/WS clients: support one
      browser origin through the proxy without localhost URLs escaping to phones;
      preserve explicit endpoints for development and tests.
- [x] Telegram artifact links and existing file/artifact API: use configured
      canonical origin and stable project/source identifiers, retaining existing file
      authorization and preview handling. Suppress unusable links when unconfigured.
- [x] `docker-compose.yml`, optional private-access configuration, `scripts/raven.sh`
      and `docs/deployment.md`: provide reproducible proxy/private HTTPS setup and
      readiness/status instructions, preserve existing mount/Claude/graph launcher
      behavior. Account login and phone enrollment are explicit operator steps.
- [x] E2E and deployment tests: local single-origin proxy fixture, API/WebSocket
      access checks, mobile chat-to-artifact journey and setup-script failure cases.

## I/O and acceptance

| Given                                                  | When                                     | Then                                                                      |
| ------------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------- |
| Missing mount or declared executable                              | Readiness is opened                      | Name the missing requirement and an actionable correction                 |
| Tool execution blocked                                 | Project readiness is opened              | Report effective mode and blocked operation without granting access       |
| Credential missing/present/unverified                    | Connector readiness is read              | Distinct truthful state; no raw credentials or provider payload           |
| Valid private endpoint                                 | Browser opens the dashboard              | API, WebSocket and artifact links use that origin                         |
| Invalid browser Origin or absent required owner access | HTTP/WS request arrives                  | Reject before project data or tools are accessible                        |
| One optional capability fails                          | Other project capabilities are inspected | Keep available capabilities usable                                        |
| Mobile test viewport and generated artifact            | Owner opens/previews/downloads it        | Same project-scoped route and verified file identity are used             |
| Setup input contains spaces/shell syntax               | Launcher parses it                       | Treat as data, preserve other settings and fail clearly on invalid values |

## Verification

Use focused API/readiness/WS tests, script tests with fake services and temporary
inputs, required `npm run check`, default suite, core build/compiled restart, and
browser-testing skill with isolated fake-model E2E data. Validate proxy routing
locally; separately report the real-device canary: authorized phone on private
network loads HTTPS, chats and opens an artifact; unauthorized device is denied.
Automated local results must not be described as proof of external phone access.

## Investigation

The baseline reflects all CORS origins and has no REST/WS authentication. Existing
health/self-test diagnostics are runtime-wide; existing workspace and artifact
routes already provide useful project-bound file checks and previews. Current
Compose binds loopback and web defaults are compiled localhost URLs. These are
implementation starting points, not a recommendation to expose them unchanged.


## Review decisions — 2026-09-06

Readiness uses one project-scoped endpoint; global `/api/skills` remains the
capability definition inventory. The project panel shows current requirements,
filesystem/context checks and corrections even when the workspace itself fails.
It does not infer authentication from credentials or agent success. Official
TickTick gets a dedicated read-only MCP connection probe in the immediately
following A2 slice; other connectors remain explicitly unverified.

The collector deliberately does not query execution history. Existing history
queries currently enumerate all project run files before filtering; adding that
cost to every readiness refresh would violate the bounded inspection requirement.
The Tasks/history views retain execution outcomes. A future bounded storage query
is tracked in the deferred ledger; no new history index is introduced here.

Static node/python MCP entrypoint checks detect a missing literal script without
running it. Arbitrary command arguments and remote package resolution are not
interpreted as shell commands. Source directory availability stays distinct from
missing context indexes. Private setup validates a candidate environment with
Compose before replacing the owner's file. Actual phone/Tailscale enrollment and
Docker container verification remain external canaries; local Caddy/browser tests
prove only the tested authentication, routing, reconnect and artifact behavior.


## Completion evidence — 2026-09-06

Review findings and dispositions: [p0-readiness-phone-review.md](p0-readiness-phone-review.md).

- Required check passed: formatting, lint/typechecks, 268 production strip-types
  files and dependency override validation.
- Default suite passed: 262 files, 2,627 tests, six explicit skips.
- All 24 isolated Playwright journeys passed, including mobile readiness, attached
  repository command/Git execution, artifact download and document previews.
- Production build and packaged-core restart smoke passed; restart preserved
  definitions, memory and history with two clean process exits.
- Launcher/private setup suite: 15/15 passed with fake Docker and temporary files,
  including invalid Compose, shell-like input and concurrent environment edits.
- Real Caddy 2.11.4 gateway regression passed with fake credentials, separate local
  upstreams and a mobile browser: all unauthenticated paths/WS denied, authenticated
  routing, cached challenge credentials, reconnect/reload and artifact access.
- No live Docker container, Tailscale enrollment, owner account or physical phone
  test was performed. Docker is unavailable in this WSL environment.

Run `scripts/raven.sh setup-private-access` on the deployment host to prepare the
private settings, then follow the Tailscale steps in `docs/deployment.md`. The
script requests the password privately and writes its hash; no browser-console
commands or plaintext token in shell arguments are required.
