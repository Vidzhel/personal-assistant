#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createClient } from './client.ts';
import { registerTools } from './tools.ts';

const token = process.env.TICKTICK_ACCESS_TOKEN;
if (!token) {
  process.stderr.write('Error: TICKTICK_ACCESS_TOKEN environment variable is required\n');
  process.exit(1);
}

const server = new McpServer({
  name: 'raven-mcp-ticktick',
  version: '0.1.0',
});

const client = createClient(token);
registerTools(server, client);

const transport = new StdioServerTransport();
await server.connect(transport);
