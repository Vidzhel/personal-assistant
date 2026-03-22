# Suite Conventions

## Required Files

Every suite directory MUST contain:

| File | Purpose | Required |
|------|---------|----------|
| `suite.ts` | Suite manifest via `defineSuite()` | Yes |
| `mcp.json` | MCP server declarations (can be empty `{ "mcpServers": {} }`) | Yes |
| `actions.json` | Action declarations with permission tiers | Yes |
| `agents/` | Directory for agent definitions | Yes |
| `UPDATE.md` | Dependency monitoring and verification instructions | Yes |
| `services/` | Long-running service implementations | If `capabilities` includes `services` |

## Suite Definition (`suite.ts`)

```typescript
import { defineSuite } from '@raven/shared';

export default defineSuite({
  name: 'suite-name',        // kebab-case, matches directory name
  displayName: 'Suite Name', // Human-readable name
  version: '0.1.0',          // Semver
  description: '...',        // What this suite provides
  capabilities: [],          // Array of: 'mcp-server', 'agent-definition', 'event-source', 'data-provider', 'notification-sink', 'services'
  requiresEnv: [],           // Env vars that must be set (e.g. ['API_KEY'])
  services: [],              // Service file names (without .ts) from services/ dir
});
```

## Naming

- Suite directory: kebab-case (e.g. `task-management`, `google-workspace`)
- Suite `name` field: must match directory name exactly
- Action names: `suite-name:action-name` format (e.g. `email:send-reply`)

## MCP Configuration (`mcp.json`)

```json
{
  "mcpServers": {
    "server-key": {
      "command": "node",
      "args": ["path/to/server.js"],
      "env": {
        "API_KEY": "${API_KEY}"
      }
    }
  }
}
```

- Env vars use `${VAR_NAME}` syntax for runtime resolution
- Empty MCP config: `{ "mcpServers": {} }`

## Action Declarations (`actions.json`)

```json
[
  {
    "name": "suite-name:action-name",
    "description": "What this action does",
    "defaultTier": "green",
    "reversible": true
  }
]
```

### Permission Tiers

| Tier | When to Use | Examples |
|------|------------|---------|
| `green` | Read-only or safely reversible | List tasks, read email, fetch data |
| `yellow` | Write operations with side effects | Create task, archive email, update config |
| `red` | Irreversible or external-facing | Send email, delete data, financial transactions |

## UPDATE.md Template

```markdown
# {Suite Name} — Update Guide

## Dependencies to Monitor

- **package-name** — [Changelog](url)
  - Current: x.y.z
  - What it provides: brief description

## What to Verify

- [ ] Suite-specific health check 1
- [ ] Suite-specific health check 2
```

## Service Interface

```typescript
import type { ServiceContext, SuiteService } from '@raven/core/suite-registry/service-runner.ts';

const service: SuiteService = {
  async start(context: ServiceContext): Promise<void> {
    // context provides: eventBus, db, projectRoot, config, logger
  },
  async stop(): Promise<void> {
    // Cleanup
  },
};

export default service;
```

## Capabilities

- `mcp-server`: Suite provides MCP servers (mcp.json has entries)
- `agent-definition`: Suite provides agent definitions (agents/ dir has files)
- `event-source`: Suite emits events
- `data-provider`: Suite provides data to other suites
- `notification-sink`: Suite can receive/display notifications
- `services`: Suite has long-running background services
