import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { createClient } from './client.ts';

type Client = ReturnType<typeof createClient>;

const END_OF_DAY_HOURS = 23;
const END_OF_DAY_MINUTES = 59;
const END_OF_DAY_SECONDS = 59;
const END_OF_DAY_MS = 999;

// eslint-disable-next-line max-lines-per-function -- registers all 19 TickTick MCP tools sequentially
export function registerTools(server: McpServer, client: Client): void {
  // --- Projects ---

  server.registerTool(
    'get_projects',
    { description: 'List all TickTick projects', inputSchema: {} },
    async () => {
      const projects = await client.getProjects();
      return { content: [{ type: 'text', text: JSON.stringify(projects, null, 2) }] };
    },
  );

  server.registerTool(
    'get_project',
    {
      description: 'Get a specific project by ID',
      inputSchema: { projectId: z.string().describe('The project ID') },
    },
    async ({ projectId }) => {
      const project = await client.getProject(projectId);
      return { content: [{ type: 'text', text: JSON.stringify(project, null, 2) }] };
    },
  );

  server.registerTool(
    'get_project_tasks',
    {
      description: 'Get all tasks in a project',
      inputSchema: { projectId: z.string().describe('The project ID') },
    },
    async ({ projectId }) => {
      const data = await client.getProjectData(projectId);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.registerTool(
    'create_project',
    {
      description: 'Create a new project',
      inputSchema: {
        name: z.string().describe('Project name'),
        color: z.string().optional().describe('Color hex code'),
        viewMode: z.string().optional().describe('View mode (list, kanban, timeline)'),
        kind: z.string().optional().describe('Project kind'),
      },
    },
    async (input) => {
      const project = await client.createProject(input);
      return { content: [{ type: 'text', text: JSON.stringify(project, null, 2) }] };
    },
  );

  server.registerTool(
    'update_project',
    {
      description: 'Update an existing project',
      inputSchema: {
        projectId: z.string().describe('The project ID'),
        name: z.string().optional().describe('New project name'),
        color: z.string().optional().describe('New color hex code'),
        viewMode: z.string().optional().describe('New view mode'),
      },
    },
    async ({ projectId, ...input }) => {
      const project = await client.updateProject(projectId, input);
      return { content: [{ type: 'text', text: JSON.stringify(project, null, 2) }] };
    },
  );

  server.registerTool(
    'delete_project',
    {
      description: 'Delete a project',
      inputSchema: { projectId: z.string().describe('The project ID to delete') },
    },
    async ({ projectId }) => {
      await client.deleteProject(projectId);
      return { content: [{ type: 'text', text: `Project ${projectId} deleted.` }] };
    },
  );

  // --- Tasks ---

  server.registerTool(
    'get_task',
    {
      description: 'Get a specific task by project ID and task ID',
      inputSchema: {
        projectId: z.string().describe('The project ID'),
        taskId: z.string().describe('The task ID'),
      },
    },
    async ({ projectId, taskId }) => {
      const task = await client.getTask(projectId, taskId);
      return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
    },
  );

  server.registerTool(
    'create_task',
    {
      description: 'Create a new task',
      inputSchema: {
        title: z.string().describe('Task title'),
        projectId: z.string().optional().describe('Project ID (defaults to inbox)'),
        content: z.string().optional().describe('Task content/description'),
        desc: z.string().optional().describe('Task description'),
        dueDate: z.string().optional().describe('Due date (ISO 8601 format)'),
        startDate: z.string().optional().describe('Start date (ISO 8601 format)'),
        priority: z.number().optional().describe('Priority: 0=none, 1=low, 3=medium, 5=high'),
        tags: z.array(z.string()).optional().describe('Tags'),
        isAllDay: z.boolean().optional().describe('Whether this is an all-day task'),
        timeZone: z.string().optional().describe('Time zone (e.g. America/New_York)'),
        reminders: z
          .array(z.string())
          .optional()
          .describe('Reminders (e.g. ["TRIGGER:PT0S", "TRIGGER:P0DT9H0M0S"])'),
        repeatFlag: z
          .string()
          .optional()
          .describe('Recurrence rule (e.g. "RRULE:FREQ=DAILY;INTERVAL=1")'),
        sortOrder: z.number().optional().describe('Sort order within project'),
      },
    },
    async (input) => {
      const task = await client.createTask(input);
      return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
    },
  );

  server.registerTool(
    'update_task',
    {
      description: 'Update an existing task',
      inputSchema: {
        projectId: z.string().describe('The project ID'),
        taskId: z.string().describe('The task ID'),
        title: z.string().optional().describe('New title'),
        content: z.string().optional().describe('New content'),
        desc: z.string().optional().describe('New description'),
        dueDate: z.string().optional().describe('New due date (ISO 8601)'),
        startDate: z.string().optional().describe('New start date (ISO 8601)'),
        priority: z.number().optional().describe('New priority (0, 1, 3, 5)'),
        tags: z.array(z.string()).optional().describe('New tags'),
        isAllDay: z.boolean().optional().describe('All-day flag'),
        reminders: z.array(z.string()).optional().describe('Reminders (e.g. ["TRIGGER:PT0S"])'),
        repeatFlag: z
          .string()
          .optional()
          .describe('Recurrence rule (e.g. "RRULE:FREQ=DAILY;INTERVAL=1")'),
        sortOrder: z.number().optional().describe('Sort order within project'),
      },
    },
    async ({ projectId, taskId, ...input }) => {
      const task = await client.updateTask(taskId, { ...input, id: taskId, projectId });
      return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
    },
  );

  server.registerTool(
    'delete_task',
    {
      description: 'Delete a task',
      inputSchema: {
        projectId: z.string().describe('The project ID'),
        taskId: z.string().describe('The task ID'),
      },
    },
    async ({ projectId, taskId }) => {
      await client.deleteTask(projectId, taskId);
      return { content: [{ type: 'text', text: `Task ${taskId} deleted.` }] };
    },
  );

  server.registerTool(
    'complete_task',
    {
      description: 'Mark a task as complete',
      inputSchema: {
        projectId: z.string().describe('The project ID'),
        taskId: z.string().describe('The task ID'),
      },
    },
    async ({ projectId, taskId }) => {
      await client.completeTask(projectId, taskId);
      return { content: [{ type: 'text', text: `Task ${taskId} completed.` }] };
    },
  );

  server.registerTool(
    'batch_create_tasks',
    {
      description: 'Create multiple tasks at once',
      inputSchema: {
        tasks: z
          .array(
            z.object({
              title: z.string(),
              projectId: z.string().optional(),
              content: z.string().optional(),
              dueDate: z.string().optional(),
              priority: z.number().optional(),
              tags: z.array(z.string()).optional(),
            }),
          )
          .describe('Array of tasks to create'),
      },
    },
    async ({ tasks }) => {
      const created = await client.batchCreateTasks(tasks);
      return { content: [{ type: 'text', text: JSON.stringify(created, null, 2) }] };
    },
  );

  // --- Filter & Search ---

  server.registerTool(
    'filter_tasks',
    {
      description: 'Server-side filtered search for tasks',
      inputSchema: {
        projectIds: z.array(z.string()).optional().describe('Filter by project IDs'),
        startDate: z.string().optional().describe('Start date (ISO 8601)'),
        endDate: z.string().optional().describe('End date (ISO 8601)'),
        priority: z.array(z.number()).optional().describe('Filter by priorities (0, 1, 3, 5)'),
        tags: z.array(z.string()).optional().describe('Filter by tags'),
        status: z.array(z.number()).optional().describe('Filter by status (0=Open, 2=Completed)'),
      },
    },
    async ({ tags, ...rest }) => {
      const tasks = await client.filterTasks({ ...rest, tag: tags });
      return { content: [{ type: 'text', text: JSON.stringify(tasks, null, 2) }] };
    },
  );

  server.registerTool(
    'get_completed_tasks',
    {
      description: 'List completed tasks by date range',
      inputSchema: {
        projectIds: z.array(z.string()).optional().describe('Filter by project IDs'),
        startDate: z.string().optional().describe('Completed after this date (ISO 8601)'),
        endDate: z.string().optional().describe('Completed before this date (ISO 8601)'),
      },
    },
    async (input) => {
      const tasks = await client.getCompletedTasks(input);
      return { content: [{ type: 'text', text: JSON.stringify(tasks, null, 2) }] };
    },
  );

  server.registerTool(
    'move_task',
    {
      description: 'Move a task between projects',
      inputSchema: {
        taskId: z.string().describe('The task ID to move'),
        fromProjectId: z.string().describe('Source project ID'),
        toProjectId: z.string().describe('Destination project ID'),
      },
    },
    async (input) => {
      const result = await client.moveTasks([input]);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  // --- Aggregate tools ---

  server.registerTool(
    'get_all_tasks',
    {
      description: 'Get all open tasks across all projects using server-side filter',
      inputSchema: {},
    },
    async () => {
      const tasks = await client.filterTasks({ status: [0] });
      return { content: [{ type: 'text', text: JSON.stringify(tasks, null, 2) }] };
    },
  );

  server.registerTool(
    'get_today_tasks',
    {
      description: 'Get tasks due today or overdue across all projects',
      inputSchema: {},
    },
    async () => {
      const endOfToday = new Date();
      endOfToday.setHours(END_OF_DAY_HOURS, END_OF_DAY_MINUTES, END_OF_DAY_SECONDS, END_OF_DAY_MS);

      const tasks = await client.filterTasks({
        status: [0],
        endDate: endOfToday.toISOString(),
      });

      const sorted = [...tasks].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
      return { content: [{ type: 'text', text: JSON.stringify(sorted, null, 2) }] };
    },
  );
}
