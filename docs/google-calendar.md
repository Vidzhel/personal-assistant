# Google Calendar setup

Raven can read your Google calendars and meetings alongside TickTick tasks.
It reads Google directly: a calendar subscribed only inside TickTick must also be
accessible to the Google account you connect. Shared work calendars are supported
when that account can read them. Event writes are not exposed by this capability.

## First start or existing installation

Run from the Raven checkout:

```bash
./scripts/raven.sh stop
./scripts/raven.sh setup-google-calendar
./scripts/raven.sh start
```

Setup accepts an existing **exported gws credentials file**, installs the Calendar
capability into the persistent library and adds `calendar` to the default Raven
agent without replacing its other skills. Credentials are copied privately into
the container's data volume, outside Git. The host path is not a container path.
If `.env` already points `GWS_PRIMARY_CREDENTIALS_FILE` at an exported file, setup
can reuse it. Custom conflicting Calendar definitions require deliberate resolution.

For a new Google connection:

1. In [Google Cloud Console](https://console.cloud.google.com/), choose a project
   and enable only the **Google Calendar API**.
2. Configure the OAuth consent screen; add your account as a test user if the app
   is in testing. Create a **Desktop app** OAuth client, download its JSON, and
   save it at `~/.config/gws/client_secret.json` on your own computer. This client
   JSON is different from exported credentials containing a refresh token.
3. With the Google Workspace CLI installed locally, leave the exported-file prompt
   empty. Setup runs a Calendar-only read login and exports credentials privately.
   Complete Google's browser consent for the account with access to your work
   calendar. Do not paste credentials into Raven chat or commit them.

Equivalent manual export, if you authenticate on another computer:

```bash
gws auth login --scopes https://www.googleapis.com/auth/calendar.calendarlist.readonly,https://www.googleapis.com/auth/calendar.events.readonly
umask 077
gws auth export --unmasked > google-calendar-credentials.json
```

Supply that exported file to setup. OAuth refresh credentials remain sensitive;
remove temporary exports once imported. Google Workspace administrators may restrict
third-party OAuth access. Google testing-mode refresh tokens can expire after seven
days; see [Google's OAuth guidance](https://developers.google.com/identity/protocols/oauth2#expiration).
Re-run setup and type `login` at the credentials prompt, or supply a fresh export,
if Google revokes/expires access. An `invalid_grant` response means the existing
refresh credentials cannot be reused. Do not repeatedly
retry a denied organizational policy.

## Use in Raven

Open the Planning project and start a new conversation after setup. Ask:

> Check my Google calendars and TickTick tasks for tomorrow. Include my work
> calendar, show meetings separately from tasks, and tell me which calendars you checked.

Confirm the work calendar name/ID on first use and ask Raven to remember that choice.
For a custom named agent, add `calendar` to its skill list. The default setup binds
only the default Raven agent; it does not grant every agent calendar access.

The adapter follows calendar and event continuation pages within bounded limits,
expands recurring instances through Google, and reports incomplete results. The
agent must report unavailable calendars and avoid interpreting partial results as
free time. It preserves all-day dates and occurrence identities, and separates
calendar events from TickTick tasks. This is an on-demand chat capability, not a
new calendar dashboard or automatic background synchronization.

## Runtime and verification

The image packages the checksum-pinned gws **0.22.5** standalone musl executable
and runs it during the build. Its GNU executable needs GLIBC 2.39; the standalone
musl build avoids that incompatibility with the current container. The adapter uses fixed
read-only raw API commands, not the CLI agenda helper or arbitrary shell commands.
Compose uses `/app/data/google-calendar/credentials.json`; local core runs can
set `GOOGLE_CALENDAR_CREDENTIALS_FILE` in `.env` to an exported file. The older
`GWS_PRIMARY_CREDENTIALS_FILE` belongs to the separate Gmail/Drive services;
Calendar setup can import it without enabling those services. Build core before using its
compiled stdio adapter locally, and ensure a compatible `gws` executable is on PATH.

Google's [official Calendar MCP](https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server)
is currently in Developer Preview. Raven has not yet added durable OAuth refresh
for HTTP MCP connections. This integration uses Google's stable Calendar API via
the Google Workspace CLI; it is not that preview MCP server.

Automated checks use fake calendars and credentials. A successful build or tools
listing does not prove access to your work calendar: verify an actual known meeting
in the Planning conversation after authentication.
