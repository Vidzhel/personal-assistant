import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GoogleCalendarClient } from './google-calendar-client.ts';

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export function createGoogleCalendarMcpServer(client = new GoogleCalendarClient()): McpServer {
  const server = new McpServer({ name: 'raven-google-calendar', version: '1.0.0' });
  server.registerTool(
    'list_calendars',
    {
      description: 'List the calendars visible to the configured Google Workspace account',
      inputSchema: {},
      annotations,
    },
    async (_input, extra) => textResult(await client.listCalendars(extra.signal)),
  );
  server.registerTool(
    'list_events',
    {
      description: 'List expanded event instances for one calendar in a bounded time range',
      inputSchema: {
        calendarId: z.string().min(1),
        timeMin: z.string(),
        timeMax: z.string(),
        timeZone: z.string().min(1),
      },
      annotations,
    },
    async (input, extra) => textResult(await client.listEvents({ ...input, signal: extra.signal })),
  );
  return server;
}

function textResult(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}
