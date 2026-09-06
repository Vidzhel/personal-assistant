import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createGoogleCalendarMcpServer } from './google-calendar-server.ts';

const server = createGoogleCalendarMcpServer();
await server.connect(new StdioServerTransport());
