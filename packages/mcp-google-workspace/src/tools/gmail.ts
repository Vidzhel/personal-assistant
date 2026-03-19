import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gwsExec } from '../gws-exec.ts';

// eslint-disable-next-line max-lines-per-function -- registers 9 Gmail MCP tools
export function registerGmailTools(server: McpServer, credFile: string): void {
  server.registerTool(
    'gmail_triage',
    {
      description: 'Triage inbox — summarize unread emails with AI categorization',
      inputSchema: {
        maxResults: z.number().optional().describe('Max emails to triage (default: 10)'),
        labels: z.string().optional().describe('Comma-separated label filter'),
      },
    },
    async (input) => {
      const args = ['gmail', '+triage', '--format', 'json'];
      if (input.maxResults) args.push('--max-results', String(input.maxResults));
      if (input.labels) args.push('--labels', input.labels);
      const result = await gwsExec(args, { credentialsFile: credFile });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  );

  server.registerTool(
    'gmail_read',
    {
      description: 'Read a specific email message by ID',
      inputSchema: {
        messageId: z.string().describe('Gmail message ID'),
        format: z.enum(['full', 'metadata', 'minimal']).optional().describe('Message format'),
      },
    },
    async (input) => {
      const args = ['gmail', '+read', '--message-id', input.messageId, '--format', 'json'];
      if (input.format) args.push('--msg-format', input.format);
      const result = await gwsExec(args, { credentialsFile: credFile });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  );

  server.registerTool(
    'gmail_send',
    {
      description: 'Send a new email',
      inputSchema: {
        to: z.string().describe('Recipient email address'),
        subject: z.string().describe('Email subject'),
        body: z.string().describe('Email body (plain text)'),
        cc: z.string().optional().describe('CC recipients (comma-separated)'),
        bcc: z.string().optional().describe('BCC recipients (comma-separated)'),
      },
    },
    async (input) => {
      const args = [
        'gmail',
        '+send',
        '--to',
        input.to,
        '--subject',
        input.subject,
        '--body',
        input.body,
        '--format',
        'json',
      ];
      if (input.cc) args.push('--cc', input.cc);
      if (input.bcc) args.push('--bcc', input.bcc);
      const result = await gwsExec(args, { credentialsFile: credFile });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  );

  server.registerTool(
    'gmail_reply',
    {
      description: 'Reply to an email message',
      inputSchema: {
        messageId: z.string().describe('Gmail message ID to reply to'),
        body: z.string().describe('Reply body (plain text)'),
      },
    },
    async (input) => {
      const args = [
        'gmail',
        '+reply',
        '--message-id',
        input.messageId,
        '--body',
        input.body,
        '--format',
        'json',
      ];
      const result = await gwsExec(args, { credentialsFile: credFile });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  );

  server.registerTool(
    'gmail_reply_all',
    {
      description: 'Reply-all to an email message',
      inputSchema: {
        messageId: z.string().describe('Gmail message ID to reply-all to'),
        body: z.string().describe('Reply body (plain text)'),
      },
    },
    async (input) => {
      const args = [
        'gmail',
        '+reply-all',
        '--message-id',
        input.messageId,
        '--body',
        input.body,
        '--format',
        'json',
      ];
      const result = await gwsExec(args, { credentialsFile: credFile });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  );

  server.registerTool(
    'gmail_forward',
    {
      description: 'Forward an email message',
      inputSchema: {
        messageId: z.string().describe('Gmail message ID to forward'),
        to: z.string().describe('Forward recipient email address'),
        body: z.string().optional().describe('Additional message body'),
      },
    },
    async (input) => {
      const args = [
        'gmail',
        '+forward',
        '--message-id',
        input.messageId,
        '--to',
        input.to,
        '--format',
        'json',
      ];
      if (input.body) args.push('--body', input.body);
      const result = await gwsExec(args, { credentialsFile: credFile });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  );

  server.registerTool(
    'gmail_list',
    {
      description: 'List messages matching a query',
      inputSchema: {
        query: z.string().optional().describe('Gmail search query (e.g. "is:unread from:boss")'),
        maxResults: z.number().optional().describe('Max results to return'),
        labelIds: z.string().optional().describe('Comma-separated label IDs'),
      },
    },
    async (input) => {
      const args = ['gmail', 'users', 'messages', 'list', '--format', 'json'];
      if (input.query) args.push('--params', JSON.stringify({ q: input.query }));
      if (input.maxResults) args.push('--params', JSON.stringify({ maxResults: input.maxResults }));
      if (input.labelIds) args.push('--params', JSON.stringify({ labelIds: input.labelIds }));
      const result = await gwsExec(args, { credentialsFile: credFile });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  );

  server.registerTool(
    'gmail_modify_labels',
    {
      description: 'Add or remove labels from a message',
      inputSchema: {
        messageId: z.string().describe('Gmail message ID'),
        addLabels: z.array(z.string()).optional().describe('Label IDs to add'),
        removeLabels: z.array(z.string()).optional().describe('Label IDs to remove'),
      },
    },
    async (input) => {
      const body: Record<string, unknown> = {};
      if (input.addLabels) body.addLabelIds = input.addLabels;
      if (input.removeLabels) body.removeLabelIds = input.removeLabels;
      const args = [
        'gmail',
        'users',
        'messages',
        'modify',
        '--params',
        JSON.stringify({ id: input.messageId }),
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
    'gmail_search',
    {
      description: 'Search emails with detailed results including snippets',
      inputSchema: {
        query: z.string().describe('Gmail search query'),
        maxResults: z.number().optional().describe('Max results (default: 10)'),
      },
    },
    async (input) => {
      const args = ['gmail', '+triage', '--format', 'json'];
      if (input.query) args.push('--query', input.query);
      if (input.maxResults) args.push('--max-results', String(input.maxResults));
      const result = await gwsExec(args, { credentialsFile: credFile });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  );
}
