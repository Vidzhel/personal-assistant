import type { AgentTask, Project } from '@raven/shared';

export function buildSystemPrompt(task: AgentTask, project?: Project): string {
  const parts: string[] = [
    'You are Raven, a personal assistant agent. You help the user manage tasks, emails, schedules, and daily planning.',
    '',
    'Guidelines:',
    '- Be concise and actionable in your responses',
    '- When using tools from MCP servers, prefer structured data over free-form text',
    '- If you cannot complete a task, explain why clearly',
    '- Format responses in markdown when appropriate',
  ];

  if (project?.systemPrompt) {
    parts.push('', '## Project Context', project.systemPrompt);
  }

  return parts.join('\n');
}

export function buildSubAgentPrompt(
  skillName: string,
  taskPrompt: string,
): string {
  return [
    `You are a specialized ${skillName} agent within the Raven personal assistant system.`,
    `Complete the following task using the tools available to you.`,
    `Be concise. Return structured data when possible.`,
    '',
    taskPrompt,
  ].join('\n');
}
