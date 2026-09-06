import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelCatalogEntry } from '@raven/shared';
import {
  draftFromModelConfig,
  modelForCapabilityLookup,
  modelConfigError,
  modelConfigFromDraft,
  selectedCatalogModel,
} from '@/lib/model-config';
import { updateWorkspace } from '@/lib/workspace-api';

const catalogModel: ModelCatalogEntry = {
  id: 'claude-example-1',
  aliases: ['example'],
  displayName: 'Example',
  description: 'Fixture model',
  supportsEffort: true,
  supportedEffortLevels: ['low', 'high'],
  supportsAdaptiveThinking: false,
};

afterEach(() => vi.unstubAllGlobals());

describe('model configuration controls', () => {
  it('keeps partial overrides atomic and represents a fully inherited value as null', () => {
    expect(
      modelConfigFromDraft({ model: 'example', effort: 'high', thinking: 'disabled' }),
    ).toEqual({ model: 'example', effort: 'high', thinking: 'disabled' });
    expect(modelConfigFromDraft({ model: '', effort: '', thinking: '' })).toBeNull();
    expect(draftFromModelConfig({ effort: 'xhigh' })).toEqual({
      model: '',
      effort: 'xhigh',
      thinking: '',
    });
    expect(
      modelForCapabilityLookup(
        { model: '', effort: 'xhigh', thinking: '' },
        { model: 'claude-sonnet-5', effort: 'high' },
      ),
    ).toBe('claude-sonnet-5');
    expect(
      modelForCapabilityLookup(
        { model: 'haiku', effort: '', thinking: '' },
        { model: 'claude-sonnet-5' },
      ),
    ).toBe('haiku');
  });

  it('uses aliases for capability checks and rejects only reported unsupported choices', () => {
    expect(selectedCatalogModel([catalogModel], 'example')).toBe(catalogModel);
    expect(
      modelConfigError({ model: 'example', effort: 'medium', thinking: '' }, catalogModel),
    ).toBe('Example does not support medium effort.');
    expect(
      modelConfigError({ model: 'example', effort: 'high', thinking: 'adaptive' }, catalogModel),
    ).toBe('Example does not support adaptive thinking.');
    expect(
      modelConfigError({ model: 'unknown', effort: 'high', thinking: 'adaptive' }, undefined),
    ).toBeUndefined();
    expect(
      modelConfigError(
        { model: 'fable', effort: '', thinking: 'disabled' },
        { ...catalogModel, displayName: 'Fable', mandatoryThinking: true },
      ),
    ).toBe('Fable requires thinking and cannot turn it off.');
    expect(
      modelConfigError(
        { model: 'unknown-capabilities', effort: 'low', thinking: '' },
        {
          ...catalogModel,
          displayName: 'Unknown capabilities',
          supportsEffort: undefined,
          supportedEffortLevels: undefined,
        },
      ),
    ).toBe('Unknown capabilities does not support effort controls.');
  });

  it('sends project defaults under execution and uses null to clear the override', async () => {
    const workspace = { version: 1, execution: { mode: 'default' }, sources: [] };
    const fetcher = vi.fn().mockImplementation(async () => Response.json(workspace));
    vi.stubGlobal('fetch', fetcher);

    await updateWorkspace('parent/child', {
      execution: { modelConfig: { model: 'example', effort: 'low' } },
    });
    await updateWorkspace('parent/child', { execution: { modelConfig: null } });

    expect(fetcher.mock.calls[0][0]).toContain('/projects/parent%2Fchild/workspace');
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      execution: { modelConfig: { model: 'example', effort: 'low' } },
    });
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
      execution: { modelConfig: null },
    });
  });
});
