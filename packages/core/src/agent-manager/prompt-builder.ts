import { SKILL_ORCHESTRATOR, type AgentTask, type Project } from '@raven/shared';
import { resolveToolUseInstructions } from '../project-manager/system-access-gate.ts';

// Verbatim text, relocated from orchestrator.ts's handleUserChat (previously
// prepended fresh to the user message on every chat turn). Moved into the
// system prompt so SDK session resume doesn't re-teach the same rules every
// turn — with `resume`, a per-turn user-message prepend would duplicate into
// history on top of the copy the system prompt already carries.
const MCP_TOOL_INSTRUCTIONS = [
  'You have access to Raven MCP tools. When you receive a user message:',
  '1. Assess complexity and call classify_request with the appropriate mode',
  '2. For DIRECT: do the work, then call send_message with the result',
  '3. For DELEGATED: delegate to a sub-agent, then call send_message with the result',
  '4. For PLANNED: call create_task_tree with the plan and tasks, then call send_message to inform the user',
  'Never output raw JSON task trees. Always use the create_task_tree tool.',
].join('\n');

// Stable per-turn prompt layers for orchestrator chat turns (see the module
// comment above and orchestrator.ts's handleUserChat, which computes
// namedAgentInstructions and systemAccessInstructions per project/agent but
// no longer prepends them to the user message). Split out of
// buildSystemPrompt to keep that function's complexity/length under the
// project's lint guardrails.
function pushOrchestratorLayers(task: AgentTask, parts: string[]): void {
  parts.push(
    '',
    '## Delegation',
    'You have specialized sub-agents available via the Agent tool.',
    'Always delegate domain-specific work (tasks, email, etc.) to the appropriate sub-agent.',
    'Do NOT try to use ToolSearch or load MCP tools directly — your sub-agents already have the right tools.',
  );

  if (task.systemAccessInstructions) {
    parts.push('', '## System Access Control', task.systemAccessInstructions);
  }

  // Tool Use / MCP Tools are chat-turn layers: they instruct the model on
  // how to handle an incoming user message (classify_request, delegate,
  // send_message, create_task_tree). Validator dispatches
  // (internal: 'validator', see create-validation-deps.ts) share
  // skillName: SKILL_ORCHESTRATOR but are not chat turns — they must return
  // raw JSON as their entire answer, which MCP_TOOL_INSTRUCTIONS's "Never
  // output raw JSON task trees" directly contradicts, and their scope is
  // validation, not tool use. Gate both blocks out for them.
  if (task.internal !== 'validator') {
    parts.push('', '## Tool Use', resolveToolUseInstructions());
    parts.push('', '## MCP Tools', MCP_TOOL_INSTRUCTIONS);
  }

  if (task.namedAgentInstructions) {
    parts.push('', '## Agent Instructions', task.namedAgentInstructions);
  }
}

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
    pushOrchestratorLayers(task, parts);
  } else {
    parts.push('- When using tools from MCP servers, prefer structured data over free-form text');
  }

  if (task.projectContextChain) {
    parts.push('', '## Project Context (Inherited)', task.projectContextChain);
  }

  if (task.taskBoardContext) {
    parts.push('', '## Task Board', task.taskBoardContext);
  }

  if (project?.systemPrompt) {
    parts.push('', '## Project Context', project.systemPrompt);
  }

  // Knowledge discovery instruction for project sessions
  if (task.projectId && task.skillName === SKILL_ORCHESTRATOR) {
    parts.push(
      '',
      '## Knowledge Discovery',
      'When you encounter valuable information during this conversation — patterns, findings,',
      'external references, data locations, or decisions — you may propose adding it to project',
      'knowledge. Format proposals as structured suggestions the user can approve, reject, or modify.',
      'Do not re-suggest content similar to previously rejected proposals.',
    );
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
