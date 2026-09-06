# Deploying Raven

Raven runs as a core service and a Next.js dashboard. The default Compose setup
starts with graph knowledge disabled and a Raven agent explicitly bound to the
credential-free `repository-work` skill and the official TickTick skill. TickTick
remains unavailable until its dedicated MCP token is configured.
The dashboard, project definitions and local memory work without external
integrations; model responses require deliberate Claude authentication.

## Build and start

For local testing, save settings in the ignored `.env` and use the launcher:

```sh
# Optional before first start; see the TickTick token instructions below
./scripts/raven.sh setup-ticktick
./scripts/raven.sh start
./scripts/raven.sh status
./scripts/raven.sh logs
./scripts/raven.sh stop
```

If `.env` does not exist yet, copy `.env.example` to `.env` and review its settings
first. Do not overwrite an existing `.env`. To use TickTick, follow
[Configure the official TickTick MCP](#configure-the-official-ticktick-mcp) before
starting; otherwise skip that setup command. Setup requires Node.js 22.22.0 or
newer on the host as well as Docker and Compose.

Start builds the images and checks authentication in the persistent Claude
volume. If needed, it runs the interactive login flow. It then waits for Neo4j
when the knowledge profile is enabled and starts core/dashboard. A failed build,
login or graph startup stops the command before starting Raven. Stop retains
volumes. `./scripts/raven.sh login` explicitly refreshes authentication. The
launcher requires Bash, Docker and Compose v2, and works from any directory.
It passes `.env` to Compose without executing its contents as shell code. An
alternate file can be selected with `RAVEN_ENV_FILE=/absolute/path/deployment.env`.
Compose still gives already exported shell variables precedence over file values.

To persist a local test stack with repositories and graph knowledge, configure:

```dotenv
COMPOSE_PROJECT_NAME=raven-test
COMPOSE_FILE=docker-compose.yml:docker-compose.workspace.yml
COMPOSE_PROFILES=knowledge
RAVEN_WORKSPACE_ROOT=/absolute/path/to/repositories
RAVEN_TIMEZONE=Europe/Kyiv
NEO4J_ENABLED=true
NEO4J_PASSWORD=choose-and-save-your-graph-password
```

Preserve existing credentials/settings when editing `.env`. Keep the graph
password with its volume across restarts. Omit the workspace override/root to
work only in managed homes, or omit the knowledge profile and use
`NEO4J_ENABLED=false` to run without graph knowledge. Docker receives only the
variables wired by the Compose configuration; integration credentials in `.env`
are not automatically passed to every container.

Use Docker Compose v2. Run commands from the repository root. These examples use
`--env-file /dev/null` so Compose does not automatically read a development `.env`.

```sh
docker compose --env-file /dev/null config --quiet
docker compose --env-file /dev/null build
docker compose --env-file /dev/null up -d
```

Open `http://localhost:4000`; core health is at
`http://localhost:4001/api/health`. Ports bind to the host's loopback interface.
Core's health response reports graph availability separately from service health.

The core image builds shared/core from the lockfile and includes the compiled
services and the current SQL schema. Its native baseline includes
Bash, Git/SSH, curl, Python/venv, make/g++, ripgrep, jq, file, unzip, Pandoc,
Poppler and FFmpeg. It supports shell work, repository commits and common document
pipelines; repository-specific packages and render engines remain separately
installed in the repository environment or an extended image. The web image serves
the monorepo standalone output and its static files. Images run as the unprivileged
`node` user (UID 1000).

## Persistent inputs and upgrades

Compose creates named volumes; it does not mount the checkout's working data.

| Volume           | Container path       | Contents                                                                                                         |
| ---------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `raven_data`     | `/app/data`          | SQLite, Raven sessions, logs, knowledge Markdown, embedding model cache, definition Git metadata                 |
| `raven_projects` | `/app/projects`      | Project context, named agents, templates, schedules, project memory, board tasks, execution trees and agent runs |
| `raven_library`  | `/app/library`       | Capability definitions and deliberately installed vendor plugins                                                 |
| `raven_config`   | `/app/config`        | Runtime configuration files                                                                                      |
| `raven_claude`   | `/home/node/.claude` | Claude authentication/configuration and SDK session transcripts                                                  |
| `neo4j_data`     | `/data` in Neo4j     | Optional knowledge relationships, membership and graph metadata                                                  |

On first startup, the entrypoint copies only the explicit
[`deployment/seeds`](../deployment/seeds) into each **empty** projects/library/config
root. A nonempty root is left intact; seed files are never merged into existing
definitions. A nonempty library does not receive newly added starter skills; use the
explicit TickTick setup action below to install that shipped capability into an
existing volume. The starter makes no automatic vendor downloads and does not probe
external accounts during initialization. Definitions authored in a development
checkout are not included in the build context.

If first startup is interrupted, a small pending-seed journal in
`data/definition-history/raven-bootstrap.json` lets the next startup finish only
the original seed files and commit them. It verifies their recorded hashes before
continuing. A file edited during recovery, or a changed image seed needed to
finish the copy, stops initialization with an explicit error instead of
overwriting it. Restore the original seed/image to finish normally; for deliberate
custom recovery, reconcile and commit the listed files before removing the pending
journal using a maintenance container with `--entrypoint sh`.

Git uses `/app` as its worktree and `/app/data/definition-history` for persisted
metadata. The entrypoint recreates the disposable `/app/.git` pointer after an
image replacement. Only explicit definition/memory paths are committed; unrelated
staged changes remain staged. Runtime data, credentials under `.env*`, and vendor
checkouts are excluded from this history. Keep integration secrets out of
definition files; this private history includes committed memory. No Git remote
is configured by the entrypoint.

To upgrade, back up these volumes together, build the new images and run
`docker compose --env-file /dev/null up -d` again. Fresh SQLite initialization runs
the packaged schema atomically; restart preserves its operational state. This
pre-use schema cleanup does not support databases initialized by the retired
historical migration chain: startup reports unsupported history instead of
converting or deleting it. Use a fresh dedicated runtime database for that
transition. The model-controls release requires operational schema
version 3, including session model overrides, durable conversation bindings and delivery attempts; an
earlier `001-initial-schema` database is also rejected explicitly. Startup never
resets the owner's database. Project files and Git history remain in their volumes.
Review future seed changes explicitly if you want to adopt them. Use one core
instance for these volumes. If using bind mounts, create dedicated runtime
directories writable by UID 1000; do not point the initializer at a source Git
checkout or symlinked roots. Restoring data/history without matching definition
volumes is not a substitute for restoring a complete backup.

### Telegram project conversations

Set `TELEGRAM_BOT_TOKEN` and the owner's `TELEGRAM_CHAT_ID` in the ignored `.env`.
Private bot chat starts in Inbox / Today. Send `/project` to list current project
IDs and `/project <id>` to select one. `/new` starts a fresh session; replying to
an older Raven message continues that message's session, including after restart.

For a forum group, also configure `TELEGRAM_GROUP_ID`, `TELEGRAM_TOPIC_GENERAL`
and `TELEGRAM_TOPIC_SYSTEM`. The bot must have permission to manage topics.
General handles Inbox conversations and general updates; System handles system
alerts. Run `/project <id>` inside another topic to bind it to that project.
Only the configured owner can send commands or invoke action buttons. Rebinding
a topic invalidates replies belonging to its former project. Agent names appear
within project conversations instead of creating separate agent topics.

Settings shows recent Telegram delivery evidence, including provider message IDs
and failed, partial or unknown attempts. Unknown means a request may have reached
Telegram; Raven does not automatically resend it. A local fake-provider test does
not establish account delivery. After setup, send a harmless message yourself and
verify its project, response and delivery entry before relying on notifications.

Project mutation recovery is reported by `GET /api/project-recovery`. The
response contains mutation IDs, paths, operation states and repair messages;
it does not expose the recorded file bytes. After checking a `published`
entry, request `POST /api/project-recovery/<mutation-id>/recover`. A changed
file remains a `409` conflict and is retained for deliberate reconciliation;
the recovery endpoint does not overwrite it. Startup attempts the same
current-format recovery before loading the project registry and synchronizing
the SQLite cache. A pending or conflicting entry keeps its project unavailable
for new mutations until it is repaired.

## Authenticate Claude deliberately

The installed Agent SDK bundles the native Claude executable. Its supported
`auth login` command can initialize the separate authentication volume:

```sh
docker compose --env-file /dev/null run --rm raven-core sh -c \
  'exec /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-$(node -p process.arch)/claude auth login'
```

Complete the displayed login flow yourself, then start or restart core. The image
sets `CLAUDE_CONFIG_DIR=/home/node/.claude`, keeping both authentication and SDK
resume files in `raven_claude`. Raven's own session files remain in `raven_data`;
persist both volumes to retain conversation resume state. Existing host CLI
authentication is not automatically copied into the container. If you choose to
bind an existing Claude configuration directory instead, point the mount at that
same container path and grant the container user write access.

See the provider's [CLI authentication commands](https://code.claude.com/docs/en/cli-usage)
and [configuration directory layout](https://code.claude.com/docs/en/claude-directory).
Authentication and paid model calls are intentionally outside the automated smoke
tests. For a supported API-key setup or additional integration credentials, use a
private Compose override with an explicit service `env_file`; Compose's
`--env-file` alone only supplies values for interpolation and does not pass every
variable into core. Never copy credentials into an image or capability definition.

## Configure the official TickTick MCP

Follow the [official TickTick MCP guide](https://help.ticktick.com/articles/7438129581631995904).
In TickTick on the web, open **Settings → Account → API Token** and create a
dedicated MCP token. Copy it and paste it into the launcher's hidden prompts;
Raven saves it in `.env` for you. This token is separate from the retired Open API client and
access-token credentials. Stop Raven, then run the setup action and enter the same
token twice at its hidden prompts:

```sh
./scripts/raven.sh stop
./scripts/raven.sh setup-ticktick
./scripts/raven.sh start
```

On a fresh installation that has never started, omit the `stop` command. After
startup, open the project's **Workspace** tab and inspect readiness. Confirm the
TickTick connection and tools checks succeed, then ask the agent to list your
TickTick projects without changing anything.

The setup action refuses to change the durable capability volume while any Compose
service is running. It builds the current core image, checks that the bundled files
can replace only an absent or exact previously shipped TickTick definition, and
then atomically updates only `TICKTICK_MCP_TOKEN` in the selected environment file.
The token travels to the settings helper over standard input and is never placed in
a process argument or success message. Unrelated environment lines and file mode
are preserved, and a prospective Compose configuration must pass before replacement.

The final one-shot container installs the official MCP definition and standalone
usage skill into `raven_library`. Existing owner index files and every unrelated
library file are preserved. A customized TickTick definition produces a conflict
instead of being overwritten. Each target file is replaced atomically and a retry
accepts files already at the official version; the several file replacements are
not one filesystem transaction. If installation fails after the environment update,
leave Raven stopped, resolve the reported definition conflict, and repeat
`setup-ticktick`. A configured but unused token does not contact TickTick.

The official service uses Streamable HTTP at `https://mcp.ticktick.com`. Raven
keeps one active TickTick backend and does not fall back to the retired local
adapter. Automated tests use a fake local MCP server and never authenticate to the
owner's account. After startup, check project readiness and deliberately verify a
harmless account read before relying on the integration. Do not treat configured
credentials or a fake-server test as proof of live access.

Fresh deployments include the TickTick skill in the default Raven agent. The
installer does not rewrite existing owner project or agent definitions; if an older
deployment's selected agent does not already list `ticktick`, add that skill through
the existing agent update flow after installation.

## Add capabilities

Fresh installations bind `repository-work` and the configured official TickTick
capability. Add other definitions under
`/app/library/skills/<path>/config.json` and `skill.md`, and MCP definitions under
`/app/library/mcps/`, using Raven's existing scaffold-and-activate tools where
appropriate. Add each intended skill name to the agent's explicit `skills` list.

Install each referenced MCP executable and vendor plugin deliberately before
binding it. The resolver checks full named definition references and rejects a
missing skill, MCP definition or vendor skill; it does not test live credentials
or guarantee an external executable works. Vendor definitions must contain an
actual `SKILL.md` at the declared path or conventional `skills/<name>` path, or
the referenced plugin's `.claude-plugin/plugin.json`. Empty placeholder folders
do not make vendor skills available.

For source development, initialize the required recorded submodule explicitly,
for example:

```sh
git submodule update --init --recursive -- library/vendor/anthropic-skills
```

This downloads the revision recorded by the checkout; it is not run by Raven or
the deployment tests. Source vendor folders still stay out of the Docker build
context. Populate the deployment's library volume separately with the selected
plugin files if you intend to bind those skills there.

External binaries such as Google Workspace tooling require your own extended
image or an explicit executable mount. Installing optional integrations is an
operator action; startup does not download or enable them.

## Enable graph knowledge

Create a private deployment environment file with these values, choosing your
own password:

```dotenv
NEO4J_ENABLED=true
NEO4J_PASSWORD=replace-with-your-graph-password
```

Start and wait for the opt-in graph before starting core:

```sh
docker compose --env-file /absolute/path/deployment.env --profile knowledge up -d --wait neo4j
docker compose --env-file /absolute/path/deployment.env --profile knowledge up -d raven-core raven-web
```

The graph profile does not itself set `NEO4J_ENABLED`. Core has no mandatory
Compose dependency on Neo4j and remains useful if graph initialization fails.
Graph relationships and project memberships live in Neo4j; preserve its volume
alongside `raven_data`. Markdown alone cannot restore those relationships.

## Private phone access

The optional private-access Compose override adds Caddy on
`127.0.0.1:4002`. Caddy requires the same owner HTTP Basic authentication before
routing every path: `/api`, `/api/*` and `/ws` go to core, while the dashboard,
`/_next/*` and all other paths go to web. Core and web retain their existing
loopback ports. Do not publish port 4002 on a LAN interface or use its plain HTTP
listener remotely; Tailscale Serve supplies the private HTTPS endpoint.

Install Tailscale on the host, sign in explicitly, enable HTTPS for the tailnet
and apply owner-only ACLs. Configure persistent private serving to the gateway:

```sh
tailscale serve --bg 4002
tailscale serve status
```

The first command reports the private `https://<device>.<tailnet>.ts.net` origin.
It may open an operator consent page when tailnet HTTPS is not enabled. Do not use
Tailscale Funnel, which is public. Account login, device enrollment and ACL changes
remain operator actions; Raven never performs them.

Prepare Raven with the reported origin and a separate owner password:

```sh
./scripts/raven.sh setup-private-access
./scripts/raven.sh start
```

After private setup, use the configured Tailscale HTTPS origin to open Raven.
The private web build routes API and WebSocket traffic through that same origin;
the direct loopback web port is only an internal upstream in this mode.

The setup action reads the origin, username, password and confirmation from
standard input. The username is restricted to a bounded HTTP Basic identifier and
the password must contain 12–256 characters. Password spaces and shell syntax are
treated as data. Raven sends the password to `caddy hash-password` over stdin,
stores only the bcrypt hash, and never places the plaintext in a URL or process
argument. It atomically updates the selected `.env` file, preserves unrelated
settings, and adds `docker-compose.private.yml` to `COMPOSE_FILE`. Invalid input,
duplicate managed settings, hashing failure, or a failed prospective Compose
validation leaves the file unchanged. Rerun the action to rotate the owner
password.

The generated settings are:

```dotenv
COMPOSE_FILE=docker-compose.yml:docker-compose.private.yml
RAVEN_BASE_URL=https://raven-host.example.ts.net
RAVEN_PRIVATE_USERNAME=owner
RAVEN_PRIVATE_PASSWORD_HASH='$2a$14$...'
```

Keep the hash single-quoted so Compose does not interpolate its dollar signs. A
workspace override may remain in the list, for example
`docker-compose.yml:docker-compose.workspace.yml:docker-compose.private.yml`.
The private override builds the browser with `/api` and a runtime same-origin
WebSocket, so dashboard requests, reconnects and file previews use the one private
origin. `RAVEN_BASE_URL` is also core's canonical browser and artifact-link origin.
For explicit development origins, use the bounded comma-separated
`RAVEN_BROWSER_ORIGINS`; absent Origin remains available to trusted local health
clients and the authenticated gateway.

Open the reported HTTPS URL on the enrolled phone, complete the browser's Basic
authentication challenge, send a harmless message, then preview and download a
project artifact. Reload once and confirm chat reconnects. Separately verify that
an unauthorized browser receives `401` for the page, API, WebSocket and artifact
URL. This real-device canary is the evidence for phone access; local proxy tests do
not establish tailnet enrollment or delivery.

`./scripts/raven.sh stop` stops the Compose services but deliberately leaves the
operator-owned Tailscale configuration alone. Run `tailscale serve off` to stop
sharing the gateway. See the current
[Tailscale Serve command](https://tailscale.com/docs/reference/tailscale-cli/serve)
and [Caddy Basic authentication](https://caddyserver.com/docs/caddyfile/directives/basic_auth)
documentation when changing this setup.

For ordinary source development without the private override,
`NEXT_PUBLIC_CORE_API_URL` and `NEXT_PUBLIC_CORE_WS_URL` remain web build arguments
and the base Compose defaults continue to target the host's loopback ports.

## Isolated verification

```sh
npm run build:core
npm run test:compiled
npm run test:deployment
npm run build:web
docker build -f Dockerfile.core -t raven-core:check .
docker build -f Dockerfile.web -t raven-web:check .
npm run test:containers -- raven-core:check raven-web:check
```

The compiled smoke uses a fake model boundary, disabled graph/integrations, real
HTTP services and temporary roots. It exercises packaged migrations, restart,
definitions, memory and real Git history. Deployment initializer tests exercise
the actual Git helper in disposable repositories with owner Git configuration
disabled. Container smoke uses isolated temporary volumes and `--network none`;
it checks core restart persistence, a temporary attached repository, actual native
commands and a local Git push, project memory/settings, file API bytes and the
standalone web page/static assets including the PDF worker. None of these checks
starts the owner's assistant or uses owner accounts.

## Attach repository folders

The optional workspace override exposes an existing host directory at `/workspace`.
Use a dedicated parent containing the repositories you want to attach; their internal
layouts remain unchanged. The container process needs write permission as UID 1000.
The mount option rejects a missing directory instead of creating one implicitly.

Save the mount settings in `.env`:

```dotenv
COMPOSE_FILE=docker-compose.yml:docker-compose.workspace.yml
RAVEN_WORKSPACE_ROOT=/srv/raven-repositories
```

Then start or recreate the stack with:

```sh
./scripts/raven.sh start
```

In each Raven project's **Workspace** tab, attach its container path, for example
`/workspace/disertation` or `/workspace/teaching`. Add relative paths to existing
instructions/index files under **Context files**, select the working folder and
execution mode, and save. Agents read those indexes when needed; Raven does not
embed or copy the repository. The managed home remains available for project
anchors, shared memory and task YAML. Repositories keep their own output layouts.

If attachment returns `400` for an existing host folder, check the container path.
For example, a parent mounted at `/workspace` makes its `disertation` folder
available as `/workspace/disertation`, even if its host path is different. The
Workspace form shows folder errors in a banner that remains visible when scrolled;
correct the path and attach again. Dismissing an error preserves the form draft.

If an agent reports `Bash access is disabled (access: none)`, select the attached
repository under **Working folder**, choose **Auto** or **Full** for autonomous
repository commands, and click **Save execution settings**. Default mode retains
the agent's configured native-tool policy. Send a new chat message after saving;
the changed execution settings start a fresh SDK session automatically.

Use the same override when recreating containers so persisted attachments retain
their paths. For repositories in different host locations, a private override can
bind each to a distinct container path. Detaching in Raven leaves the repository
untouched. Host-mounted repositories and their Git history need their own backups;
Raven's named volumes contain the source descriptors, not those files.

Git can use HTTPS or SSH. Configure the repository's remote, commit identity and
intended credentials inside this runtime environment; the mount does not transfer
host credential helpers, SSH agents or keys automatically. The default image has
no Git remote or private credentials.

## Repository execution

Project `project.yaml` selects a folder source as cwd; without a selection, work
runs in the managed project home. Paths are server paths. In Docker, mount each
repository and configure its path inside the container. Native shell, Git, build
and rendering tools must be installed in that environment, with the repository's
own dependencies and intended Git authentication.

Workspace modes are `default`, `auto` and `full`. Auto delegates native permission
decisions to the installed Claude SDK classifier (subject to SDK/account support);
full enables SDK bypass with trusted host access. Integration permissions remain
under Raven's pre-tool policy. This is the owner's trusted execution machine, not
a filesystem sandbox or a change of OS user. Full mode cannot grant root access
to the unprivileged container process. Install system tools in an image extension
(as root during its build, then restore `USER node`); Python/Node project packages
can use writable repository environments. Quarto, TeX, .NET and LibreOffice are
examples of repository-specific additions, not bundled tools. Grant changes reject
subsequent local dispatch/tool work; already executing commands or remote operations
can still finish.

Attached repositories load their SDK project/local settings and instructions.
Managed homes exclude filesystem settings to avoid Raven development settings.
Ambient MCP servers and SDK automatic memory are disabled; project memory and
explicitly bound capabilities remain Raven-owned. Revision mismatches start cold
SDK sessions, including after restart. The project's Workspace tab manages folder
attachments, context-file links and execution settings. Browser file access uses
Linux `/proc/self/fd` and requires regular files beneath a current managed home or
attached folder; symlink components and special files are refused. Listings visit
at most 500 entries; use the direct path field for a known file outside that list.
Text previews are limited to 1 MiB, PDF previews to 32 MiB, and downloads to
512 MiB. PDF.js and its worker are bundled with the dashboard; PDF preview needs
no external viewer/CDN or server render command. Static HTML previews
exclude scripts and external resources; generate a self-contained report in the
repository. Office/media formats can be downloaded, or repository tools can render
a PDF/image/HTML artifact for preview. Removing an attachment never deletes its files.
