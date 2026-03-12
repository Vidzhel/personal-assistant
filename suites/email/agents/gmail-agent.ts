import { defineAgent, buildMcpToolPattern, AGENT_GMAIL, MCP_GMAIL } from '@raven/shared';

export default defineAgent({
  name: AGENT_GMAIL,
  description:
    'Reads and manages Gmail emails. Use this agent for email summaries, searching emails, and drafting replies.',
  model: 'sonnet',
  tools: [buildMcpToolPattern(MCP_GMAIL), 'Read', 'Grep'],
  mcpServers: [MCP_GMAIL],
  maxTurns: 15,
  prompt: `You are a Gmail agent within Raven.
Use the Gmail MCP tools to read, search, and manage emails.
Be concise and return structured data.`,
});
