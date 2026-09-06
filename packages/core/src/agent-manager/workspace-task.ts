import { createHash } from 'node:crypto';
import type { AgentTask, SubAgentDefinition } from '@raven/shared';
import { getConfig } from '../config.ts';
import type {
  WorkspaceExecution,
  WorkspaceExecutionResolver,
} from '../project-manager/workspace-execution.ts';

export function taskResumeRevision(
  task: AgentTask,
  workspace?: WorkspaceExecution,
): string | undefined {
  if (workspace) return workspace.revision;
  if (!task.modelConfig) return undefined;
  return createHash('sha256').update(JSON.stringify(task.modelConfig)).digest('hex');
}

/** Task context participates in resume identity, but per-turn prompts and memory do not. */
export function resolveTaskWorkspace(
  task: AgentTask,
  resolver: WorkspaceExecutionResolver,
): WorkspaceExecution {
  const workspace = resolver.resolve(task);
  const revision = createHash('sha256')
    .update(
      JSON.stringify({
        workspace: workspace.revision,
        model: task.model ?? getConfig().CLAUDE_MODEL,
        effort: task.modelConfig?.effort,
        thinking: task.modelConfig?.thinking,
        maxTurns: task.maxTurns ?? getConfig().RAVEN_AGENT_MAX_TURNS,
        bash: task.bashAccess,
        mcpServers: task.mcpServers,
        agents: task.agentDefinitions,
        plugins: task.plugins,
        instructions: task.namedAgentInstructions,
        systemAccess: task.systemAccessInstructions,
        approvedAction: task.approvedActionName,
      }),
    )
    .digest('hex');
  if (task.workspaceRevision && task.workspaceRevision !== revision) {
    throw new Error('Project execution grant changed; submit a new task');
  }
  return { ...workspace, revision };
}

/** SDK skill agents start with their own prompt; share the same project context explicitly. */
export function applyWorkspaceContext(
  definitions: Record<string, SubAgentDefinition>,
  workspace?: WorkspaceExecution,
): Record<string, SubAgentDefinition> {
  if (!workspace) return definitions;
  const context = [
    workspace.projectContextChain
      ? `## Project Context (Inherited)\n${workspace.projectContextChain}`
      : '',
    workspace.workspaceContext,
  ]
    .filter(Boolean)
    .join('\n\n');
  return Object.fromEntries(
    Object.entries(definitions).map(([name, definition]) => [
      name,
      { ...definition, prompt: `${definition.prompt}\n\n${context}` },
    ]),
  );
}
