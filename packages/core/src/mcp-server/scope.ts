import { z } from 'zod';

export const ScopeContextSchema = z.object({
  role: z.enum(['task', 'chat', 'system', 'validation', 'knowledge']),
  projectId: z.string().optional(),
  sessionId: z.string().optional(),
  treeId: z.string().optional(),
  taskId: z.string().optional(),
});

export type ScopeContext = z.infer<typeof ScopeContextSchema>;

const SCOPE_TOOLS: Record<ScopeContext['role'], Set<string>> = {
  task: new Set([
    'get_task_context',
    'complete_task',
    'fail_task',
    'update_task_progress',
    'save_artifact',
    'search_knowledge',
    'send_message',
  ]),
  chat: new Set([
    'classify_request',
    'create_task_tree',
    'escalate_to_planned',
    'send_message',
    'get_session_history',
    'search_knowledge',
    'list_agents',
  ]),
  system: new Set(['*']),
  validation: new Set(['submit_validation_score', 'get_task_context']),
  knowledge: new Set(['search_knowledge', 'save_knowledge', 'get_knowledge_context']),
};

export function isToolAllowed(scope: ScopeContext, toolName: string): boolean {
  const allowed = SCOPE_TOOLS[scope.role];
  return allowed.has('*') || allowed.has(toolName);
}

export function parseScopeContext(input: unknown): ScopeContext {
  return ScopeContextSchema.parse(input);
}
