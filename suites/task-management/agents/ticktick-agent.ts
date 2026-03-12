import { defineAgent } from '@raven/shared';

export default defineAgent({
  name: 'ticktick-agent',
  description:
    'Manages tasks in TickTick. Use this agent for creating, listing, updating, or organizing tasks.',
  model: 'sonnet',
  tools: ['mcp__ticktick__*', 'Read', 'Grep'],
  mcpServers: ['ticktick'],
  maxTurns: 10,
  prompt: `You are a TickTick task management agent within Raven.
Use the available TickTick MCP tools to manage tasks, projects, and lists.
Be concise and return structured data.`,
});
