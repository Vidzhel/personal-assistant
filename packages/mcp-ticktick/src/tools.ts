import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { createClient } from './client.ts';

type Client = ReturnType<typeof createClient>;

export function registerTools(server: McpServer, client: Client): void {
  // --- Projects ---

  server.tool('get_projects', 'List all TickTick projects', {}, async () => {
    const projects = await client.getProjects();
    return { content: [{ type: 'text', text: JSON.stringify(projects, null, 2) }] };
  });

  server.tool(
    'get_project',
    'Get a specific project by ID',
    { projectId: z.string().describe('The project ID') },
    async ({ projectId }) => {
      const project = await client.getProject(projectId);
      return { content: [{ type: 'text', text: JSON.stringify(project, null, 2) }] };
    },
  );

  server.tool(
    'get_project_tasks',
    'Get all tasks in a project',
    { projectId: z.string().describe('The project ID') },
    async ({ projectId }) => {
      const data = await client.getProjectData(projectId);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'create_project',
    'Create a new project',
    {
      name: z.string().describe('Project name'),
      color: z.string().optional().describe('Color hex code'),
      viewMode: z.string().optional().describe('View mode (list, kanban, timeline)'),
      kind: z.string().optional().describe('Project kind'),
    },
    async (input) => {
      const project = await client.createProject(input);
      return { content: [{ type: 'text', text: JSON.stringify(project, null, 2) }] };
    },
  );

  server.tool(
    'update_project',
    'Update an existing project',
    {
      projectId: z.string().describe('The project ID'),
      name: z.string().optional().describe('New project name'),
      color: z.string().optional().describe('New color hex code'),
      viewMode: z.string().optional().describe('New view mode'),
    },
    async ({ projectId, ...input }) => {
      const project = await client.updateProject(projectId, input);
      return { content: [{ type: 'text', text: JSON.stringify(project, null, 2) }] };
    },
  );

  server.tool(
    'delete_project',
    'Delete a project',
    { projectId: z.string().describe('The project ID to delete') },
    async ({ projectId }) => {
      await client.deleteProject(projectId);
      return { content: [{ type: 'text', text: `Project ${projectId} deleted.` }] };
    },
  );

  // --- Tasks ---

  server.tool(
    'get_task',
    'Get a specific task by project ID and task ID',
    {
      projectId: z.string().describe('The project ID'),
      taskId: z.string().describe('The task ID'),
    },
    async ({ projectId, taskId }) => {
      const task = await client.getTask(projectId, taskId);
      return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
    },
  );

  server.tool(
    'create_task',
    'Create a new task',
    {
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
    },
    async (input) => {
      const task = await client.createTask(input);
      return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
    },
  );

  server.tool(
    'update_task',
    'Update an existing task',
    {
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
    },
    async ({ projectId, taskId, ...input }) => {
      const task = await client.updateTask(projectId, taskId, input);
      return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
    },
  );

  server.tool(
    'delete_task',
    'Delete a task',
    {
      projectId: z.string().describe('The project ID'),
      taskId: z.string().describe('The task ID'),
    },
    async ({ projectId, taskId }) => {
      await client.deleteTask(projectId, taskId);
      return { content: [{ type: 'text', text: `Task ${taskId} deleted.` }] };
    },
  );

  server.tool(
    'complete_task',
    'Mark a task as complete',
    {
      projectId: z.string().describe('The project ID'),
      taskId: z.string().describe('The task ID'),
    },
    async ({ projectId, taskId }) => {
      await client.completeTask(projectId, taskId);
      return { content: [{ type: 'text', text: `Task ${taskId} completed.` }] };
    },
  );

  server.tool(
    'batch_create_tasks',
    'Create multiple tasks at once',
    {
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
    async ({ tasks }) => {
      const created = await client.batchCreateTasks(tasks);
      return { content: [{ type: 'text', text: JSON.stringify(created, null, 2) }] };
    },
  );

  // --- Aggregate tools ---

  server.tool(
    'get_all_tasks',
    'Get all tasks across all projects. Iterates every project and merges tasks.',
    {},
    async () => {
      const projects = await client.getProjects();
      const allTasks: Array<{ project: string; projectId: string; tasks: unknown[] }> = [];
      for (const project of projects) {
        const data = await client.getProjectData(project.id);
        if (data.tasks && data.tasks.length > 0) {
          allTasks.push({ project: project.name, projectId: project.id, tasks: data.tasks });
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify(allTasks, null, 2) }] };
    },
  );

  server.tool(
    'get_today_tasks',
    'Get tasks due today or overdue across all projects',
    {},
    async () => {
      const projects = await client.getProjects();
      const endOfToday = new Date();
      endOfToday.setHours(23, 59, 59, 999);

      const todayTasks: Array<{
        project: string;
        projectId: string;
        title: string;
        taskId: string;
        dueDate?: string;
        priority?: number;
      }> = [];

      for (const project of projects) {
        const data = await client.getProjectData(project.id);
        if (!data.tasks) continue;
        for (const task of data.tasks) {
          if (task.dueDate && new Date(task.dueDate) <= endOfToday && task.status === 0) {
            todayTasks.push({
              project: project.name,
              projectId: project.id,
              title: task.title,
              taskId: task.id,
              dueDate: task.dueDate,
              priority: task.priority,
            });
          }
        }
      }

      todayTasks.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
      return { content: [{ type: 'text', text: JSON.stringify(todayTasks, null, 2) }] };
    },
  );
}
