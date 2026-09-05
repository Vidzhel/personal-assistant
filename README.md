# Raven - Personal Assistant

Raven is a personal assistant for one owner: keep useful context, reduce routine
coordination, and carry out work within explicit permission boundaries. It uses
the Claude Agent SDK, a capability library, readable file definitions and a web
dashboard. Claude and Codex can both develop the project using the same guide.

## Features

- **Project chats** — persistent sessions, streaming replies, recoverable drafts,
  task controls and approval decisions.
- **Learning** — interactive retrospectives produce candidate files; consolidation
  promotes durable agent memory and retains candidates when an operation fails.
- **Extension from chat** — create and activate skills, agents, templates and
  schedules through the existing runtime tools.
- **Bounded reminders** — deterministic intents have budgets, cooldowns and expiry;
  optional heartbeat stays silent when there is nothing useful to report.
- **Optional integrations** — TickTick tasks, Gmail monitoring, Google Workspace
  through the gws CLI, Telegram delivery and Gemini transcription.
- **Optional graph knowledge** — linked knowledge and retrieval backed by Neo4j;
  chat and file-based agent memory work with the graph disabled.

Integrations require their definitions, executables and credentials to be configured
and explicitly bound where used. A fresh Docker install starts with no external
capability bindings or schedules. Repository attachments and separate project-owned
memory remain planned work.

## Quick Start

### Prerequisites

- Node.js 22.22.0 or newer and npm 10.9.8 (the declared package manager).
- Claude authentication for model responses. The owner's normal setup uses the
  Claude CLI account; an API key is an alternative deliberately configured setup.
- Docker and Compose v2 for container deployment or opt-in Neo4j integration tests.

### System Dependencies

Install optional tools only for the capabilities you intend to bind. The core
runtime does not install vendor tools automatically.

| Dependency       | Purpose                                                        |
| ---------------- | -------------------------------------------------------------- |
| Node.js 22.22.0+ | Runtime                                                        |
| Python / uv      | Selected Python MCP servers; follow that server's requirements |
| FFmpeg           | Audio/video processing skills                                  |
| LibreOffice      | Document conversion (docx/xlsx/pptx skills)                    |
| Poppler          | PDF rendering — pdftoppm (pdf skill)                           |
| Pandoc           | Document reading (docx skill)                                  |
| Tesseract        | PDF OCR (pdf skill)                                            |

### Local Development

```bash
# Install dependencies
npm install

# Create local configuration and enable only intended integrations
cp .env.example .env
# Configure Claude authentication and review .env before starting core

# Build and run
npm run build
npm run dev:core    # Start the backend
npm run dev:web     # Start the dashboard (separate terminal)
```

### Docker

```sh
docker compose --env-file /dev/null build
docker compose --env-file /dev/null up -d
```

Follow [the deployment guide](docs/deployment.md) for persistent volumes, deliberate
Claude authentication, optional graph/integrations, backups and browser endpoints.
Compose interpolation files do not automatically pass every variable into core.

- Dashboard: http://localhost:4000
- API: http://localhost:4001/api/health

## Environment Variables

Use [.env.example](.env.example) for local setup and
[core configuration](packages/core/src/config.ts) for current defaults. Leave
unused integration credentials unset. Model responses need authentication;
isolated tests supply a fake model boundary instead.

| Variable                         | Description                                                                               |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`              | Optional API-credit authentication; leave unset for the owner's CLI-auth setup            |
| `CLAUDE_MODEL`                   | Optional model override; current default is defined in core configuration                 |
| `TICKTICK_CLIENT_ID`             | TickTick OAuth app client ID                                                              |
| `TICKTICK_CLIENT_SECRET`         | TickTick OAuth app client secret                                                          |
| `TICKTICK_ACCESS_TOKEN`          | TickTick OAuth access token                                                               |
| `GMAIL_IMAP_USER`                | Gmail address for IMAP monitoring                                                         |
| `GMAIL_IMAP_PASSWORD`            | Gmail app password (not regular password)                                                 |
| `GMAIL_CLIENT_ID`                | Google OAuth client ID (for Gmail MCP)                                                    |
| `GMAIL_CLIENT_SECRET`            | Google OAuth client secret                                                                |
| `GMAIL_REFRESH_TOKEN`            | Google OAuth refresh token                                                                |
| `TELEGRAM_BOT_TOKEN`             | Telegram bot token from @BotFather                                                        |
| `TELEGRAM_CHAT_ID`               | Your Telegram chat ID for notifications                                                   |
| `TELEGRAM_GROUP_ID`              | Telegram group/supergroup ID for topic threads (optional)                                 |
| `TELEGRAM_TOPIC_GENERAL`         | General topic thread ID (optional, group mode)                                            |
| `TELEGRAM_TOPIC_SYSTEM`          | System alerts topic thread ID (optional, group mode)                                      |
| `TELEGRAM_TOPIC_MAP`             | JSON mapping topic names to thread IDs, e.g. `{"Work":5}` (optional)                      |
| `GWS_PRIMARY_CREDENTIALS_FILE`   | Path to primary gws CLI credentials JSON                                                  |
| `GWS_SECONDARY_CREDENTIALS_FILE` | Path to second account credentials JSON (optional)                                        |
| `GWS_GCP_PROJECT_ID`             | GCP project ID for Gmail Pub/Sub watch (optional)                                         |
| `GOOGLE_API_KEY`                 | Google AI API key for Gemini voice transcription (optional)                               |
| `RAVEN_TIMEZONE`                 | Timezone for schedules (e.g., `Europe/London`)                                            |
| `RAVEN_DIGEST_TIME`              | Legacy unused setting; edit the morning-digest schedule definition to set its cron time   |
| `RAVEN_MAX_CONCURRENT_AGENTS`    | Max parallel AI agents (default: `3`)                                                     |
| `RAVEN_MAX_BUDGET_USD_PER_DAY`   | Legacy unused setting; it does not enforce a global daily spending limit                  |
| `NEO4J_ENABLED`                  | `false` disables all graph connections; `.env.example` and default Compose start disabled |

## Development with Claude or Codex

Use the declared npm version for installation: npm 11.7 was observed ignoring a
workspace security override. The normal check verifies the installed resolution.
See the [dependency review](docs/assessments/2026-09-05-dependency-review.md) for
the fixes, native/model verification and the opt-in embedding smoke command.

Both use [AGENTS.md](AGENTS.md); [CLAUDE.md](CLAUDE.md) loads it for Claude and
preserves Claude's workflow. Existing BMAD skills
are available in `.agents/skills/`, with Codex browser-testing skills and an
optional `.codex/agents/browser-tester.toml` specialist. This is development
support; Raven itself still runs through the Claude Agent SDK.

The [current reliability assessment](docs/assessments/2026-09-05-reliability-completion.md)
summarizes the implemented improvements against Raven's philosophy. The
[completion record](_bmad-output/implementation-artifacts/reliability-completion-2026-09-05.md)
is the current task queue and dated verification evidence; the
[deferred ledger](_bmad-output/implementation-artifacts/deferred-work.md) records
concrete remaining fixes. March and August plans are historical snapshots.

Final reliability verification passed **1971 tests with 6 explicit skips**, **11 browser
journeys**, required checks, production builds and compiled restart verification.
Both fresh Docker images passed offline persistence/static-asset checks; real
Git history and native embedding dependencies were verified. The patched lockfile
has zero npm audit advisories. These checks use isolated roots; live Claude
authentication, model quality and account delivery remain separate canaries.

The
[project workspace proposal](./docs/superpowers/specs/2026-09-05-project-workspaces-design.md)
describes attached repositories, structured project files, and linked memories;
these remain deferred. A project data-source URI currently labels a source; it
does not attach a repository, grant file access or index its contents.

Useful verification commands:

```sh
npm run check
npm test
npm run validate:library
npm run validate:projects
npm run test:e2e
npm run build:core
npm run test:compiled
```

The browser and compiled harnesses create temporary runtime roots and fake
backends. They do not start the owner's assistant. See [AGENTS.md](AGENTS.md) for
test boundaries and [docs/deployment.md](docs/deployment.md) for container checks.

## Adding a New Skill

The primary path is to ask Raven in chat: its scaffold-and-activate tools write
the definition, reload the affected registry, and commit the specific files.
For a manual definition:

1. Create `library/skills/<domain>/<sub>/<name>/config.json` (name, description, `mcps`, `vendorSkills`, `tools`, `model`, `maxTurns`, `actions`) and `skill.md` (the skill's prompt/instructions)
2. Install the referenced MCP executable/vendor definition and configure its credentials separately.
3. Bind the skill name in the intended agent's `skills:` list, normally `projects/agents/<name>/agent.yaml`. An empty list grants no capability bindings.
4. Validate with `npm run validate:library` and `npm run validate:projects`.
5. Use the existing `reload_registries` tool or restart core to load manual changes. Chat scaffolding performs activation itself.

See `ARCHITECTURE.md` for the full capability library layout and the Raven MCP / per-agent
capability scoping model. Background services now compile under
`packages/core/src/services/`; the old suites layer was removed.

### Vendor Skills

Third-party Claude Code skills are recorded as Git submodules in `library/vendor/`.
Initialize the selected recorded vendor explicitly, for example:

```bash
git submodule update --init --recursive -- library/vendor/anthropic-skills
```

Vendor updates through `scripts/update-vendor.sh` change revisions and need review.
The resolver checks complete vendor definition references, including their actual
skill/plugin files. Source vendor folders are excluded from Docker images; install
selected definitions in the runtime library volume deliberately.

| Vendor                    | Source                                 | Purpose                                |
| ------------------------- | -------------------------------------- | -------------------------------------- |
| anthropic-skills          | anthropics/skills                      | PDF, DOCX, XLSX, PPTX read/create/edit |
| claude-plugin-marketplace | JosiahSiegel/claude-plugin-marketplace | ffmpeg-master media processing         |
| smart-extractors          | diegocconsolini/ClaudeSkillCollection  | Cached document extraction             |
| markdownify-mcp           | zcaceres/markdownify-mcp               | Document-to-markdown MCP server        |

## Architecture

See [Google Workspace Setup](./docs/GOOGLE_WORKSPACE_SETUP.md) for detailed gws CLI setup.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full system architecture, including:

- Per-agent capability resolution + the in-process Raven MCP (role-scoped tools)
- Event bus and flows
- Capability library and compiled background services
- Docker deployment
