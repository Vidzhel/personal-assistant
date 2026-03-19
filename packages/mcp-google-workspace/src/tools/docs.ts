import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gwsExec } from '../gws-exec.ts';

export function registerDocsTools(server: McpServer, credFile: string): void {
  server.registerTool(
    'docs_get',
    {
      description: 'Get the content of a Google Doc',
      inputSchema: {
        documentId: z.string().describe('Google Docs document ID'),
      },
    },
    async (input) => {
      const args = [
        'docs',
        'documents',
        'get',
        '--params',
        JSON.stringify({ documentId: input.documentId }),
        '--format',
        'json',
      ];
      const result = await gwsExec(args, { credentialsFile: credFile });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  );

  server.registerTool(
    'docs_create',
    {
      description: 'Create a new Google Doc',
      inputSchema: {
        title: z.string().describe('Document title'),
      },
    },
    async (input) => {
      const args = [
        'docs',
        'documents',
        'create',
        '--json',
        JSON.stringify({ title: input.title }),
        '--format',
        'json',
      ];
      const result = await gwsExec(args, { credentialsFile: credFile });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  );
}
