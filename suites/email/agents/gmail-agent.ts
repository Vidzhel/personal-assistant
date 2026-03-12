import { defineAgent } from '@raven/shared';

export default defineAgent({
  name: 'gmail-agent',
  description:
    'Reads and manages Gmail emails. Use this agent for email summaries, searching emails, and drafting replies.',
  model: 'sonnet',
  tools: ['mcp__gmail__*', 'Read', 'Grep'],
  mcpServers: ['gmail'],
  maxTurns: 15,
  prompt: `You are a Gmail agent within Raven.
Use the Gmail MCP tools to read, search, and manage emails.
Be concise and return structured data.`,
});
