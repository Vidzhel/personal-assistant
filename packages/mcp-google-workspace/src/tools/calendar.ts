import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gwsExec } from '../gws-exec.ts';

function formatResult(data: unknown): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

// eslint-disable-next-line max-lines-per-function -- registers 6 Calendar MCP tools
export function registerCalendarTools(server: McpServer, credFile: string): void {
  server.registerTool(
    'calendar_agenda',
    {
      description: 'Show upcoming calendar events across all calendars',
      inputSchema: {
        today: z.boolean().optional().describe('Show only today'),
        tomorrow: z.boolean().optional().describe('Show only tomorrow'),
        week: z.boolean().optional().describe('Show this week'),
        days: z.number().optional().describe('Number of days ahead to show'),
        calendar: z.string().optional().describe('Filter to specific calendar name or ID'),
        timezone: z.string().optional().describe('IANA timezone override'),
      },
    },
    async (input) => {
      const args = ['calendar', '+agenda', '--format', 'json'];
      if (input.today) args.push('--today');
      if (input.tomorrow) args.push('--tomorrow');
      if (input.week) args.push('--week');
      if (input.days) args.push('--days', String(input.days));
      if (input.calendar) args.push('--calendar', input.calendar);
      if (input.timezone) args.push('--timezone', input.timezone);
      const result = await gwsExec(args, { credentialsFile: credFile });
      return formatResult(result.data);
    },
  );

  server.registerTool(
    'calendar_insert',
    {
      description: 'Create a new calendar event with optional Meet link',
      inputSchema: {
        summary: z.string().describe('Event title'),
        start: z.string().describe('Start datetime (ISO 8601)'),
        end: z.string().describe('End datetime (ISO 8601)'),
        description: z.string().optional().describe('Event description'),
        location: z.string().optional().describe('Event location'),
        attendees: z.array(z.string()).optional().describe('Attendee email addresses'),
        calendar: z.string().optional().describe('Calendar ID (default: primary)'),
        meet: z.boolean().optional().describe('Add a Google Meet video conference link'),
      },
    },
    async (input) => {
      const args = [
        'calendar',
        '+insert',
        '--summary',
        input.summary,
        '--start',
        input.start,
        '--end',
        input.end,
        '--format',
        'json',
      ];
      if (input.description) args.push('--description', input.description);
      if (input.location) args.push('--location', input.location);
      if (input.attendees) {
        for (const email of input.attendees) args.push('--attendee', email);
      }
      if (input.calendar) args.push('--calendar', input.calendar);
      if (input.meet) args.push('--meet');
      const result = await gwsExec(args, { credentialsFile: credFile });
      return formatResult(result.data);
    },
  );

  server.registerTool(
    'calendar_get',
    {
      description: 'Get details of a specific calendar event',
      inputSchema: {
        eventId: z.string().describe('Calendar event ID'),
        calendarId: z.string().optional().describe('Calendar ID (default: primary)'),
      },
    },
    async (input) => {
      const params: Record<string, string> = { eventId: input.eventId };
      if (input.calendarId) params.calendarId = input.calendarId;
      const args = [
        'calendar',
        'events',
        'get',
        '--params',
        JSON.stringify(params),
        '--format',
        'json',
      ];
      const result = await gwsExec(args, { credentialsFile: credFile });
      return formatResult(result.data);
    },
  );

  server.registerTool(
    'calendar_update',
    {
      description: 'Update a calendar event',
      inputSchema: {
        eventId: z.string().describe('Calendar event ID'),
        calendarId: z.string().optional().describe('Calendar ID (default: primary)'),
        summary: z.string().optional().describe('New event title'),
        start: z.string().optional().describe('New start datetime (ISO 8601)'),
        end: z.string().optional().describe('New end datetime (ISO 8601)'),
        description: z.string().optional().describe('New description'),
        location: z.string().optional().describe('New location'),
      },
    },
    async (input) => {
      const params: Record<string, string> = { eventId: input.eventId };
      if (input.calendarId) params.calendarId = input.calendarId;
      const body: Record<string, unknown> = {};
      if (input.summary) body.summary = input.summary;
      if (input.description) body.description = input.description;
      if (input.location) body.location = input.location;
      if (input.start) body.start = { dateTime: input.start };
      if (input.end) body.end = { dateTime: input.end };
      const args = [
        'calendar',
        'events',
        'patch',
        '--params',
        JSON.stringify(params),
        '--json',
        JSON.stringify(body),
        '--format',
        'json',
      ];
      const result = await gwsExec(args, { credentialsFile: credFile });
      return formatResult(result.data);
    },
  );

  server.registerTool(
    'calendar_delete',
    {
      description: 'Delete a calendar event',
      inputSchema: {
        eventId: z.string().describe('Calendar event ID'),
        calendarId: z.string().optional().describe('Calendar ID (default: primary)'),
      },
    },
    async (input) => {
      const params: Record<string, string> = { eventId: input.eventId };
      if (input.calendarId) params.calendarId = input.calendarId;
      const args = [
        'calendar',
        'events',
        'delete',
        '--params',
        JSON.stringify(params),
        '--format',
        'json',
      ];
      const result = await gwsExec(args, { credentialsFile: credFile });
      return formatResult(result.data);
    },
  );

  server.registerTool(
    'calendar_list',
    {
      description: 'List available calendars',
      inputSchema: {},
    },
    async () => {
      const args = ['calendar', 'calendarList', 'list', '--format', 'json'];
      const result = await gwsExec(args, { credentialsFile: credFile });
      return formatResult(result.data);
    },
  );
}
