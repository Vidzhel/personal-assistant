import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gwsExec } from '../gws-exec.ts';

// eslint-disable-next-line max-lines-per-function -- registers 6 Tasks MCP tools
export function registerTasksTools(server: McpServer, credFile: string): void {
  server.registerTool(
    'gtasks_lists',
    {
      description: 'List all Google Tasks task lists',
      inputSchema: {},
    },
    async () => {
      const args = ['tasks', 'tasklists', 'list', '--format', 'json'];
      const result = await gwsExec(args, { credentialsFile: credFile });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  );

  server.registerTool(
    'gtasks_list',
    {
      description: 'List tasks in a task list',
      inputSchema: {
        taskListId: z.string().describe('Task list ID (use "@default" for primary)'),
        showCompleted: z.boolean().optional().describe('Include completed tasks'),
      },
    },
    async (input) => {
      const params: Record<string, unknown> = { tasklist: input.taskListId };
      if (input.showCompleted !== undefined) params.showCompleted = input.showCompleted;
      const args = [
        'tasks',
        'tasks',
        'list',
        '--params',
        JSON.stringify(params),
        '--format',
        'json',
      ];
      const result = await gwsExec(args, { credentialsFile: credFile });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  );

  server.registerTool(
    'gtasks_insert',
    {
      description: 'Create a new Google Task',
      inputSchema: {
        taskListId: z.string().describe('Task list ID'),
        title: z.string().describe('Task title'),
        notes: z.string().optional().describe('Task notes'),
        due: z.string().optional().describe('Due date (RFC 3339)'),
      },
    },
    async (input) => {
      const body: Record<string, string> = { title: input.title };
      if (input.notes) body.notes = input.notes;
      if (input.due) body.due = input.due;
      const args = [
        'tasks',
        'tasks',
        'insert',
        '--params',
        JSON.stringify({ tasklist: input.taskListId }),
        '--json',
        JSON.stringify(body),
        '--format',
        'json',
      ];
      const result = await gwsExec(args, { credentialsFile: credFile });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  );

  server.registerTool(
    'gtasks_update',
    {
      description: 'Update a Google Task',
      inputSchema: {
        taskListId: z.string().describe('Task list ID'),
        taskId: z.string().describe('Task ID'),
        title: z.string().optional().describe('New title'),
        notes: z.string().optional().describe('New notes'),
        due: z.string().optional().describe('New due date (RFC 3339)'),
        status: z.enum(['needsAction', 'completed']).optional().describe('Task status'),
      },
    },
    async (input) => {
      const body: Record<string, string> = {};
      if (input.title) body.title = input.title;
      if (input.notes) body.notes = input.notes;
      if (input.due) body.due = input.due;
      if (input.status) body.status = input.status;
      const args = [
        'tasks',
        'tasks',
        'patch',
        '--params',
        JSON.stringify({ tasklist: input.taskListId, task: input.taskId }),
        '--json',
        JSON.stringify(body),
        '--format',
        'json',
      ];
      const result = await gwsExec(args, { credentialsFile: credFile });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  );

  server.registerTool(
    'gtasks_delete',
    {
      description: 'Delete a Google Task',
      inputSchema: {
        taskListId: z.string().describe('Task list ID'),
        taskId: z.string().describe('Task ID'),
      },
    },
    async (input) => {
      const args = [
        'tasks',
        'tasks',
        'delete',
        '--params',
        JSON.stringify({ tasklist: input.taskListId, task: input.taskId }),
        '--format',
        'json',
      ];
      const result = await gwsExec(args, { credentialsFile: credFile });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  );

  server.registerTool(
    'gtasks_complete',
    {
      description: 'Mark a Google Task as completed',
      inputSchema: {
        taskListId: z.string().describe('Task list ID'),
        taskId: z.string().describe('Task ID'),
      },
    },
    async (input) => {
      const body = { status: 'completed' };
      const args = [
        'tasks',
        'tasks',
        'patch',
        '--params',
        JSON.stringify({ tasklist: input.taskListId, task: input.taskId }),
        '--json',
        JSON.stringify(body),
        '--format',
        'json',
      ];
      const result = await gwsExec(args, { credentialsFile: credFile });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  );
}
