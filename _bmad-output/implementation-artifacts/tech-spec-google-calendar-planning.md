---
title: Google Calendar events alongside TickTick planning
status: awaiting-live-verification
baseline_commit: 0046c22
context:
  - AGENTS.md
  - ARCHITECTURE.md
  - docs/deployment.md
---

# Google Calendar planning reads

The owner confirmed Google Calendar is the source of work events subscribed in
TickTick. Raven must read the source calendars alongside TickTick tasks, rather
than infer availability from task lists. Existing Calendar shell instructions
lack a deployed executable/authentication and a scoped default-mode permission.
Replace that capability in place with a read-only stdio MCP adapter over the
existing Google Workspace CLI's raw Calendar API commands. This is an integration
adapter, not a scheduler, calendar store, recurrence engine or task mirror.

## Provider decision

Google's official Calendar MCP is in Developer Preview (documentation updated
August 31). Raven's installed SDK HTTP configuration has no OAuth configuration
field; static bearer headers alone do not provide durable refresh. Adopt that
provider later only with verified enrollment, refresh and permission behavior.
The inspected third-party Calendar MCP event handler drops pagination and some
multi-calendar failures. The gws agenda helper likewise cannot establish complete
coverage. Raw API list commands provide explicit continuation tokens and Google
expands recurrence. Pin gws 0.22.5's official static musl artifact with architecture-specific SHA256
checksums. Its GNU build requires GLIBC 2.39 while Raven's image has 2.36. The older
0.18.1 npm wrapper also carries vulnerable shrinkwrapped installer dependencies;
use neither that wrapper nor a base OS upgrade. The image executes gws --version
before installation completes. Local existing gws exports remain compatible.

## Implementation

- `packages/core/src/integrations/google-calendar/`: fixed-command subprocess
  adapter and stdio MCP entry, compiled with core. Expose only list_calendars and
  list_events. Bound command duration, output, pagination and date range. No shell
  interpolation or arbitrary URL/command. Sanitize provider failures.
- `library/mcps/google-calendar.json` and existing scheduling/calendar skill,
  mirrored in public seeds: two green read actions, no native tools or writes.
  MCP calls retain Raven's per-agent scope and mandatory permission hook.
- Calendar listing includes accessible hidden/shared subscriptions and pagination;
  event listing accepts one exact calendar ID and explicit RFC3339 interval and
  IANA timezone. Request singleEvents and exclude deleted events. Return source
  identifiers and timing metadata without local recurrence calculations.
- Partial pages survive later failures; repeated tokens, limits and provider errors
  produce explicit incomplete coverage. An empty list is never evidence that an
  unchecked calendar is empty. The skill queries each selected/requested calendar
  and distinguishes tasks, all-day reminders, tentative and busy meetings.
- Installer copies only specific bundled definitions, preserves custom definitions,
  stores normalized credentials privately outside Git and optionally adds calendar
  to the current default agent while preserving its other configuration. Reject
  unsafe paths and malformed input before changing installed state.
- `scripts/raven.sh setup-google-calendar` delegates to a setup script: accept an
  exported gws credentials file or run the owner's local gws read-only calendar
  login/export flow. Never echo credentials. Container setup uses stdin and durable
  data storage. Existing Google client configuration or a downloaded Desktop
  OAuth client is a Google prerequisite, documented rather than invented by Raven.
- Docker packages CLI, compiled entry and seeds; Compose points at the private
  exported credential path. No automatic login, heartbeat or live calendar writes.
  Do not enable calendar on unconfigured fresh agents. Document first-start setup.

## Acceptance and review

Given multiple calendar/event pages, when listing succeeds, return all pages and
complete coverage. Given a later page failure, repeat token, timeout or bound,
return preserved results and explicit partial coverage. Given a recurring exception,
all-day date or cancelled event, preserve Google's instance identity/date semantics
and omit cancellations. Given invalid dates/timezones or a range over 31 days,
reject before invoking the CLI. Given an unbound skill or any write tool, retain
Raven's fail-closed policy; calendar reads must work without a shell workspace grant.

Given valid exported credentials, setup installs the precise capability and binds
it when requested, preserving unrelated agent fields and files. Given custom
conflicting definitions or unsafe credential paths, fail without overwriting them.
Credential contents must not appear in logs, build context, Git or test fixtures.

Run focused adapter and installer behavioral tests, library validation, required
check, full default suite and Docker executable/context verification. Use fake
providers and isolated temporary state for routine tests. An owner-authenticated
read of a known work meeting is a separate final verification, possible only after
Google login and selection of the account with access; do not report it complete
from tool discovery or fixtures. Persist this distinction in the delivery record.

## Sources

- https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server
- https://developers.google.com/calendar/api/v3/reference/calendarList/list
- https://developers.google.com/calendar/api/v3/reference/events/list
- https://github.com/googleworkspace/cli
- https://github.com/nspady/google-calendar-mcp/blob/main/src/handlers/core/ListEventsHandler.ts

## Review resolutions

- Capability validation caught underscore action IDs; definitions now use Raven's
  canonical kebab-case permission IDs while MCP tools keep underscore names.
- Added iCalUID and the self attendee's response status so display deduplication
  and declined-meeting interpretation have actual source evidence.
- Invalid provider envelopes/items produce incomplete coverage rather than an
  empty successful day. Valid Google empty-list envelopes still succeed.
- Process cancellation waits for close, drains output and escalates TERM to KILL;
  pre-aborted calls cannot spawn. Fixture executables exercise these boundaries.
- Setup checks stopped state before credential selection/authentication/build.
  It refuses staged, unstaged and untracked changed installation targets, preserving
  unrelated staged files. A real Git fixture verifies this; no skips under escalation.
- Setup output distinguishes installed credentials from verified account access.
- No new npm dependencies remain. The pinned static executable is verified before
  installation; x64 was executed on the host and Node 22 slim. ARM64's release
  checksum is pinned but this x64 environment has not executed that architecture.

- Calendar runtime credentials use a dedicated GOOGLE_CALENDAR_CREDENTIALS_FILE
  variable so Calendar setup does not satisfy Gmail/Drive watcher prerequisites.

- Credentials and CLI cache are stored under operational data, which existing
  runtime history excludes, rather than the tracked configuration tree.

## Verification and deployment status

Implementation is reviewed and ready for deployment, with these September 6 checks:

- Full default suite: 270 files, **2,705 tests passed**.
- Required `npm run check`: passed (format, lint, types, strip-only parse, dependency checks).
- Library validation and compiled core build: passed.
- Deployment suite: **32 tests passed**, no skips, including real Git restart/setup,
  unchanged owner state, forced Google reconnect and credentials excluded from history.
- Launcher suite: **18 tests passed** using fake Docker.
- Pinned gws 0.22.5 x64 installer/binary: actual release download, SHA256, executable
  version and Node 22 slim compatibility verified. ARM64 was not executed here.
- Metadata-only live Google check: existing authorized-user credentials returned
  `invalid_grant`. No calendars or events were retrieved. Reauthentication required.
- Full production image build: **not completed**. Docker BuildKit's metadata DB
  became read-only during `npm ci`; Docker Desktop WSL integration then disappeared.
  The full Docker context/build, installation, healthy start and a known work meeting
  in combined Planning chat remain explicitly unverified. No live data was reset.

After Docker Desktop restarts, run the documented stop/setup/start flow, select
`login` to replace the invalid Google grant, and verify the work calendar. Google
login requires the owner's browser consent; no credentials are committed or printed.
