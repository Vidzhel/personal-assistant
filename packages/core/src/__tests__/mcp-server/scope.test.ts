import { describe, it, expect } from 'vitest';
import { parseScopeContext, isToolAllowed, type ScopeContext } from '../../mcp-server/scope.ts';

describe('scope', () => {
  describe('parseScopeContext', () => {
    it('parses valid task scope', () => {
      const scope = parseScopeContext({
        role: 'task',
        projectId: 'proj-1',
        sessionId: 'sess-1',
        treeId: 'tree-1',
        taskId: 'task-1',
      });
      expect(scope.role).toBe('task');
      expect(scope.taskId).toBe('task-1');
    });

    it('rejects invalid role', () => {
      expect(() => parseScopeContext({ role: 'admin' })).toThrow();
    });

    it('allows optional fields', () => {
      const scope = parseScopeContext({ role: 'chat' });
      expect(scope.role).toBe('chat');
      expect(scope.taskId).toBeUndefined();
    });
  });

  describe('isToolAllowed', () => {
    it('allows complete_task for task scope', () => {
      const scope: ScopeContext = { role: 'task', taskId: 'task-1', treeId: 'tree-1' };
      expect(isToolAllowed(scope, 'complete_task')).toBe(true);
    });

    it('denies create_task_tree for task scope', () => {
      const scope: ScopeContext = { role: 'task', taskId: 'task-1', treeId: 'tree-1' };
      expect(isToolAllowed(scope, 'create_task_tree')).toBe(false);
    });

    it('allows all tools for system scope', () => {
      const scope: ScopeContext = { role: 'system' };
      expect(isToolAllowed(scope, 'complete_task')).toBe(true);
      expect(isToolAllowed(scope, 'create_task_tree')).toBe(true);
      expect(isToolAllowed(scope, 'list_agents')).toBe(true);
    });

    it('allows classify_request for chat scope', () => {
      const scope: ScopeContext = { role: 'chat', sessionId: 'sess-1' };
      expect(isToolAllowed(scope, 'classify_request')).toBe(true);
    });

    it('allows submit_validation_score for validation scope', () => {
      const scope: ScopeContext = { role: 'validation' };
      expect(isToolAllowed(scope, 'submit_validation_score')).toBe(true);
    });

    it('denies send_message for validation scope', () => {
      const scope: ScopeContext = { role: 'validation' };
      expect(isToolAllowed(scope, 'send_message')).toBe(false);
    });

    it('allows knowledge tools for knowledge scope', () => {
      const scope: ScopeContext = { role: 'knowledge' };
      expect(isToolAllowed(scope, 'search_knowledge')).toBe(true);
      expect(isToolAllowed(scope, 'save_knowledge')).toBe(true);
      expect(isToolAllowed(scope, 'get_knowledge_context')).toBe(true);
    });

    it('denies create_agent for knowledge scope', () => {
      const scope: ScopeContext = { role: 'knowledge' };
      expect(isToolAllowed(scope, 'create_agent')).toBe(false);
    });
  });
});
