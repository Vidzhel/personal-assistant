# Raven - Personal Assistant

An AI-powered personal assistant that manages your tasks, monitors your email, delivers morning digests, and sends proactive suggestions via Telegram. Built on Claude Agent SDK with an extensible skill plugin system.

## Features

- **Task Management** - TickTick integration for creating, viewing, and organizing tasks
- **Email Monitoring** - Real-time Gmail monitoring via IMAP IDLE with AI-powered summaries
- **Morning Digest** - Daily briefing at 8am with tasks, emails, and suggestions
- **Telegram Notifications** - Push alerts and quick replies via Telegram bot
- **Web Dashboard** - Full-featured UI with parallel project sessions and real-time chat
- **Google Workspace** - Calendar, Drive, Meet, Tasks, Docs, People via gws CLI with multi-account support
- **Extensible Skills** - Plugin system for adding new integrations

## Quick Start

### Prerequisites

- Node.js 22+
- Docker & Docker Compose (for containerized deployment)
- API keys (see Environment Variables below)

### Local Development

```bash
# Install dependencies
npm install

# Copy and fill in environment variables
cp .env.example .env
# Edit .env with your API keys

# Build and run
npm run build
npm run dev:core    # Start the backend
npm run dev:web     # Start the dashboard (separate terminal)
```

### Docker

```bash
cp .env.example .env
# Edit .env with your API keys

docker compose up --build
```

- Dashboard: http://localhost:4000
- API: http://localhost:4001/api/health

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Claude API key |
| `CLAUDE_MODEL` | Model to use (default: `claude-sonnet-4-5-20250514`) |
| `TICKTICK_CLIENT_ID` | TickTick OAuth app client ID |
| `TICKTICK_CLIENT_SECRET` | TickTick OAuth app client secret |
| `TICKTICK_ACCESS_TOKEN` | TickTick OAuth access token |
| `GMAIL_IMAP_USER` | Gmail address for IMAP monitoring |
| `GMAIL_IMAP_PASSWORD` | Gmail app password (not regular password) |
| `GMAIL_CLIENT_ID` | Google OAuth client ID (for Gmail MCP) |
| `GMAIL_CLIENT_SECRET` | Google OAuth client secret |
| `GMAIL_REFRESH_TOKEN` | Google OAuth refresh token |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID for notifications |
| `TELEGRAM_GROUP_ID` | Telegram group/supergroup ID for topic threads (optional) |
| `TELEGRAM_TOPIC_GENERAL` | General topic thread ID (optional, group mode) |
| `TELEGRAM_TOPIC_SYSTEM` | System alerts topic thread ID (optional, group mode) |
| `TELEGRAM_TOPIC_MAP` | JSON mapping topic names to thread IDs, e.g. `{"Work":5}` (optional) |
| `GWS_PRIMARY_CREDENTIALS_FILE` | Path to primary gws CLI credentials JSON |
| `GWS_MEET_CREDENTIALS_FILE` | Path to Meet account credentials JSON (optional) |
| `GWS_GCP_PROJECT_ID` | GCP project ID for Gmail Pub/Sub watch (optional) |
| `GOOGLE_API_KEY` | Google AI API key for Gemini voice transcription (optional) |
| `RAVEN_TIMEZONE` | Timezone for schedules (e.g., `Europe/London`) |
| `RAVEN_DIGEST_TIME` | Morning digest time (default: `08:00`) |
| `RAVEN_MAX_CONCURRENT_AGENTS` | Max parallel AI agents (default: `3`) |
| `RAVEN_MAX_BUDGET_USD_PER_DAY` | Daily spending limit (default: `5.00`) |

## Adding a New Skill

1. Create `packages/skills/skill-myskill/` with standard package structure
2. Implement the `RavenSkill` interface (extend `BaseSkill` for defaults)
3. Export a factory function from `src/index.ts`
4. Add to `config/skills.json`
5. Run `npm install` to link the workspace

See `ARCHITECTURE.md` for the full skill plugin contract and MCP isolation model.

## Architecture

See [Google Workspace Setup](./docs/GOOGLE_WORKSPACE_SETUP.md) for detailed gws CLI setup.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full system architecture, including:
- MCP isolation model (sub-agent delegation)
- Event bus and flows
- Skill plugin system
- Docker deployment
