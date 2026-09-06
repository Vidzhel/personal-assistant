import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { GoogleCalendarClient } from '../integrations/google-calendar/google-calendar-client.ts';
import { createGoogleCalendarMcpServer } from '../integrations/google-calendar/google-calendar-server.ts';

const close: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(close.splice(0).map((fn) => fn()));
});

describe('Google Calendar MCP server', () => {
  it('exposes only the two bounded read-only tools', async () => {
    const calendar = new GoogleCalendarClient({
      env: { GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE: '/credentials/config.json' },
      runner: async () => JSON.stringify({ items: [] }),
    });
    const server = createGoogleCalendarMcpServer(calendar);
    const client = new Client({ name: 'calendar-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close.push(
      () => client.close(),
      () => server.close(),
    );

    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name).sort()).toEqual(['list_calendars', 'list_events']);
    for (const tool of result.tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      });
    }
    expect(result.tools.find((tool) => tool.name === 'list_calendars')?.inputSchema).toMatchObject({
      type: 'object',
      properties: {},
    });
  });
});
