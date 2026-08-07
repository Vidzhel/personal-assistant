import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { RavenMcpDeps } from '../types.ts';
import type { ScopeContext } from '../scope.ts';

const MAX_TURNS = 100;

type OkResult = { content: [{ type: 'text'; text: string }] };
type ErrResult = { content: [{ type: 'text'; text: string }]; isError: true };

const okResult = (data: unknown): OkResult => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
});

const errorResult = (message: string): ErrResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

// Heterogeneous collection: listAgents/createAgent/updateAgent/listProjects
// each carry a different concrete, zod-inferred schema (no `any` anywhere
// in their own definitions below); only this array — which must hold tools
// with different schemas side by side, and whose elements are called with
// per-tool concrete args in the test suite via `.find()` — needs the
// erasure, matching the SDK's own `Array<SdkMcpToolDefinition<any>>` field
// on `createSdkMcpServer`.
// eslint-disable-next-line max-lines-per-function -- builds five system management tools
export function buildSystemTools(
  deps: RavenMcpDeps,
  _scope: ScopeContext,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK type erasure at heterogeneous tool collection (see comment above)
): Array<SdkMcpToolDefinition<any>> {
  const listAgents = tool(
    'list_agents',
    'List all named agents, optionally filtered by project.',
    {
      projectId: z.string().optional().describe('Optional project ID filter'),
    },
    async (_args) => {
      const agents = deps.namedAgentStore?.listAgents() ?? [];
      return okResult({ agents });
    },
    {
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
  );

  const createAgent = tool(
    'create_agent',
    'Create a new named agent. Give it `skills` from the capability library so it can actually use MCP tools/actions — an agent with no skills can only chat.',
    {
      name: z
        .string()
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Must be kebab-case')
        .describe('Agent name (kebab-case)'),
      description: z.string().optional().describe('Agent description'),
      instructions: z.string().optional().describe('System instructions for the agent'),
      model: z.enum(['haiku', 'sonnet', 'opus']).optional().describe('Model to use'),
      maxTurns: z.number().int().min(1).max(MAX_TURNS).optional().describe('Max turns (1-100)'),
      skills: z
        .array(z.string())
        .optional()
        .describe('Capability library skill names this agent can use (see list of skills)'),
    },
    async (args) => {
      if (!deps.namedAgentStore) {
        return errorResult('namedAgentStore not available');
      }
      const skills = args.skills ?? [];
      if (deps.capabilityLibrary) {
        const known = new Set(deps.capabilityLibrary.getSkillNames());
        const unknown = skills.filter((s) => !known.has(s));
        if (unknown.length > 0) {
          return errorResult(`Unknown skill(s): ${unknown.join(', ')}`);
        }
      }
      const agent = await deps.namedAgentStore.createAgent({
        name: args.name,
        description: args.description,
        instructions: args.instructions,
        model: args.model,
        maxTurns: args.maxTurns,
        skills,
      });
      return okResult({ agentId: agent.id });
    },
  );

  const updateAgent = tool(
    'update_agent',
    'Update an existing named agent.',
    {
      agentId: z.string().describe('Agent ID to update'),
      name: z.string().optional().describe('New name (kebab-case)'),
      description: z.string().nullable().optional().describe('New description'),
      instructions: z.string().nullable().optional().describe('New instructions'),
      model: z.enum(['haiku', 'sonnet', 'opus']).nullable().optional().describe('New model'),
      maxTurns: z
        .number()
        .int()
        .min(1)
        .max(MAX_TURNS)
        .nullable()
        .optional()
        .describe('New max turns'),
    },
    async (args) => {
      if (!deps.namedAgentStore) {
        return errorResult('namedAgentStore not available');
      }
      const { agentId, ...updates } = args;
      await deps.namedAgentStore.updateAgent(agentId, updates);
      return okResult({ ack: true });
    },
    {
      annotations: {
        idempotentHint: true,
      },
    },
  );

  const listProjects = tool(
    'list_projects',
    'List all projects.',
    {},
    async (_args) => {
      const projects = deps.projectRegistry?.listProjects() ?? [];
      return okResult({ projects });
    },
    {
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
  );

  return [listAgents, createAgent, updateAgent, listProjects];
}
