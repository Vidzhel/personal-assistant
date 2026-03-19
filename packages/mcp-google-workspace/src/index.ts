#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAllTools } from './register-all.ts';

const credFile = process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE;
if (!credFile) {
  process.stderr.write('Error: GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE is required\n');
  process.exit(1);
}

const server = new McpServer({
  name: 'raven-mcp-google-workspace',
  version: '0.1.0',
});

registerAllTools(server, credFile);

const transport = new StdioServerTransport();
await server.connect(transport);
