import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildEscalationTools } from '../../../mcp-server/tools/escalation.ts';
import type { RavenMcpDeps } from '../../../mcp-server/types.ts';
import type { ScopeContext } from '../../../mcp-server/scope.ts';
import type { TaskTree } from '@raven/shared';

describe('buildEscalationTools', () => {
  let deps: RavenMcpDeps;
  let scope: ScopeContext;

  beforeEach(() => {
    const mockTree: TaskTree = {
      id: 'tree-123',
      status: 'pending_approval',
      tasks: new Map(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    deps = {
      eventBus: { emit: vi.fn() },
      executionEngine: {
        createTree: vi.fn().mockReturnValue(mockTree),
        startTree: vi.fn().mockResolvedValue(undefined),
      },
      pendingApprovals: {
        insert: vi.fn().mockReturnValue({
          id: 'approval-123',
          actionName: 'question',
          skillName: 'orchestrator',
          requestedAt: new Date().toISOString(),
        }),
        resolve: vi.fn(),
        query: vi.fn().mockReturnValue([]),
        getById: vi.fn(),
        initialize: vi.fn(),
      },
    } as any;

    scope = { role: 'chat', projectId: 'proj-abc' };
  });

  describe('escalate_to_planned', () => {
    it('creates and starts a task tree', async () => {
      const tools = buildEscalationTools(deps, scope);
      const tool = tools.find((t) => t.name === 'escalate_to_planned');
      expect(tool).toBeDefined();

      const args = {
        plan: 'Do something useful',
        tasks: [
          { id: 'task-1', title: 'First task', prompt: 'Do the first thing' },
          {
            id: 'task-2',
            title: 'Second task',
            prompt: 'Do the second thing',
            blockedBy: ['task-1'],
          },
        ],
      };

      const result = await tool!.handler(args, {});

      expect(deps.executionEngine!.createTree).toHaveBeenCalledOnce();
      const createCall = (deps.executionEngine!.createTree as any).mock.calls[0][0];
      expect(createCall.projectId).toBe('proj-abc');
      expect(createCall.plan).toBe('Do something useful');
      expect(createCall.tasks).toHaveLength(2);
      expect(createCall.tasks[0].type).toBe('agent');
      expect(createCall.tasks[1].blockedBy).toEqual(['task-1']);

      // startTree is called with the treeId returned from createTree
      expect(deps.executionEngine!.startTree).toHaveBeenCalledWith('tree-123');

      expect(deps.eventBus.emit).toHaveBeenCalledOnce();
      const emittedEvent = (deps.eventBus.emit as any).mock.calls[0][0];
      expect(emittedEvent.type).toBe('execution:tree:created');
      expect(emittedEvent.payload.treeId).toBe('tree-123');

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content[0] as any).text);
      expect(parsed.treeId).toBe('tree-123');
      expect(parsed.status).toBe('running');
    });

    it('returns error when executionEngine not available', async () => {
      deps.executionEngine = undefined;
      const tools = buildEscalationTools(deps, scope);
      const tool = tools.find((t) => t.name === 'escalate_to_planned');

      const result = await tool!.handler(
        { plan: 'test', tasks: [{ id: 't1', title: 'Task 1', prompt: 'Do it' }] },
        {},
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain('executionEngine');
    });

    it('defaults task type to agent', async () => {
      const tools = buildEscalationTools(deps, scope);
      const tool = tools.find((t) => t.name === 'escalate_to_planned');

      await tool!.handler(
        { plan: 'test', tasks: [{ id: 't1', title: 'Task 1', prompt: 'Do it' }] },
        {},
      );

      const createCall = (deps.executionEngine!.createTree as any).mock.calls[0][0];
      expect(createCall.tasks[0].type).toBe('agent');
    });
  });

  describe('request_approval', () => {
    it('returns error when pendingApprovals not available', async () => {
      deps.pendingApprovals = undefined;
      const tools = buildEscalationTools(deps, scope);
      const tool = tools.find((t) => t.name === 'request_approval');
      expect(tool).toBeDefined();

      const result = await tool!.handler({ question: 'Are you sure?' }, {});

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain('pendingApprovals');
    });

    it('creates a pending approval and emits approval:requested event', async () => {
      // Mock getById to return resolved approval immediately
      (deps.pendingApprovals!.getById as any).mockReturnValue({
        id: 'approval-123',
        actionName: 'Are you sure?',
        skillName: 'orchestrator',
        requestedAt: new Date().toISOString(),
        resolution: 'approved',
      });

      const tools = buildEscalationTools(deps, scope);
      const tool = tools.find((t) => t.name === 'request_approval');

      const result = await tool!.handler({ question: 'Are you sure?' }, {});

      expect(deps.pendingApprovals!.insert).toHaveBeenCalledOnce();
      const insertCall = (deps.pendingApprovals!.insert as any).mock.calls[0][0];
      expect(insertCall.actionName).toBe('Are you sure?');
      expect(insertCall.skillName).toBe('orchestrator');

      expect(deps.eventBus.emit).toHaveBeenCalledOnce();
      const emittedEvent = (deps.eventBus.emit as any).mock.calls[0][0];
      expect(emittedEvent.type).toBe('approval:requested');
      expect(emittedEvent.payload.approvalId).toBe('approval-123');

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content[0] as any).text);
      expect(parsed.approved).toBe(true);
    });
  });
});
