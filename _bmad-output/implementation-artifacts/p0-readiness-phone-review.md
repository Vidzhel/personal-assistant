# O0 readiness and private phone access — review record

Date: 2026-09-06. Parent review, independent edge/acceptance reviews of non-authored
modules, and a blind patch review. No reviewer found a concrete authentication
bypass in the tested gateway routing or exact-Origin policy.

## Repaired findings

- Readiness checked PATH symlinks as unavailable. It now follows executable links
  to regular X_OK files, without executing commands.
- MCP interpreter checks could overlook a missing script. Known literal node or
  Python entrypoints now get an independent readable-file check in execution cwd.
  Arbitrary argv, shell expressions and remote package availability are not inferred.
- Malformed managed projects disappeared when stable IDs differed from paths.
  Read-only SQLite cache evidence now maps only to currently invalid registry paths;
  archived/missing healthy identities are never reactivated.
- Source failures were not reflected in aggregate status. Missing attached folders
  and unchecked external sources have scoped corrections. Folder access is separate
  from context-index availability, and sibling capabilities keep their own state.
- Historical task failures were both misleading and expensive to inspect. Static
  readiness no longer queries run history, which currently scans across projects.
  The existing task/history UI retains outcomes; a bounded-query follow-up is in
  the deferred ledger. Account configuration is explicitly not authentication.
- Diagnostic redaction missed JSON, quoted values containing spaces and URL
  credentials. A shared bounded redactor now covers these, including a quoted
  secret cut off at the input bound. Model-catalog errors use the same helper.
- Private setup initially replaced `.env` before Compose validation. It now validates
  the prospective temporary file before atomic rename; failures preserve original
  bytes. Exported COMPOSE_FILE is rejected so shell overrides cannot silently defeat
  the saved setup. Values are data, not evaluated shell; passwords use stdin.
- Private startup advertised the standalone web port and did not wait for web
  readiness. It now advertises the configured HTTPS origin, waits for web health,
  and checks that the gateway presents its authentication challenge.
- Browser Origin handling now protects real REST and WebSocket admission. Rejected
  upgrade sockets finish explicitly so shutdown cannot hang. Config errors identify
  the correct setting, including additional development origins.
- Notification fallback links use the validated composition setting and existing
  file route; no unconfigured localhost URL or arbitrary repository-serving route
  is created.
- Readiness UI refreshes after mode/source changes and keeps findings visible when
  workspace loading fails. Mobile presentation omits internal random IDs.

## Verified boundaries and follow-ups

Caddy owns authentication for every remote route. Direct core/web loopback ports
are trusted local infrastructure. Exact Origin checks are browser request protection,
not a second authentication system. Absent Origin is allowed for trusted internal
and authenticated gateway clients. Tailscale Serve and tailnet ACLs supply the
private HTTPS/network path; account enrollment and a real phone canary remain
operator steps.

Readiness is static. It does not claim a successful provider login, inference,
renderer execution or task completion. A2 adds the dedicated official TickTick
read-only tools-list probe; generic connectors remain unverified until they have
such evidence. Existing relative stdio entrypoints are flagged when unavailable;
A2 reviews explicit location resolution rather than silently shell-expanding them.

The real Caddy test uses the actual repository Caddyfile with only temporary
loopback addresses substituted, fake credentials and two isolated upstreams. It
checks unauthenticated HTTP/WS denial, route separation, browser authentication
challenge caching, reconnect/reload and mobile artifact access. This establishes
local proxy behavior, not live Docker/Tailscale/device delivery.

Final verification counts are recorded in the completed O0 specification.
