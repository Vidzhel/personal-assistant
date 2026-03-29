import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { isToolAllowed, type ScopeContext } from './scope.ts';
import { buildTaskLifecycleTools } from './tools/task-lifecycle.ts';
import { buildSessionTools } from './tools/session.ts';
import { buildKnowledgeTools } from './tools/knowledge.ts';
import { buildValidationTools } from './tools/validation.ts';
import { buildSystemTools } from './tools/system.ts';
import { buildEscalationTools } from './tools/escalation.ts';
import type { RavenMcpDeps } from './types.ts';

export type { RavenMcpDeps } from './types.ts';
export { type ScopeContext } from './scope.ts';

export function createRavenMcp(
  deps: RavenMcpDeps,
  scope: ScopeContext,
): McpSdkServerConfigWithInstance {
  const allTools = [
    ...buildTaskLifecycleTools(deps, scope),
    ...buildSessionTools(deps, scope),
    ...buildKnowledgeTools(deps, scope),
    ...buildValidationTools(deps, scope),
    ...buildSystemTools(deps, scope),
    ...buildEscalationTools(deps, scope),
  ];

  const scopedTools = allTools.filter((t) => isToolAllowed(scope, t.name));

  return createSdkMcpServer({ name: 'raven', version: '1.0.0', tools: scopedTools });
}
