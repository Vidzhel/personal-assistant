import { describe, expect, it } from 'vitest';
import { parseTickTickMutationEvidence } from '../../../services/task-management/ticktick-action-result.ts';

const VERIFIED = JSON.stringify({
  operation: 'update-task',
  outcome: 'verified',
  taskId: 't1',
  projectId: 'p1',
});

describe('parseTickTickMutationEvidence', () => {
  it('accepts exact verified evidence for the expected operation and identity', () => {
    expect(
      parseTickTickMutationEvidence(VERIFIED, {
        operation: 'update-task',
        taskId: 't1',
        projectId: 'p1',
      }),
    ).toMatchObject({ outcome: 'verified', taskId: 't1' });
  });

  it.each([
    undefined,
    'done',
    `Model says: ${VERIFIED}`,
    JSON.stringify({ ...JSON.parse(VERIFIED), taskId: 'other' }),
    JSON.stringify({ ...JSON.parse(VERIFIED), operation: 'complete-task' }),
    JSON.stringify({ ...JSON.parse(VERIFIED), details: 'x'.repeat(70_000) }),
  ])('rejects absent, prose, mismatched, or wrong-operation evidence', (result) => {
    expect(
      parseTickTickMutationEvidence(result, {
        operation: 'update-task',
        taskId: 't1',
        projectId: 'p1',
      }),
    ).toBeNull();
  });
});
