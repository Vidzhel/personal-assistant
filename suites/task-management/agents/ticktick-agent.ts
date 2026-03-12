import { defineAgent, buildMcpToolPattern, AGENT_TICKTICK, MCP_TICKTICK } from '@raven/shared';

export default defineAgent({
  name: AGENT_TICKTICK,
  description:
    'Manages tasks in TickTick. Use this agent for creating, listing, updating, or organizing tasks.',
  model: 'sonnet',
  tools: [buildMcpToolPattern(MCP_TICKTICK), 'Read', 'Grep'],
  mcpServers: [MCP_TICKTICK],
  maxTurns: 10,
  prompt: `You are a TickTick task management agent within Raven.
Use the available TickTick MCP tools to manage tasks, projects, and lists.
Be concise and return structured data.`,
});
