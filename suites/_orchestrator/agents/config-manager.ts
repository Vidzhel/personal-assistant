import { defineAgent, AGENT_CONFIG_MANAGER } from '@raven/shared';

/**
 * Builds the config-manager agent prompt with current system state
 * and optional convention document content injected.
 */
export function buildConfigManagerPrompt(systemState: ConfigManagerState): string {
  const sections: string[] = [
    buildRoleSection(),
    buildSchemaSection(),
    buildCurrentStateSection(systemState),
  ];

  // Inject relevant convention docs if available
  if (systemState.conventionDocs) {
    sections.push(buildConventionDocsSection(systemState.conventionDocs));
  }

  sections.push(buildOutputFormatSection());

  return sections.join('\n\n---\n\n');
}

export interface ConfigManagerState {
  pipelines: Array<{ name: string; enabled: boolean; trigger: string }>;
  suites: Array<{ name: string; displayName: string; enabled: boolean }>;
  agents: Array<{ id: string; name: string; description: string | null; isDefault: boolean }>;
  schedules: Array<{ id: string; name: string; cron: string; enabled: boolean }>;
  conventionDocs?: Record<string, string>;
}

function buildRoleSection(): string {
  return `You are the Config Manager agent within Raven. Your job is to generate, edit, and manage system configuration based on natural language user requests.

You handle four resource types: pipelines, suites, agents, and schedules.

For every change you propose, you MUST output structured JSON so the system can present it to the user for approval before applying. NEVER apply changes directly.

You can also view/inspect resources without making changes.`;
}

function buildSchemaSection(): string {
  return `## Resource Schemas

### Pipeline YAML
\`\`\`yaml
name: pipeline-name          # kebab-case, verb-noun preferred (e.g. email-to-tasks)
version: 1
description: "What this pipeline does"
trigger:
  type: cron|event|manual     # trigger type
  schedule: "0 * * * *"       # cron expression (if type: cron)
  event: "event:type"         # event type (if type: event)
settings:
  retry: { maxAttempts: 3, backoffMs: 5000 }
  timeout: 600000
  onError: stop|continue
nodes:
  node-id:                    # kebab-case, verb-noun (e.g. fetch-emails)
    skill: suite-name
    action: action-name
    params: {}
connections:
  - { from: node-a, to: node-b, condition: "optional" }
enabled: true
\`\`\`

### Suite Structure
\`\`\`
suites/suite-name/
  suite.ts       -> defineSuite({ name, displayName, description, capabilities, requiresEnv?, services? })
  mcp.json       -> { mcpServers: { key: { command, args, env } } }
  actions.json   -> [{ name: "suite:action", description, defaultTier, reversible }]
  agents/        -> defineAgent({ name, description, model, tools, mcpServers, maxTurns, prompt })
  services/      -> SuiteService: { start(ctx), stop() }
  UPDATE.md      -> Dependencies monitoring and verification instructions
\`\`\`

### Agent JSON (config/agents.json)
\`\`\`json
{ "id": "uuid", "name": "kebab-case", "description": "...", "instructions": "...", "suite_ids": ["suite1"], "is_default": false }
\`\`\`

### Schedule JSON (config/schedules.json)
\`\`\`json
{ "id": "uuid", "name": "Human Name", "cron": "0 8 * * *", "taskType": "task-type", "skillName": "suite-name", "enabled": true }
\`\`\``;
}

function buildCurrentStateSection(state: ConfigManagerState): string {
  const lines: string[] = ['## Current System State'];

  lines.push('\n### Pipelines');
  if (state.pipelines.length === 0) {
    lines.push('No pipelines configured.');
  } else {
    for (const p of state.pipelines) {
      lines.push(`- **${p.name}**: ${p.enabled ? 'enabled' : 'disabled'}, trigger: ${p.trigger}`);
    }
  }

  lines.push('\n### Suites');
  if (state.suites.length === 0) {
    lines.push('No suites registered.');
  } else {
    for (const s of state.suites) {
      lines.push(`- **${s.name}** (${s.displayName}): ${s.enabled ? 'enabled' : 'disabled'}`);
    }
  }

  lines.push('\n### Named Agents');
  if (state.agents.length === 0) {
    lines.push('No named agents configured.');
  } else {
    for (const a of state.agents) {
      lines.push(`- **${a.name}**${a.isDefault ? ' (default)' : ''}: ${a.description ?? 'no description'}`);
    }
  }

  lines.push('\n### Schedules');
  if (state.schedules.length === 0) {
    lines.push('No schedules configured.');
  } else {
    for (const s of state.schedules) {
      lines.push(`- **${s.name}**: \`${s.cron}\` — ${s.enabled ? 'enabled' : 'disabled'}`);
    }
  }

  return lines.join('\n');
}

function buildConventionDocsSection(docs: Record<string, string>): string {
  const lines: string[] = ['## Convention Documents (MUST follow these when generating configs)'];

  for (const [name, content] of Object.entries(docs)) {
    lines.push(`\n### ${name}\n`);
    lines.push(content);
  }

  lines.push('\nYou MUST follow all conventions documented above when generating any resource.');

  return lines.join('\n');
}

function buildOutputFormatSection(): string {
  return `## Output Format

You MUST respond with a JSON object matching this structure:

\`\`\`json
{
  "action": "create" | "update" | "delete" | "view",
  "resourceType": "pipeline" | "suite" | "agent" | "schedule",
  "resourceName": "the-resource-name",
  "content": "full content for create, or updated content for update (YAML for pipelines, JSON for agents/schedules)",
  "diff": "human-readable summary of what changed (for updates)",
  "description": "brief explanation of what this change does"
}
\`\`\`

Rules:
- For \`create\`: include full \`content\` field with the new resource
- For \`update\`: include both \`content\` (new version) and \`diff\` (what changed)
- For \`delete\`: include \`resourceName\` only, no content needed
- For \`view\`: set \`content\` to the formatted current state of the requested resource
- Pipeline content must be valid YAML
- Agent/schedule content must be valid JSON
- Suite content must be a JSON object with fields: name, displayName, description, mcpServers (optional)
- All names must be kebab-case
- Wrap your JSON response in a \`\`\`json code fence`;
}

export default defineAgent({
  name: AGENT_CONFIG_MANAGER,
  description: 'Generates, edits, and manages system configuration (pipelines, suites, agents, schedules) from natural language.',
  model: 'sonnet',
  tools: ['Read', 'Glob', 'Grep'],
  maxTurns: 15,
  prompt: 'Dynamic prompt — replaced at runtime by buildConfigManagerPrompt()',
});
