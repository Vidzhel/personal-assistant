import { describe, expect, it } from 'vitest';
import type { ModelCatalogSnapshot, SubAgentDefinition } from '@raven/shared';
import { captureNestedModelSettings } from '../agent-registry/conversation-models.ts';

const catalog: ModelCatalogSnapshot = {
  revision: 1,
  fetchedAt: '2026-09-06T00:00:00Z',
  stale: false,
  error: null,
  models: [
    {
      id: 'claude-sonnet-5',
      aliases: ['sonnet'],
      displayName: 'Sonnet',
      description: '',
      supportsEffort: true,
      supportedEffortLevels: ['high'],
    },
    {
      id: 'claude-haiku-4-5',
      aliases: ['haiku'],
      displayName: 'Haiku',
      description: '',
      supportsEffort: true,
      supportedEffortLevels: ['low'],
    },
  ],
};
const worker: SubAgentDefinition = {
  description: 'Worker',
  prompt: 'Keep project context',
  tools: ['Read'],
};

describe('nested model capture', () => {
  it('inherits effort only for workers inheriting the parent model, preserving scope', () => {
    const definitions = {
      inherited: worker,
      cheap: { ...worker, model: 'haiku' },
      explicit: { ...worker, model: 'haiku', effort: 'low' as const },
    };
    const result = captureNestedModelSettings(
      definitions,
      { model: 'claude-sonnet-5', effort: 'high' },
      catalog,
    );
    expect(result.inherited).toEqual({ ...worker, model: 'claude-sonnet-5', effort: 'high' });
    expect(result.cheap).toEqual({ ...worker, model: 'claude-haiku-4-5', effort: undefined });
    expect(result.explicit).toEqual({ ...worker, model: 'claude-haiku-4-5', effort: 'low' });
    expect(definitions.cheap.model).toBe('haiku');
  });

  it('rejects a worker effort unsupported by its own model', () => {
    expect(() =>
      captureNestedModelSettings(
        { bad: { ...worker, model: 'haiku', effort: 'high' } },
        { model: 'claude-sonnet-5' },
        catalog,
      ),
    ).toThrow(/does not support effort/);
  });
});
