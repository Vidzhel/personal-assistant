# Raven Architecture

## Overview

Raven is an event-driven personal assistant powered by Claude Agent SDK. It runs as two Docker containers (core + web dashboard) and uses a plugin skill system for integrations.

## System Diagram

```
                    ┌─────────────┐
                    │  Web UI     │ (Next.js, port 3000)
                    └──────┬──────┘
                           │ WebSocket + REST
                           ▼
                    ┌──────┴──────┐
                    │  API Server │ (Fastify, port 3001)
                    └──────┬──────┘
                           │
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
    ┌───────────┐   ┌───────────┐   ┌────────────┐
    │ Session   │   │ Scheduler │   │ Event Bus  │ ◄── central nervous system
    │ Manager   │   │ (croner)  │   │ (EventEmit)│
    └───────────┘   └─────┬─────┘   └──────┬─────┘
                          │                │
                          ▼                ▼
                    ┌─────┴─────┐   ┌──────┴─────┐
                    │Orchestrat-│◄─►│   Skill    │
                    │or         │   │  Registry  │
                    └─────┬─────┘   └──────┬─────┘
                          │                │
                          ▼                ▼
                    ┌─────┴─────┐   ┌──────┴─────┐
                    │  Agent    │   │    MCP     │
                    │  Manager  │   │  Manager   │
                    └─────┬─────┘   └──────┬─────┘
                          │                │
                          ▼                ▼
                    ┌─────┴────────────────┴─────┐
                    │   Claude Agent SDK         │
                    │   query() sub-agents       │
                    └────────────────────────────┘
```

## MCP Isolation Model

This is the most important architectural decision in Raven.

### Problem
Loading all MCP servers into a single agent context causes:
- Bloated context windows (each MCP adds tool descriptions)
- Higher costs per query
- Tool name collisions between skills
- Slow agent startup

### Solution: Sub-Agent Delegation

```
Orchestrator Agent (NO MCPs)
  │
  ├── analyzes user intent / event
  ├── decides which skill(s) to invoke
  │
  ├──► spawns ticktick-agent (carries TickTick MCP only)
  │    └── returns task data
  │
  ├──► spawns gmail-agent (carries Gmail MCP only)
  │    └── returns email summary
  │
  └── composes final response from sub-agent results
```

**Rules:**
1. The orchestrator/main agent has `allowedTools: ['Read', 'Grep', 'Glob', 'Task']` — NO MCPs
2. Each skill declares sub-agents via `getAgentDefinitions()` with their MCPs pre-configured
3. Sub-agents are spawned by the Agent Manager using `query()` with only the needed MCPs
4. MCP server processes are started lazily (only when a sub-agent needs them) and can be pooled
5. For multi-skill tasks, the orchestrator calls sub-agents sequentially or in parallel

### Example: Morning Digest Flow

```
1. Scheduler fires 'schedule:triggered' (taskType: 'morning-digest')
2. Orchestrator receives event
3. Orchestrator spawns ticktick-agent → "List today's tasks and overdue items"
   - ticktick-agent has: mcpServers: { ticktick: {...} }
   - Returns: structured task data
4. Orchestrator spawns gmail-agent → "Summarize unread emails"
   - gmail-agent has: mcpServers: { gmail: {...} }
   - Returns: email summary
5. Orchestrator composes digest from sub-agent results
6. Emits 'notification' event → Telegram skill delivers it
```

## Event Bus

In-process typed `EventEmitter`. All component communication goes through the bus.

### Event Types

| Event | Source | Description |
|-------|--------|-------------|
| `email:new` | Gmail IMAP watcher | New email detected |
| `schedule:triggered` | Scheduler | Cron job fired |
| `agent:task:request` | Orchestrator | Request to spawn an agent |
| `agent:task:complete` | Agent Manager | Agent finished |
| `agent:message` | Agent Manager | Streaming agent output |
| `user:chat:message` | Web/Telegram | User sent a message |
| `notification` | Any skill | Push notification to user |
| `skill:data` | Skills | Skill-specific data events |

### Flow: New Email

```
IMAP IDLE detects mail
  → gmail skill emits 'email:new'
  → orchestrator receives, creates agent task
  → agent manager spawns gmail-agent sub-agent with Gmail MCP
  → agent reads + summarizes email
  → agent manager emits 'agent:task:complete'
  → orchestrator evaluates: actionable?
  → if yes: emits 'notification'
  → telegram skill sends push notification
```

### Flow: User Chat

```
User types in web dashboard
  → WebSocket sends 'chat:send'
  → API handler emits 'user:chat:message'
  → orchestrator creates agent task (no MCPs on orchestrator)
  → agent manager spawns orchestrator agent
  → orchestrator agent uses Task tool to delegate to skill sub-agents
  → sub-agent results stream back via 'agent:message' events
  → WebSocket pushes to browser in real-time
```

## Skill Plugin System

Each skill is an npm workspace package implementing `RavenSkill`:

```typescript
interface RavenSkill {
  manifest: SkillManifest;
  initialize(context: SkillContext): Promise<void>;
  shutdown(): Promise<void>;
  getMcpServers(): Record<string, McpServerConfig>;
  getAgentDefinitions(): Record<string, AgentDefinition>;
  handleScheduledTask(taskType: string, ctx: SkillContext): Promise<AgentTaskPayload | void>;
  getDataForDigest?(): Promise<DigestSection>;
}
```

### Skill Discovery

Skills are discovered from `packages/skills/skill-*/src/index.ts`. Each exports a factory function:

```typescript
export default function createSkill(): RavenSkill {
  return new MySkill();
}
```

Enable/disable and configure skills in `config/skills.json`.

### Current Skills

| Skill | MCPs | Event Sources | Scheduled Tasks |
|-------|------|---------------|-----------------|
| ticktick | TickTick MCP (npx) | none | none |
| gmail | Gmail MCP (npx) | IMAP IDLE watcher | none |
| digest | none (delegates) | none | morning-digest (8am) |
| telegram | none | Telegram bot messages | none |

## Data Layer

- **SQLite** via `better-sqlite3` — single file at `data/raven.db`
- Tables: `events`, `sessions`, `projects`, `schedules`, `preferences`
- Repositories in `packages/core/src/db/repositories/`

## API Layer

- **Fastify** HTTP server on port 3001
- **WebSocket** at `/ws` for real-time streaming
- REST endpoints under `/api/` for CRUD operations

### WebSocket Protocol

Client → Server:
- `subscribe` / `unsubscribe` to channels (`project:<id>`, `global`)
- `chat:send` to send messages to a project agent

Server → Client:
- `agent:message` - streaming agent output
- `event` - system events
- `notification` - push notifications

## Scheduler

Uses `croner` for timezone-aware cron. Schedules stored in DB, configurable via API.
Default: morning digest at 8am local time.

## Docker Deployment

Two containers:
- `raven-core` (port 3001) - orchestrator, agents, skills, scheduler
- `raven-web` (port 3000) - Next.js dashboard

Volumes:
- `./data` → SQLite DB + session files
- `./config` → skill and schedule configuration
