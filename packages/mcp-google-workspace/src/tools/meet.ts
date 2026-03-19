import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gwsExec } from '../gws-exec.ts';

function formatResult(data: unknown): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

// eslint-disable-next-line max-lines-per-function -- registers 8 Meet MCP tools
export function registerMeetTools(server: McpServer, credFile: string): void {
  server.registerTool(
    'meet_conferences_list',
    {
      description: 'List recent conference records (meetings)',
      inputSchema: {
        maxResults: z.number().optional().describe('Max results to return'),
      },
    },
    async (input) => {
      const args = ['meet', 'conferenceRecords', 'list', '--format', 'json'];
      if (input.maxResults) args.push('--params', JSON.stringify({ pageSize: input.maxResults }));
      const result = await gwsExec(args, { credentialsFile: credFile });
      return formatResult(result.data);
    },
  );

  server.registerTool(
    'meet_conference_get',
    {
      description: 'Get details of a specific conference record',
      inputSchema: {
        name: z.string().describe('Conference record resource name'),
      },
    },
    async (input) => {
      const args = [
        'meet',
        'conferenceRecords',
        'get',
        '--params',
        JSON.stringify({ name: input.name }),
        '--format',
        'json',
      ];
      const result = await gwsExec(args, { credentialsFile: credFile });
      return formatResult(result.data);
    },
  );

  server.registerTool(
    'meet_recordings_list',
    {
      description: 'List recordings for a conference',
      inputSchema: {
        parent: z.string().describe('Conference record resource name'),
      },
    },
    async (input) => {
      const args = [
        'meet',
        'conferenceRecords',
        'recordings',
        'list',
        '--params',
        JSON.stringify({ parent: input.parent }),
        '--format',
        'json',
      ];
      const result = await gwsExec(args, { credentialsFile: credFile });
      return formatResult(result.data);
    },
  );

  server.registerTool(
    'meet_recording_get',
    {
      description: 'Get a specific recording',
      inputSchema: {
        name: z.string().describe('Recording resource name'),
      },
    },
    async (input) => {
      const args = [
        'meet',
        'conferenceRecords',
        'recordings',
        'get',
        '--params',
        JSON.stringify({ name: input.name }),
        '--format',
        'json',
      ];
      const result = await gwsExec(args, { credentialsFile: credFile });
      return formatResult(result.data);
    },
  );

  server.registerTool(
    'meet_transcripts_list',
    {
      description: 'List transcripts for a conference',
      inputSchema: {
        parent: z.string().describe('Conference record resource name'),
      },
    },
    async (input) => {
      const args = [
        'meet',
        'conferenceRecords',
        'transcripts',
        'list',
        '--params',
        JSON.stringify({ parent: input.parent }),
        '--format',
        'json',
      ];
      const result = await gwsExec(args, { credentialsFile: credFile });
      return formatResult(result.data);
    },
  );

  server.registerTool(
    'meet_transcript_entries',
    {
      description: 'Get transcript entries (the actual text) for a transcript',
      inputSchema: {
        parent: z.string().describe('Transcript resource name'),
      },
    },
    async (input) => {
      const args = [
        'meet',
        'conferenceRecords',
        'transcripts',
        'entries',
        'list',
        '--params',
        JSON.stringify({ parent: input.parent }),
        '--format',
        'json',
      ];
      const result = await gwsExec(args, { credentialsFile: credFile });
      return formatResult(result.data);
    },
  );

  server.registerTool(
    'meet_participants_list',
    {
      description: 'List participants in a conference',
      inputSchema: {
        parent: z.string().describe('Conference record resource name'),
      },
    },
    async (input) => {
      const args = [
        'meet',
        'conferenceRecords',
        'participants',
        'list',
        '--params',
        JSON.stringify({ parent: input.parent }),
        '--format',
        'json',
      ];
      const result = await gwsExec(args, { credentialsFile: credFile });
      return formatResult(result.data);
    },
  );

  server.registerTool(
    'meet_smart_notes',
    {
      description: 'List smart notes (AI summaries) for a conference',
      inputSchema: {
        parent: z.string().describe('Conference record resource name'),
      },
    },
    async (input) => {
      const args = [
        'meet',
        'conferenceRecords',
        'smartNotes',
        'list',
        '--params',
        JSON.stringify({ parent: input.parent }),
        '--format',
        'json',
      ];
      const result = await gwsExec(args, { credentialsFile: credFile });
      return formatResult(result.data);
    },
  );
}
