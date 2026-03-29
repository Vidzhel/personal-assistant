import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildValidationTools } from '../../../mcp-server/tools/validation.ts';
import type { RavenMcpDeps } from '../../../mcp-server/types.ts';
import type { ScopeContext } from '../../../mcp-server/scope.ts';

describe('buildValidationTools', () => {
  let deps: RavenMcpDeps;
  let scope: ScopeContext;

  beforeEach(() => {
    deps = {
      eventBus: { emit: vi.fn() },
    } as unknown as RavenMcpDeps;
    scope = { role: 'validation', treeId: 'tree-abc', taskId: 'task-xyz' };
  });

  describe('submit_validation_score', () => {
    it('emits execution:task:validation event with score, feedback, and pass', async () => {
      const tools = buildValidationTools(deps, scope);
      const submitTool = tools.find((t) => t.name === 'submit_validation_score');
      expect(submitTool).toBeDefined();

      const result = await submitTool!.handler(
        { score: 4, feedback: 'Good work overall', pass: true },
        {},
      );

      expect(deps.eventBus.emit).toHaveBeenCalledOnce();
      const emittedEvent = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(emittedEvent.type).toBe('execution:task:validation');
      expect(emittedEvent.source).toBe('mcp-server');
      expect(emittedEvent.payload.treeId).toBe('tree-abc');
      expect(emittedEvent.payload.taskId).toBe('task-xyz');
      expect(emittedEvent.payload.score).toBe(4);
      expect(emittedEvent.payload.feedback).toBe('Good work overall');
      expect(emittedEvent.payload.pass).toBe(true);

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content[0] as any).text);
      expect(parsed.ack).toBe(true);
    });

    it('emits event with pass: false when task fails validation', async () => {
      const tools = buildValidationTools(deps, scope);
      const submitTool = tools.find((t) => t.name === 'submit_validation_score');

      await submitTool!.handler(
        { score: 2, feedback: 'Missing key requirements', pass: false },
        {},
      );

      const emittedEvent = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(emittedEvent.payload.score).toBe(2);
      expect(emittedEvent.payload.pass).toBe(false);
      expect(emittedEvent.payload.feedback).toBe('Missing key requirements');
    });

    it('includes generated id and timestamp on emitted event', async () => {
      const tools = buildValidationTools(deps, scope);
      const submitTool = tools.find((t) => t.name === 'submit_validation_score');

      const before = Date.now();
      await submitTool!.handler({ score: 3, feedback: 'Average', pass: true }, {});
      const after = Date.now();

      const emittedEvent = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(typeof emittedEvent.id).toBe('string');
      expect(emittedEvent.id.length).toBeGreaterThan(0);
      expect(emittedEvent.timestamp).toBeGreaterThanOrEqual(before);
      expect(emittedEvent.timestamp).toBeLessThanOrEqual(after);
    });

    it('falls back to empty string for treeId and taskId when missing from scope', async () => {
      const minimalScope: ScopeContext = { role: 'validation' };
      const tools = buildValidationTools(deps, minimalScope);
      const submitTool = tools.find((t) => t.name === 'submit_validation_score');

      await submitTool!.handler({ score: 5, feedback: 'Perfect', pass: true }, {});

      const emittedEvent = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(emittedEvent.payload.treeId).toBe('');
      expect(emittedEvent.payload.taskId).toBe('');
    });
  });
});
