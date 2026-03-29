import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { generateId } from '@raven/shared';
import type { RavenMcpDeps } from '../types.ts';
import type { ScopeContext } from '../scope.ts';

// ── Magic number constants ──────────────────────────────────────────────

const APPROVAL_POLL_INTERVAL_MS = 2000;
const APPROVAL_TIMEOUT_MS = 300_000; // 5 minutes

// ── Helpers ─────────────────────────────────────────────────────────────

const errorResult = (
  message: string,
): { content: [{ type: 'text'; text: string }]; isError: true } => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

const okResult = (data: unknown): { content: [{ type: 'text'; text: string }] } => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
});

// ── Task node schema ─────────────────────────────────────────────────────

const TaskNodeSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  type: z
    .enum(['agent', 'code', 'condition', 'notify', 'delay', 'approval'])
    .optional()
    .default('agent'),
  agent: z.string().optional(),
  prompt: z.string().min(1),
  blockedBy: z.array(z.string()).optional().default([]),
});

// ── waitForResolution polling helper ────────────────────────────────────

async function waitForResolution(
  approvalId: string,
  deps: RavenMcpDeps,
): Promise<'approved' | 'denied'> {
  const deadline = Date.now() + APPROVAL_TIMEOUT_MS;

  return new Promise<'approved' | 'denied'>((resolve, reject) => {
    const poll = (): void => {
      if (Date.now() > deadline) {
        reject(new Error(`Approval timed out after ${APPROVAL_TIMEOUT_MS}ms`));
        return;
      }

      const approval = deps.pendingApprovals?.getById(approvalId);
      if (approval?.resolution) {
        resolve(approval.resolution);
        return;
      }

      setTimeout(poll, APPROVAL_POLL_INTERVAL_MS);
    };

    poll();
  });
}

// ── buildEscalationTools ────────────────────────────────────────────────

export function buildEscalationTools(
  deps: RavenMcpDeps,
  scope: ScopeContext,
): SdkMcpToolDefinition[] {
  const escalateToPlanned = tool(
    'escalate_to_planned',
    'Escalate the current request to a planned task tree for structured execution.',
    {
      plan: z.string().min(1).describe('High-level plan description'),
      tasks: z.array(TaskNodeSchema).min(1).describe('Ordered list of tasks to execute'),
    },
    async (args) => {
      if (!deps.executionEngine) {
        return errorResult('executionEngine not available — cannot escalate_to_planned');
      }

      const treeId = generateId();
      const tasks = args.tasks.map((t) => ({
        id: t.id,
        title: t.title,
        type: t.type ?? 'agent',
        ...(t.agent !== undefined && { agent: t.agent }),
        prompt: t.prompt,
        blockedBy: t.blockedBy ?? [],
      }));

      const tree = deps.executionEngine.createTree({
        id: treeId,
        projectId: scope.projectId,
        plan: args.plan,
        tasks,
      });

      await deps.executionEngine.startTree(treeId);

      deps.eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: 'mcp-server',
        type: 'execution:tree:created',
        payload: {
          treeId: tree.id,
          plan: args.plan,
          taskCount: tasks.length,
          projectId: scope.projectId,
        },
      });

      return okResult({ treeId: tree.id, status: 'running' });
    },
  );

  const requestApproval = tool(
    'request_approval',
    'Request explicit approval from the user before proceeding with an action.',
    {
      question: z.string().min(1).describe('The question or action to seek approval for'),
      options: z.array(z.string()).optional().describe('Specific options for the user to choose from'),
    },
    async (args) => {
      if (!deps.pendingApprovals) {
        return errorResult('pendingApprovals not available — cannot request_approval');
      }

      const details = args.options?.length
        ? `Options: ${args.options.join(', ')}`
        : undefined;

      const approval = deps.pendingApprovals.insert({
        actionName: args.question,
        skillName: 'orchestrator',
        ...(details !== undefined && { details }),
        ...(scope.sessionId !== undefined && { sessionId: scope.sessionId }),
      });

      deps.eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: 'mcp-server',
        type: 'approval:requested',
        payload: {
          approvalId: approval.id,
          question: args.question,
          options: args.options,
          sessionId: scope.sessionId,
          projectId: scope.projectId,
        },
      });

      try {
        const resolution = await waitForResolution(approval.id, deps);
        const approved = resolution === 'approved';

        return okResult({ approved, choice: approved ? 'approved' : 'denied' });
      } catch (err) {
        return errorResult(`Approval timed out or failed: ${String(err)}`);
      }
    },
  );

  return [escalateToPlanned, requestApproval];
}
