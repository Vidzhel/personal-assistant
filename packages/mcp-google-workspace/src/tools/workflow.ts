import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gwsExec } from '../gws-exec.ts';

// eslint-disable-next-line max-lines-per-function -- registers 4 Workflow MCP tools
export function registerWorkflowTools(server: McpServer, credFile: string): void {
  server.registerTool(
    'workflow_standup_report',
    {
      description: 'Generate a standup report from recent calendar, email, and task activity',
      inputSchema: {
        timezone: z.string().optional().describe('IANA timezone'),
      },
    },
    async (input) => {
      const args = ['calendar', '+standup-report', '--format', 'json'];
      if (input.timezone) args.push('--timezone', input.timezone);
      const result = await gwsExec(args, { credentialsFile: credFile });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  );

  server.registerTool(
    'workflow_meeting_prep',
    {
      description: 'Prepare for an upcoming meeting — gather context, attendees, docs',
      inputSchema: {
        eventId: z.string().describe('Calendar event ID to prepare for'),
      },
    },
    async (input) => {
      const args = ['calendar', '+meeting-prep', '--event-id', input.eventId, '--format', 'json'];
      const result = await gwsExec(args, { credentialsFile: credFile });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  );

  server.registerTool(
    'workflow_email_to_task',
    {
      description: 'Convert an email into a Google Task with context',
      inputSchema: {
        messageId: z.string().describe('Gmail message ID to convert'),
        taskListId: z.string().optional().describe('Target task list ID'),
      },
    },
    async (input) => {
      const args = ['gmail', '+email-to-task', '--message-id', input.messageId, '--format', 'json'];
      if (input.taskListId) args.push('--task-list', input.taskListId);
      const result = await gwsExec(args, { credentialsFile: credFile });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  );

  server.registerTool(
    'workflow_weekly_digest',
    {
      description: 'Generate a weekly digest summarizing email, calendar, and task activity',
      inputSchema: {
        timezone: z.string().optional().describe('IANA timezone'),
      },
    },
    async (input) => {
      const args = ['calendar', '+weekly-digest', '--format', 'json'];
      if (input.timezone) args.push('--timezone', input.timezone);
      const result = await gwsExec(args, { credentialsFile: credFile });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  );
}
