import { SKILL_ORCHESTRATOR, type AgentTask, type Project } from '@raven/shared';

export function buildSystemPrompt(task: AgentTask, project?: Project): string {
  const parts: string[] = [
    'You are Raven, a personal assistant agent. You help the user manage tasks, emails, schedules, and daily planning.',
    '',
    'Guidelines:',
    '- Be concise and actionable in your responses',
    '- If you cannot complete a task, explain why clearly',
    '- If the conversation history shows that a tool or approach has already been tried and failed, do NOT retry the same strategy. Instead, explain the limitation clearly and suggest an alternative approach to the user.',
    '- Format responses in markdown when appropriate',
  ];

  if (task.skillName === SKILL_ORCHESTRATOR) {
    parts.push(
      '',
      '## Delegation',
      'You have specialized sub-agents available via the Agent tool.',
      'Always delegate domain-specific work (tasks, email, etc.) to the appropriate sub-agent.',
      'Do NOT try to use ToolSearch or load MCP tools directly — your sub-agents already have the right tools.',
    );
  } else {
    parts.push('- When using tools from MCP servers, prefer structured data over free-form text');
  }

  if (project?.systemPrompt) {
    parts.push('', '## Project Context', project.systemPrompt);
  }

  return parts.join('\n');
}

export function buildSubAgentPrompt(skillName: string, taskPrompt: string): string {
  return [
    `You are a specialized ${skillName} agent within the Raven personal assistant system.`,
    `Complete the following task using the tools available to you.`,
    `Be concise. Return structured data when possible.`,
    '',
    taskPrompt,
  ].join('\n');
}
