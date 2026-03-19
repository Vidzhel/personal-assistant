import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gwsExec } from '../gws-exec.ts';

function formatResult(data: unknown): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

// eslint-disable-next-line max-lines-per-function -- registers 8 Gmail MCP tools
export function registerGmailTools(server: McpServer, credFile: string): void {
  server.registerTool(
    'gmail_triage',
    {
      description:
        'Triage inbox — summarize unread emails with AI categorization. Also supports search via --query.',
      inputSchema: {
        max: z.number().optional().describe('Max emails to show (default: 20)'),
        query: z.string().optional().describe('Gmail search query (default: is:unread)'),
        labels: z.boolean().optional().describe('Include label names in output'),
      },
    },
    async (input) => {
      const args = ['gmail', '+triage', '--format', 'json'];
      if (input.max) args.push('--max', String(input.max));
      if (input.query) args.push('--query', input.query);
      if (input.labels) args.push('--labels');
      const result = await gwsExec(args, { credentialsFile: credFile });
      return formatResult(result.data);
    },
  );

  server.registerTool(
    'gmail_read',
    {
      description: 'Read a specific email message by ID — extracts body and optionally headers',
      inputSchema: {
        id: z.string().describe('Gmail message ID'),
        headers: z.boolean().optional().describe('Include headers (From, To, Subject, Date)'),
      },
    },
    async (input) => {
      const args = ['gmail', '+read', '--id', input.id, '--format', 'json'];
      if (input.headers) args.push('--headers');
      const result = await gwsExec(args, { credentialsFile: credFile });
      return formatResult(result.data);
    },
  );

  server.registerTool(
    'gmail_send',
    {
      description: 'Send a new email with optional attachments and HTML support',
      inputSchema: {
        to: z.string().describe('Recipient email address(es), comma-separated'),
        subject: z.string().describe('Email subject'),
        body: z.string().describe('Email body (plain text, or HTML if html=true)'),
        cc: z.string().optional().describe('CC recipients (comma-separated)'),
        bcc: z.string().optional().describe('BCC recipients (comma-separated)'),
        from: z.string().optional().describe('Sender address (for send-as/alias)'),
        html: z.boolean().optional().describe('Treat body as HTML content'),
        attach: z.array(z.string()).optional().describe('File paths to attach'),
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
      if (input.from) args.push('--from', input.from);
      if (input.html) args.push('--html');
      if (input.attach) {
        for (const file of input.attach) args.push('--attach', file);
      }
      const result = await gwsExec(args, { credentialsFile: credFile });
      return formatResult(result.data);
    },
  );

  server.registerTool(
    'gmail_reply',
    {
      description: 'Reply to an email message with optional attachments and HTML',
      inputSchema: {
        messageId: z.string().describe('Gmail message ID to reply to'),
        body: z.string().describe('Reply body (plain text, or HTML if html=true)'),
        cc: z.string().optional().describe('CC recipients (comma-separated)'),
        bcc: z.string().optional().describe('BCC recipients (comma-separated)'),
        from: z.string().optional().describe('Sender address (for send-as/alias)'),
        html: z.boolean().optional().describe('Treat body as HTML content'),
        attach: z.array(z.string()).optional().describe('File paths to attach'),
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
      if (input.cc) args.push('--cc', input.cc);
      if (input.bcc) args.push('--bcc', input.bcc);
      if (input.from) args.push('--from', input.from);
      if (input.html) args.push('--html');
      if (input.attach) {
        for (const file of input.attach) args.push('--attach', file);
      }
      const result = await gwsExec(args, { credentialsFile: credFile });
      return formatResult(result.data);
    },
  );

  server.registerTool(
    'gmail_reply_all',
    {
      description: 'Reply-all to an email message',
      inputSchema: {
        messageId: z.string().describe('Gmail message ID to reply-all to'),
        body: z.string().describe('Reply body (plain text, or HTML if html=true)'),
        cc: z.string().optional().describe('CC recipients (comma-separated)'),
        bcc: z.string().optional().describe('BCC recipients (comma-separated)'),
        from: z.string().optional().describe('Sender address (for send-as/alias)'),
        html: z.boolean().optional().describe('Treat body as HTML content'),
        attach: z.array(z.string()).optional().describe('File paths to attach'),
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
      if (input.cc) args.push('--cc', input.cc);
      if (input.bcc) args.push('--bcc', input.bcc);
      if (input.from) args.push('--from', input.from);
      if (input.html) args.push('--html');
      if (input.attach) {
        for (const file of input.attach) args.push('--attach', file);
      }
      const result = await gwsExec(args, { credentialsFile: credFile });
      return formatResult(result.data);
    },
  );

  server.registerTool(
    'gmail_forward',
    {
      description: 'Forward an email message to new recipients',
      inputSchema: {
        messageId: z.string().describe('Gmail message ID to forward'),
        to: z.string().describe('Forward recipient email address(es), comma-separated'),
        body: z.string().optional().describe('Note to include above the forwarded message'),
        cc: z.string().optional().describe('CC recipients (comma-separated)'),
        bcc: z.string().optional().describe('BCC recipients (comma-separated)'),
        from: z.string().optional().describe('Sender address (for send-as/alias)'),
        html: z.boolean().optional().describe('Treat body as HTML content'),
        attach: z.array(z.string()).optional().describe('File paths to attach'),
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
      if (input.cc) args.push('--cc', input.cc);
      if (input.bcc) args.push('--bcc', input.bcc);
      if (input.from) args.push('--from', input.from);
      if (input.html) args.push('--html');
      if (input.attach) {
        for (const file of input.attach) args.push('--attach', file);
      }
      const result = await gwsExec(args, { credentialsFile: credFile });
      return formatResult(result.data);
    },
  );

  server.registerTool(
    'gmail_list',
    {
      description: 'List messages matching a query via Gmail API (raw API access with full params)',
      inputSchema: {
        query: z.string().optional().describe('Gmail search query (e.g. "is:unread from:boss")'),
        maxResults: z.number().optional().describe('Max results to return'),
        labelIds: z.string().optional().describe('Comma-separated label IDs'),
        pageAll: z.boolean().optional().describe('Auto-paginate through all results'),
      },
    },
    async (input) => {
      const params: Record<string, unknown> = {};
      if (input.query) params.q = input.query;
      if (input.maxResults) params.maxResults = input.maxResults;
      if (input.labelIds) params.labelIds = input.labelIds;
      const args = ['gmail', 'users', 'messages', 'list', '--format', 'json'];
      if (Object.keys(params).length > 0) args.push('--params', JSON.stringify(params));
      if (input.pageAll) args.push('--page-all');
      const result = await gwsExec(args, { credentialsFile: credFile });
      return formatResult(result.data);
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
      return formatResult(result.data);
    },
  );
}
