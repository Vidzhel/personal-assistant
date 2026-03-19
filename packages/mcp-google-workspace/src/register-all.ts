import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerGmailTools } from './tools/gmail.ts';
import { registerCalendarTools } from './tools/calendar.ts';
import { registerDriveTools } from './tools/drive.ts';
import { registerMeetTools } from './tools/meet.ts';
import { registerTasksTools } from './tools/tasks.ts';
import { registerDocsTools } from './tools/docs.ts';
import { registerPeopleTools } from './tools/people.ts';
import { registerWorkflowTools } from './tools/workflow.ts';

export function registerAllTools(server: McpServer, credFile: string): void {
  registerGmailTools(server, credFile);
  registerCalendarTools(server, credFile);
  registerDriveTools(server, credFile);
  registerMeetTools(server, credFile);
  registerTasksTools(server, credFile);
  registerDocsTools(server, credFile);
  registerPeopleTools(server, credFile);
  registerWorkflowTools(server, credFile);
}
