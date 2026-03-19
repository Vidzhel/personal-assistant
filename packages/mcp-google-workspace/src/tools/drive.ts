import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gwsExec } from '../gws-exec.ts';

// eslint-disable-next-line max-lines-per-function -- registers 5 Drive MCP tools
export function registerDriveTools(server: McpServer, credFile: string): void {
  server.registerTool(
    'drive_list',
    {
      description: 'List files in Google Drive',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('Drive search query (e.g. "name contains \'report\'")'),
        maxResults: z.number().optional().describe('Max files to return'),
        orderBy: z.string().optional().describe('Sort order (e.g. "modifiedTime desc")'),
      },
    },
    async (input) => {
      const params: Record<string, unknown> = {};
      if (input.query) params.q = input.query;
      if (input.maxResults) params.pageSize = input.maxResults;
      if (input.orderBy) params.orderBy = input.orderBy;
      const args = ['drive', 'files', 'list', '--format', 'json'];
      if (Object.keys(params).length > 0) args.push('--params', JSON.stringify(params));
      const result = await gwsExec(args, { credentialsFile: credFile });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  );

  server.registerTool(
    'drive_get',
    {
      description: 'Get metadata of a specific file',
      inputSchema: {
        fileId: z.string().describe('Google Drive file ID'),
      },
    },
    async (input) => {
      const args = [
        'drive',
        'files',
        'get',
        '--params',
        JSON.stringify({ fileId: input.fileId }),
        '--format',
        'json',
      ];
      const result = await gwsExec(args, { credentialsFile: credFile });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  );

  server.registerTool(
    'drive_create',
    {
      description: 'Create a new file in Google Drive',
      inputSchema: {
        name: z.string().describe('File name'),
        mimeType: z
          .string()
          .optional()
          .describe('MIME type (e.g. "application/vnd.google-apps.document")'),
        parents: z.array(z.string()).optional().describe('Parent folder IDs'),
      },
    },
    async (input) => {
      const body: Record<string, unknown> = { name: input.name };
      if (input.mimeType) body.mimeType = input.mimeType;
      if (input.parents) body.parents = input.parents;
      const args = ['drive', 'files', 'create', '--json', JSON.stringify(body), '--format', 'json'];
      const result = await gwsExec(args, { credentialsFile: credFile });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  );

  server.registerTool(
    'drive_delete',
    {
      description: 'Delete a file from Google Drive',
      inputSchema: {
        fileId: z.string().describe('Google Drive file ID to delete'),
      },
    },
    async (input) => {
      const args = [
        'drive',
        'files',
        'delete',
        '--params',
        JSON.stringify({ fileId: input.fileId }),
        '--format',
        'json',
      ];
      const result = await gwsExec(args, { credentialsFile: credFile });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  );

  server.registerTool(
    'drive_upload',
    {
      description: 'Upload a file to Google Drive',
      inputSchema: {
        filePath: z.string().describe('Local file path to upload'),
        name: z.string().optional().describe('Name for the file in Drive'),
        parents: z.array(z.string()).optional().describe('Parent folder IDs'),
      },
    },
    async (input) => {
      const args = ['drive', '+upload', '--file', input.filePath, '--format', 'json'];
      if (input.name) args.push('--name', input.name);
      if (input.parents) args.push('--parents', input.parents.join(','));
      const result = await gwsExec(args, { credentialsFile: credFile });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  );
}
