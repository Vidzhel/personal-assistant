import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gwsExec } from '../gws-exec.ts';

function formatResult(data: unknown): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

// eslint-disable-next-line max-lines-per-function -- registers 2 People MCP tools
export function registerPeopleTools(server: McpServer, credFile: string): void {
  server.registerTool(
    'people_search',
    {
      description: 'Search contacts by name or email',
      inputSchema: {
        query: z.string().describe('Search query (name, email, phone)'),
        maxResults: z.number().optional().describe('Max results to return'),
      },
    },
    async (input) => {
      const params: Record<string, unknown> = {
        query: input.query,
        readMask: 'names,emailAddresses,phoneNumbers',
      };
      if (input.maxResults) params.pageSize = input.maxResults;
      const args = [
        'people',
        'people',
        'searchContacts',
        '--params',
        JSON.stringify(params),
        '--format',
        'json',
      ];
      const result = await gwsExec(args, { credentialsFile: credFile });
      return formatResult(result.data);
    },
  );

  server.registerTool(
    'people_connections',
    {
      description: 'List all contacts (connections)',
      inputSchema: {
        maxResults: z.number().optional().describe('Max results to return'),
      },
    },
    async (input) => {
      const params: Record<string, unknown> = {
        resourceName: 'people/me',
        personFields: 'names,emailAddresses,phoneNumbers',
      };
      if (input.maxResults) params.pageSize = input.maxResults;
      const args = [
        'people',
        'people',
        'connections',
        'list',
        '--params',
        JSON.stringify(params),
        '--format',
        'json',
      ];
      const result = await gwsExec(args, { credentialsFile: credFile });
      return formatResult(result.data);
    },
  );
}
