import { describe, it, expect } from 'vitest';
import { AgentYamlSchema } from '../project/schemas.ts';

describe('AgentYamlSchema memory budget', () => {
  it('defaults memory budget when omitted', () => {
    const parsed = AgentYamlSchema.parse({
      name: 'mem-agent',
      displayName: 'Mem Agent',
      description: 'has memory',
    });
    expect(parsed.memory).toEqual({ maxFiles: 30, maxTotalKb: 64 });
  });

  it('accepts an explicit memory budget', () => {
    const parsed = AgentYamlSchema.parse({
      name: 'mem-agent',
      displayName: 'Mem Agent',
      description: 'has memory',
      memory: { maxFiles: 10, maxTotalKb: 16 },
    });
    expect(parsed.memory).toEqual({ maxFiles: 10, maxTotalKb: 16 });
  });

  it('fills partial memory budget with defaults', () => {
    const parsed = AgentYamlSchema.parse({
      name: 'mem-agent',
      displayName: 'Mem Agent',
      description: 'has memory',
      memory: { maxFiles: 5 },
    });
    expect(parsed.memory).toEqual({ maxFiles: 5, maxTotalKb: 64 });
  });

  it('rejects a non-positive maxFiles', () => {
    expect(() =>
      AgentYamlSchema.parse({
        name: 'mem-agent',
        displayName: 'Mem Agent',
        description: 'x',
        memory: { maxFiles: 0 },
      }),
    ).toThrow();
  });
});
