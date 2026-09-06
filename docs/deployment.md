# Deploying Raven

Raven runs as a core service and a Next.js dashboard. The default Compose setup
starts with graph knowledge disabled and a minimal Raven agent with `skills: []`.
The dashboard, project definitions and local memory work without external
integrations; model responses require deliberate Claude authentication.

## Build and start

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
which runs using Node's `--experimental-strip-types`. The image contains Git for
definition and memory commits. The web image serves the monorepo standalone
output and its static files. Images run as the unprivileged `node` user (UID 1000).

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
definitions. The starter has no external MCP bindings or schedules and makes no
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
transition. Project files and Git history remain in their volumes.
Review future seed changes explicitly if you want to adopt them. Use one core
instance for these volumes. If using bind mounts, create dedicated runtime
directories writable by UID 1000; do not point the initializer at a source Git
checkout or symlinked roots. Restoring data/history without matching definition
volumes is not a substitute for restoring a complete backup.

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

Fresh installations start with no external skill bindings. Add definitions under
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
it checks core restart persistence and the actual standalone web page/static
asset. None of these checks starts the owner's assistant or uses owner accounts.

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
a filesystem sandbox. Grant changes reject subsequent local dispatch/tool work;
already executing commands or remote operations can still finish.

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
