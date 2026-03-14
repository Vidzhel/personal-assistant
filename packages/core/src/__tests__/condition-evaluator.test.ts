import { describe, it, expect } from 'vitest';
import { evaluateCondition } from '../pipeline-engine/condition-evaluator.ts';

describe('evaluateCondition', () => {
  const outputs: Record<string, unknown> = {
    'fetch-emails': { output: { urgentCount: 3, subjects: ['a', 'b'] } },
    'check-data': { output: { count: 0, empty: true, name: 'test' } },
    'simple-node': 'hello',
  };

  it('evaluates truthiness of a resolved path', () => {
    expect(evaluateCondition('{{ fetch-emails.output.urgentCount }}', outputs)).toBe(true);
  });

  it('evaluates falsy value (0) as false', () => {
    expect(evaluateCondition('{{ check-data.output.count }}', outputs)).toBe(false);
  });

  it('evaluates > comparison', () => {
    expect(evaluateCondition('{{ fetch-emails.output.urgentCount > 0 }}', outputs)).toBe(true);
    expect(evaluateCondition('{{ check-data.output.count > 0 }}', outputs)).toBe(false);
  });

  it('evaluates < comparison', () => {
    expect(evaluateCondition('{{ fetch-emails.output.urgentCount < 10 }}', outputs)).toBe(true);
  });

  it('evaluates >= comparison', () => {
    expect(evaluateCondition('{{ fetch-emails.output.urgentCount >= 3 }}', outputs)).toBe(true);
    expect(evaluateCondition('{{ fetch-emails.output.urgentCount >= 4 }}', outputs)).toBe(false);
  });

  it('evaluates <= comparison', () => {
    expect(evaluateCondition('{{ check-data.output.count <= 0 }}', outputs)).toBe(true);
  });

  it('evaluates == comparison', () => {
    expect(evaluateCondition("{{ check-data.output.name == 'test' }}", outputs)).toBe(true);
    expect(evaluateCondition("{{ check-data.output.name == 'other' }}", outputs)).toBe(false);
  });

  it('evaluates != comparison', () => {
    expect(evaluateCondition("{{ check-data.output.name != 'other' }}", outputs)).toBe(true);
  });

  it('handles nested field access', () => {
    expect(evaluateCondition('{{ fetch-emails.output.subjects }}', outputs)).toBe(true);
  });

  it('returns false for missing node output', () => {
    expect(evaluateCondition('{{ nonexistent.output.field }}', outputs)).toBe(false);
  });

  it('returns false for missing nested field', () => {
    expect(evaluateCondition('{{ fetch-emails.output.noSuchField > 0 }}', outputs)).toBe(false);
  });

  it('returns false for malformed expression', () => {
    expect(evaluateCondition('', outputs)).toBe(false);
    expect(evaluateCondition('{{ }}', outputs)).toBe(false);
  });

  it('handles simple string value node', () => {
    expect(evaluateCondition('{{ simple-node }}', outputs)).toBe(true);
  });

  it('evaluates boolean literal comparisons', () => {
    expect(evaluateCondition('{{ check-data.output.empty == true }}', outputs)).toBe(true);
  });
});
