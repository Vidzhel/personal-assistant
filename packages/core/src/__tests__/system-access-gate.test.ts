import { describe, it, expect } from 'vitest';
import {
  resolveSystemAccessInstructions,
  resolveToolUseInstructions,
} from '../project-manager/system-access-gate.ts';
import type { Project } from '@raven/shared';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'test',
    name: 'Test',
    skills: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('system-access-gate', () => {
  describe('resolveSystemAccessInstructions', () => {
    it('returns block instructions for system_access=none', () => {
      const result = resolveSystemAccessInstructions(makeProject({ systemAccess: 'none' }));
      expect(result).toContain('MUST NOT read or modify');
      expect(result).toContain('Raven System project');
    });

    it('returns read-only instructions for system_access=read', () => {
      const result = resolveSystemAccessInstructions(makeProject({ systemAccess: 'read' }));
      expect(result).toContain('may READ system files');
      expect(result).toContain('MUST NOT modify');
    });

    it('returns full access instructions for system_access=read-write', () => {
      const result = resolveSystemAccessInstructions(makeProject({ systemAccess: 'read-write' }));
      expect(result).toContain('may read and modify system files');
      expect(result).toContain('Red tier');
    });

    it('defaults to none when systemAccess is undefined', () => {
      const result = resolveSystemAccessInstructions(makeProject());
      expect(result).toContain('MUST NOT read or modify');
    });
  });

  describe('resolveToolUseInstructions', () => {
    it('returns purposeful tool use instruction', () => {
      const result = resolveToolUseInstructions();
      expect(result).toContain('Use tools purposefully');
      expect(result).toContain('Do not speculatively explore');
    });
  });
});
