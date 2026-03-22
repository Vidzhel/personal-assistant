# Agent Conventions

## Agent Definition (`defineAgent()`)

```typescript
import { defineAgent } from '@raven/shared';

export default defineAgent({
  name: 'agent-name',        // Required. kebab-case, descriptive
  description: '...',        // Required. What this agent does
  model: 'sonnet',           // Optional. Default: 'sonnet'
  tools: [],                 // Optional. Available tools and sub-agents
  mcpServers: [],            // Optional. MCP server keys from suite's mcp.json
  maxTurns: 10,              // Optional. Default: 10
  prompt: '...',             // Required. Agent system prompt
});
```

## Naming

- Agent names: kebab-case, descriptive of role (e.g. `gmail-agent`, `pattern-analyzer`, `config-manager`)
- Must be unique across all suites

## Model Selection

| Model | When to Use | Examples |
|-------|------------|---------|
| `haiku` | Simple extraction, classification, formatting | Parse dates, categorize emails |
| `sonnet` | Routine tasks, moderate complexity (default) | Email triage, task creation, config generation |
| `opus` | Complex reasoning, multi-step analysis | Maintenance analysis, cross-domain insights |

## Prompt Structure

1. **Role definition**: Who is this agent and what does it do
2. **Available tools**: What tools/MCPs it can use and how
3. **Output format**: Expected response structure (JSON, markdown, etc.)
4. **Constraints**: Rules, limitations, things to avoid

## Tool Patterns

- Sub-agent delegation: `Agent(agent-name-1, agent-name-2)`
- File access: `Read`, `Glob`, `Grep`
- MCP tools: Referenced by MCP server key from the suite's `mcp.json`
- MCP tool pattern format: `mcp__suitename__toolpattern__*`

## maxTurns Guidelines

| Complexity | maxTurns | Examples |
|-----------|----------|---------|
| Simple | 5 | Single tool call, format data |
| Moderate | 10 | Multi-step workflow, read + process |
| Complex | 15-25 | Multi-agent delegation, iterative analysis |

## Named Agent Configuration

Named agents in `config/agents.json` configure runtime behavior:

```json
{
  "id": "uuid",
  "name": "kebab-case",
  "description": "What this agent persona does",
  "instructions": "Additional instructions prepended to prompts",
  "suite_ids": ["suite1", "suite2"],
  "is_default": false
}
```

- Exactly one agent must have `is_default: true`
- `suite_ids` controls which suites (and their MCPs/agents) are available
- Empty `suite_ids` means all suites are available
- `instructions` are prepended to the orchestrator prompt

## Anti-Patterns

- Loading MCPs on the orchestrator agent (violates MCP isolation)
- Overly broad prompts that try to handle everything
- Missing output format specification (leads to unparseable responses)
- Setting maxTurns too low for complex tasks (agent gives up mid-work)
