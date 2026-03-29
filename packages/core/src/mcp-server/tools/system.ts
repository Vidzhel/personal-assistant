import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { RavenMcpDeps } from '../types.ts';
import type { ScopeContext } from '../scope.ts';

type OkResult = { content: [{ type: 'text'; text: string }] };
type ErrResult = { content: [{ type: 'text'; text: string }]; isError: true };

const okResult = (data: unknown): OkResult => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
});

const errorResult = (message: string): ErrResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

// eslint-disable-next-line max-lines-per-function -- builds five system management tools
export function buildSystemTools(deps: RavenMcpDeps, _scope: ScopeContext): SdkMcpToolDefinition[] {
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
    'Create a new named agent.',
    {
      name: z
        .string()
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Must be kebab-case')
        .describe('Agent name (kebab-case)'),
      description: z.string().optional().describe('Agent description'),
      instructions: z.string().optional().describe('System instructions for the agent'),
      model: z.enum(['haiku', 'sonnet', 'opus']).optional().describe('Model to use'),
      maxTurns: z.number().int().min(1).max(100).optional().describe('Max turns (1-100)'),
    },
    async (args) => {
      if (!deps.namedAgentStore) {
        return errorResult('namedAgentStore not available');
      }
      const agent = deps.namedAgentStore.createAgent({
        name: args.name,
        description: args.description,
        instructions: args.instructions,
        model: args.model,
        maxTurns: args.maxTurns,
        suiteIds: [],
        skills: [],
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
      maxTurns: z.number().int().min(1).max(100).nullable().optional().describe('New max turns'),
    },
    async (args) => {
      if (!deps.namedAgentStore) {
        return errorResult('namedAgentStore not available');
      }
      const { agentId, ...updates } = args;
      deps.namedAgentStore.updateAgent(agentId, updates);
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

  const triggerPipeline = tool(
    'trigger_pipeline',
    'Trigger a named pipeline by name.',
    {
      name: z.string().describe('Pipeline name'),
      params: z.record(z.string()).optional().describe('Optional trigger parameters'),
    },
    async (args) => {
      if (!deps.pipelineEngine) {
        return errorResult('pipelineEngine not available');
      }
      const triggerType = args.params ? JSON.stringify(args.params) : 'manual';
      const { runId } = deps.pipelineEngine.triggerPipeline(args.name, triggerType);
      return okResult({ treeId: runId });
    },
  );

  return [listAgents, createAgent, updateAgent, listProjects, triggerPipeline];
}
