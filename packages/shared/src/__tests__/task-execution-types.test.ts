import { describe, it, expect } from 'vitest';
import {
  TaskArtifactSchema,
  TaskValidationConfigSchema,
  TaskTreeNodeSchema,
} from '../types/task-execution.ts';

describe('TaskArtifactSchema', () => {
  it('validates a file artifact', () => {
    const result = TaskArtifactSchema.parse({
      type: 'file',
      label: 'output.csv',
      filePath: '/tmp/output.csv',
    });
    expect(result.type).toBe('file');
    expect(result.filePath).toBe('/tmp/output.csv');
  });

  it('validates a data artifact', () => {
    const result = TaskArtifactSchema.parse({
      type: 'data',
      label: 'metrics',
      data: { count: 42, tags: ['a', 'b'] },
    });
    expect(result.type).toBe('data');
    expect(result.data).toEqual({ count: 42, tags: ['a', 'b'] });
  });

  it('validates a reference artifact', () => {
    const result = TaskArtifactSchema.parse({
      type: 'reference',
      label: 'parent-task',
      referenceId: 'task-abc-123',
    });
    expect(result.type).toBe('reference');
    expect(result.referenceId).toBe('task-abc-123');
  });

  it('rejects empty label', () => {
    expect(() => TaskArtifactSchema.parse({ type: 'file', label: '' })).toThrow();
  });
});

describe('TaskValidationConfigSchema', () => {
  it('applies all defaults', () => {
    const result = TaskValidationConfigSchema.parse({});
    expect(result.requireArtifacts).toBe(true);
    expect(result.evaluator).toBe(true);
    expect(result.evaluatorModel).toBe('haiku');
    expect(result.qualityReview).toBe(false);
    expect(result.qualityModel).toBe('sonnet');
    expect(result.qualityThreshold).toBe(3);
    expect(result.maxRetries).toBe(2);
    expect(result.retryBackoffMs).toBe(1000);
    expect(result.onMaxRetriesFailed).toBe('escalate');
  });

  it('accepts custom values', () => {
    const result = TaskValidationConfigSchema.parse({
      requireArtifacts: false,
      evaluator: false,
      evaluatorModel: 'sonnet',
      qualityReview: true,
      qualityModel: 'opus',
      qualityThreshold: 5,
      maxRetries: 0,
      retryBackoffMs: 5000,
      onMaxRetriesFailed: 'fail',
    });
    expect(result.qualityThreshold).toBe(5);
    expect(result.maxRetries).toBe(0);
    expect(result.onMaxRetriesFailed).toBe('fail');
  });

  it('rejects qualityThreshold out of range', () => {
    expect(() => TaskValidationConfigSchema.parse({ qualityThreshold: 0 })).toThrow();
    expect(() => TaskValidationConfigSchema.parse({ qualityThreshold: 6 })).toThrow();
  });
});

describe('TaskTreeNodeSchema', () => {
  it('validates an agent node', () => {
    const result = TaskTreeNodeSchema.parse({
      type: 'agent',
      id: 'step-1',
      title: 'Research',
      prompt: 'Find relevant papers',
    });
    expect(result.type).toBe('agent');
    expect(result.blockedBy).toEqual([]);
  });

  it('validates a code node', () => {
    const result = TaskTreeNodeSchema.parse({
      type: 'code',
      id: 'step-2',
      title: 'Run script',
      script: './scripts/process.sh',
      blockedBy: ['step-1'],
    });
    expect(result.type).toBe('code');
    if (result.type === 'code') {
      expect(result.args).toEqual([]);
    }
    expect(result.blockedBy).toEqual(['step-1']);
  });

  it('validates a condition node', () => {
    const result = TaskTreeNodeSchema.parse({
      type: 'condition',
      id: 'check-1',
      title: 'Check output',
      expression: 'artifacts.length > 0',
    });
    expect(result.type).toBe('condition');
  });

  it('validates a notify node', () => {
    const result = TaskTreeNodeSchema.parse({
      type: 'notify',
      id: 'notify-1',
      title: 'Send alert',
      channel: 'telegram',
      message: 'Task done',
    });
    expect(result.type).toBe('notify');
    if (result.type === 'notify') {
      expect(result.attachments).toEqual([]);
    }
  });

  it('validates a delay node', () => {
    const result = TaskTreeNodeSchema.parse({
      type: 'delay',
      id: 'wait-1',
      title: 'Wait',
      duration: '5m',
    });
    expect(result.type).toBe('delay');
  });

  it('validates an approval node', () => {
    const result = TaskTreeNodeSchema.parse({
      type: 'approval',
      id: 'approve-1',
      title: 'Get sign-off',
      message: 'Please review the output',
    });
    expect(result.type).toBe('approval');
  });

  it('rejects an invalid node type', () => {
    expect(() =>
      TaskTreeNodeSchema.parse({
        type: 'unknown',
        id: 'bad',
        title: 'Bad node',
      }),
    ).toThrow();
  });

  it('accepts optional runIf and validation', () => {
    const result = TaskTreeNodeSchema.parse({
      type: 'agent',
      id: 'step-x',
      title: 'Conditional step',
      prompt: 'Do something',
      runIf: 'check-1.passed',
      validation: { requireArtifacts: false, evaluator: false },
    });
    expect(result.runIf).toBe('check-1.passed');
    expect(result.validation?.requireArtifacts).toBe(false);
  });
});
