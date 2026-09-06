# Deploying Raven

Raven runs as a core service and a Next.js dashboard. The default Compose setup
starts with graph knowledge disabled and a Raven agent explicitly bound to the
credential-free `repository-work` skill.
The dashboard, project definitions and local memory work without external
integrations; model responses require deliberate Claude authentication.

## Build and start

For local testing, save settings in the ignored `.env` and use the launcher:

```sh
./scripts/raven.sh start
./scripts/raven.sh status
./scripts/raven.sh logs
./scripts/raven.sh stop
```

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
services and the current SQL schema. It also includes the in-repo TickTick server source,
which runs using Node's `--experimental-strip-types`. Its native baseline includes
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
| `raven_data`     | `/app/data`          | SQLite, Raven sessions, logs, knowledge Markdown, definition Git metadata                                        |
| `raven_projects` | `/app/projects`      | Project context, named agents, templates, schedules, project memory, board tasks, execution trees and agent runs |
| `raven_library`  | `/app/library`       | Capability definitions and deliberately installed vendor plugins                                                 |
| `raven_config`   | `/app/config`        | Runtime configuration files                                                                                      |
| `raven_claude`   | `/home/node/.claude` | Claude authentication/configuration and SDK session transcripts                                                  |
| `neo4j_data`     | `/data` in Neo4j     | Optional knowledge relationships, membership and graph metadata                                                  |

On first startup, the entrypoint copies only the explicit
[`deployment/seeds`](../deployment/seeds) into each **empty** projects/library/config
root. A nonempty root is left intact; seed files are never merged into existing
definitions. A nonempty library does not receive newly added starter skills; review
the public seed and copy/bind it deliberately if wanted. The native starter has no
external MCP/vendor dependencies or schedules and makes no
automatic vendor downloads. Definitions authored in a development checkout are
not included in the build context.

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

## Add capabilities

Fresh installations bind `repository-work` for native repository tools and start
with no external skill bindings. Add definitions under
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
image or an explicit executable mount. For the packaged TickTick server, use
`node --experimental-strip-types /app/packages/mcp-ticktick/src/index.ts` in its
MCP definition and supply its credentials separately. Installing these optional
integrations is an operator action; startup does not download or enable them.

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

## Browser endpoints and TLS

`NEXT_PUBLIC_CORE_API_URL` and `NEXT_PUBLIC_CORE_WS_URL` are **web build arguments**.
They must be reachable by the user's browser. A Docker service hostname is not a
browser endpoint, and changing container environment variables after building
does not rewrite the browser bundle.

For a remote deployment behind your authenticated TLS reverse proxy, place these
in the explicit Compose environment file and rebuild `raven-web`:

```dotenv
NEXT_PUBLIC_CORE_API_URL=https://raven.example.com/api
NEXT_PUBLIC_CORE_WS_URL=wss://raven.example.com/ws
```

Route `/api` and `/ws` to core on port 4001, including WebSocket upgrades; route
the dashboard and `/_next` assets to port 4000. The Compose file does not provide
a reverse proxy. The defaults continue to target local development ports.

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
