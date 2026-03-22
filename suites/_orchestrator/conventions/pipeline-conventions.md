# Pipeline Conventions

## YAML Schema

```yaml
name: pipeline-name        # Required. kebab-case, verb-noun (e.g. email-to-tasks, morning-briefing)
version: 1                 # Required. Integer, increment on breaking changes
description: "..."         # Optional. What this pipeline does
trigger:                   # Required. Exactly one trigger
  type: cron|event|manual  # Required
  schedule: "0 * * * *"   # Required if type: cron (standard cron expression)
  event: "event:type"      # Required if type: event
settings:                  # Optional. Execution settings
  retry:
    maxAttempts: 3         # Default: 3. Number of retry attempts per node
    backoffMs: 5000        # Default: 5000. Delay between retries
  timeout: 600000          # Default: 600000 (10 min). Max execution time per node
  onError: stop|continue   # Default: stop. stop = halt pipeline on error, continue = skip failed node
nodes:                     # Required. At least one node
  node-id:                 # kebab-case, verb-noun (e.g. fetch-emails, compile-briefing)
    skill: suite-name      # Required. Must reference a registered suite
    action: action-name    # Required. Must be a declared action in the suite
    params: {}             # Optional. Node-specific parameters
connections:               # Required if >1 node. DAG edges
  - from: node-a           # Source node ID
    to: node-b             # Target node ID
    condition: "optional"  # Optional. Evaluated at runtime
enabled: true              # Required. Toggle pipeline on/off
```

## Required Fields

- `name`, `version`, `trigger`, at least one `node`, `enabled`

## Naming Conventions

- Pipeline names: kebab-case, descriptive of the flow (e.g. `email-to-tasks`, `morning-briefing`, `weekly-maintenance`)
- Node IDs: kebab-case, verb-noun describing what the node does (e.g. `fetch-emails`, `analyze-logs`, `send-notification`)
- Prefer verb-noun patterns: `check-email`, `create-tasks`, `compile-report`

## Trigger Types

| Type | Usage | Example |
|------|-------|---------|
| `cron` | Recurring schedule | `schedule: "0 8 * * *"` (daily 8am) |
| `event` | React to system event | `event: "email:new"` |
| `manual` | User-initiated only | No schedule/event needed |

## Connection Patterns

- **Linear**: A → B → C (most common)
- **Fan-out**: A → B, A → C (parallel execution)
- **Conditional**: `condition` field on connections for routing

## DAG Rules

- Connections must form a valid DAG (no cycles)
- Every node must be reachable from at least one root node
- No orphaned nodes (every node must have at least one connection, unless single-node pipeline)

## Anti-Patterns

- Cycles in connections (will fail DAG validation)
- Orphaned nodes not connected to the graph
- Referencing non-existent suite names in `skill` field
- Missing `version` field (breaks versioning)
- Using `continue` onError without explicit error handling in downstream nodes

## Cron Expression Examples

| Expression | Meaning |
|-----------|---------|
| `0 8 * * *` | Daily at 8:00 AM |
| `0 */6 * * *` | Every 6 hours |
| `0 8 * * 1-5` | Weekdays at 8:00 AM |
| `0 0 * * 0` | Weekly on Sunday midnight |
| `0 3 * * 1` | Weekly Monday at 3:00 AM |
