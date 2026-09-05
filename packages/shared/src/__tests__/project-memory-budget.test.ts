import { describe, expect, it } from 'vitest';
import { ProjectWorkspaceSchema, WorkspaceUpdateSchema } from '../types/projects.ts';
import { AgentYamlSchema } from '../project/schemas.ts';

describe('project memory budget configuration', () => {
  it('stores budgets only in project workspaces', () => {
    expect(
      ProjectWorkspaceSchema.parse({ version: 1, memory: { maxFiles: 10, maxTotalKb: 16 } }).memory,
    ).toEqual({ maxFiles: 10, maxTotalKb: 16 });
    expect(AgentYamlSchema.parse({ name: 'raven', displayName: 'Raven' })).not.toHaveProperty(
      'memory',
    );
  });

  it('permits partial updates while rejecting invalid limits', () => {
    expect(WorkspaceUpdateSchema.parse({ memory: { maxFiles: 5 } }).memory).toEqual({
      maxFiles: 5,
    });
    for (const value of [0, -1, 1.5, Infinity]) {
      expect(WorkspaceUpdateSchema.safeParse({ memory: { maxFiles: value } }).success).toBe(false);
      expect(WorkspaceUpdateSchema.safeParse({ memory: { maxTotalKb: value } }).success).toBe(
        false,
      );
    }
  });
});
