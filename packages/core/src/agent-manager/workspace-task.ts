import { createHash } from 'node:crypto';
import type { AgentTask } from '@raven/shared';
import { getConfig } from '../config.ts';
import type {
  WorkspaceExecution,
  WorkspaceExecutionResolver,
} from '../project-manager/workspace-execution.ts';

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
