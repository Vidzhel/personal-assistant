import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildTaskLifecycleTools } from '../../../mcp-server/tools/task-lifecycle.ts';
import type { RavenMcpDeps } from '../../../mcp-server/types.ts';
import type { ScopeContext } from '../../../mcp-server/scope.ts';
import type { TaskTree } from '@raven/shared';

function makeExecutionEngine() {
  return {
    createTree: vi.fn().mockReturnValue({
      id: 'tree-1',
      tasks: new Map(),
      status: 'pending_approval',
    } satisfies Partial<TaskTree> as any),
    startTree: vi.fn().mockResolvedValue(undefined),
    onTaskCompleted: vi.fn().mockResolvedValue(undefined),
    onTaskBlocked: vi.fn(),
    getTree: vi.fn().mockReturnValue(undefined),
  };
}

describe('buildTaskLifecycleTools', () => {
  let deps: RavenMcpDeps;
  let engine: ReturnType<typeof makeExecutionEngine>;
  let scope: ScopeContext;

  beforeEach(() => {
    engine = makeExecutionEngine();
    deps = {
      eventBus: { emit: vi.fn() } as any,
      executionEngine: engine as any,
    } as any;
    scope = { role: 'task', treeId: 'tree-1', taskId: 'task-1' };
  });

  it('returns array with expected tool names', () => {
    const tools = buildTaskLifecycleTools(deps, scope);
    const names = tools.map((t) => t.name);
    expect(names).toContain('classify_request');
    expect(names).toContain('create_task_tree');
    expect(names).toContain('get_task_context');
    expect(names).toContain('complete_task');
    expect(names).toContain('fail_task');
    expect(names).toContain('update_task_progress');
    expect(names).toContain('save_artifact');
    expect(names).toHaveLength(7);
  });

  describe('classify_request', () => {
    it('returns ack with mode and reason', async () => {
      const tools = buildTaskLifecycleTools(deps, { role: 'chat', sessionId: 'sess-1' });
      const tool = tools.find((t) => t.name === 'classify_request')!;

      const result = await tool.handler({ mode: 'direct', reason: 'Simple lookup' }, {});

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content[0] as any).text);
      expect(parsed.ack).toBe(true);
      expect(parsed.mode).toBe('direct');
      expect(parsed.reason).toBe('Simple lookup');
    });

    it('supports all mode values', async () => {
      const tools = buildTaskLifecycleTools(deps, { role: 'chat' });
      const tool = tools.find((t) => t.name === 'classify_request')!;

      for (const mode of ['direct', 'delegated', 'planned'] as const) {
        const result = await tool.handler({ mode, reason: 'test' }, {});
        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content[0] as any).text);
        expect(parsed.mode).toBe(mode);
      }
    });
  });

  describe('create_task_tree', () => {
    it('calls createTree and startTree when autoApprove=true', async () => {
      const tools = buildTaskLifecycleTools(deps, { role: 'chat', projectId: 'proj-1' });
      const tool = tools.find((t) => t.name === 'create_task_tree')!;

      const tasks = [
        { id: 'task-a', type: 'agent', title: 'Do thing', prompt: 'Do it', blockedBy: [] },
      ];

      const result = await tool.handler({ plan: 'The plan', tasks, autoApprove: true }, {});

      expect(engine.createTree).toHaveBeenCalledOnce();
      const createArgs = engine.createTree.mock.calls[0][0];
      expect(createArgs.plan).toBe('The plan');
      expect(createArgs.tasks).toEqual(tasks);

      expect(engine.startTree).toHaveBeenCalledOnce();

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content[0] as any).text);
      expect(parsed.treeId).toBeDefined();
      expect(parsed.status).toBeDefined();
    });

    it('does not call startTree when autoApprove=false', async () => {
      const tools = buildTaskLifecycleTools(deps, { role: 'chat' });
      const tool = tools.find((t) => t.name === 'create_task_tree')!;

      await tool.handler({ plan: 'plan', tasks: [], autoApprove: false }, {});

      expect(engine.createTree).toHaveBeenCalledOnce();
      expect(engine.startTree).not.toHaveBeenCalled();
    });
  });

  describe('complete_task', () => {
    it('calls onTaskCompleted with correct args', async () => {
      const tools = buildTaskLifecycleTools(deps, scope);
      const tool = tools.find((t) => t.name === 'complete_task')!;

      const artifacts = [{ type: 'data' as const, label: 'result', data: { value: 42 } }];
      const result = await tool.handler({ summary: 'Task done successfully', artifacts }, {});

      expect(engine.onTaskCompleted).toHaveBeenCalledOnce();
      const callArgs = engine.onTaskCompleted.mock.calls[0][0];
      expect(callArgs.treeId).toBe('tree-1');
      expect(callArgs.taskId).toBe('task-1');
      expect(callArgs.summary).toBe('Task done successfully');
      expect(callArgs.artifacts).toEqual(artifacts);

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content[0] as any).text);
      expect(parsed.ack).toBe(true);
    });

    it('returns error when no taskId in scope', async () => {
      const noTaskScope: ScopeContext = { role: 'task', treeId: 'tree-1' };
      const tools = buildTaskLifecycleTools(deps, noTaskScope);
      const tool = tools.find((t) => t.name === 'complete_task')!;

      const result = await tool.handler({ summary: 'done' }, {});

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain('taskId');
      expect(engine.onTaskCompleted).not.toHaveBeenCalled();
    });

    it('returns error when no treeId in scope', async () => {
      const noTreeScope: ScopeContext = { role: 'task', taskId: 'task-1' };
      const tools = buildTaskLifecycleTools(deps, noTreeScope);
      const tool = tools.find((t) => t.name === 'complete_task')!;

      const result = await tool.handler({ summary: 'done' }, {});

      expect(result.isError).toBe(true);
      expect(engine.onTaskCompleted).not.toHaveBeenCalled();
    });
  });

  describe('fail_task', () => {
    it('calls onTaskBlocked with correct args', async () => {
      const tools = buildTaskLifecycleTools(deps, scope);
      const tool = tools.find((t) => t.name === 'fail_task')!;

      const result = await tool.handler({ error: 'Something broke', retryable: true }, {});

      expect(engine.onTaskBlocked).toHaveBeenCalledOnce();
      expect(engine.onTaskBlocked).toHaveBeenCalledWith('tree-1', 'task-1', 'Something broke');

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content[0] as any).text);
      expect(parsed.ack).toBe(true);
      expect(parsed.willRetry).toBe(true);
    });

    it('passes retryable=false to willRetry', async () => {
      const tools = buildTaskLifecycleTools(deps, scope);
      const tool = tools.find((t) => t.name === 'fail_task')!;

      const result = await tool.handler({ error: 'fatal', retryable: false }, {});

      const parsed = JSON.parse((result.content[0] as any).text);
      expect(parsed.willRetry).toBe(false);
    });

    it('returns error when scope has no taskId', async () => {
      const tools = buildTaskLifecycleTools(deps, { role: 'task', treeId: 'tree-1' });
      const tool = tools.find((t) => t.name === 'fail_task')!;

      const result = await tool.handler({ error: 'err', retryable: false }, {});

      expect(result.isError).toBe(true);
      expect(engine.onTaskBlocked).not.toHaveBeenCalled();
    });
  });

  describe('update_task_progress', () => {
    it('emits event with progress and statusText', async () => {
      const tools = buildTaskLifecycleTools(deps, scope);
      const tool = tools.find((t) => t.name === 'update_task_progress')!;

      const result = await tool.handler({ progress: 50, statusText: 'Halfway done' }, {});

      expect(deps.eventBus.emit).toHaveBeenCalledOnce();
      const emitted = (deps.eventBus.emit as any).mock.calls[0][0];
      expect(emitted.type).toBe('execution:task:progress');
      expect(emitted.payload.progress).toBe(50);
      expect(emitted.payload.statusText).toBe('Halfway done');
      expect(emitted.payload.taskId).toBe('task-1');

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content[0] as any).text);
      expect(parsed.ack).toBe(true);
    });
  });

  describe('save_artifact', () => {
    it('emits event and returns artifactId', async () => {
      const tools = buildTaskLifecycleTools(deps, scope);
      const tool = tools.find((t) => t.name === 'save_artifact')!;

      const result = await tool.handler(
        { name: 'report.txt', content: 'file content', type: 'file' },
        {},
      );

      expect(deps.eventBus.emit).toHaveBeenCalledOnce();
      const emitted = (deps.eventBus.emit as any).mock.calls[0][0];
      expect(emitted.type).toBe('execution:task:progress');
      expect(emitted.payload.artifact.name).toBe('report.txt');
      expect(emitted.payload.taskId).toBe('task-1');

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content[0] as any).text);
      expect(parsed.artifactId).toBeDefined();
    });
  });

  describe('get_task_context', () => {
    it('returns task not found when tree missing', async () => {
      engine.getTree.mockReturnValue(undefined);
      const tools = buildTaskLifecycleTools(deps, scope);
      const tool = tools.find((t) => t.name === 'get_task_context')!;

      const result = await tool.handler({ include: [] }, {});

      expect(result.isError).toBe(true);
    });

    it('returns task details when tree exists', async () => {
      const taskNode = {
        id: 'task-1',
        type: 'agent' as const,
        title: 'Do work',
        prompt: 'Work prompt',
        blockedBy: [],
      };
      const tree: Partial<TaskTree> = {
        id: 'tree-1',
        plan: 'Overall plan',
        tasks: new Map([
          [
            'task-1',
            {
              id: 'task-1',
              parentTaskId: 'tree-1',
              node: taskNode,
              status: 'in_progress',
              artifacts: [],
              retryCount: 0,
            },
          ],
        ]),
      };
      engine.getTree.mockReturnValue(tree);

      const tools = buildTaskLifecycleTools(deps, scope);
      const tool = tools.find((t) => t.name === 'get_task_context')!;

      const result = await tool.handler({ include: [] }, {});

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content[0] as any).text);
      expect(parsed.taskId).toBe('task-1');
      expect(parsed.title).toBe('Do work');
    });
  });
});
