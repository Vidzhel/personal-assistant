import { describe, expect, it } from 'vitest';
import type { ModelCatalogEntry, ModelCatalogSnapshot } from '@raven/shared';
import {
  getMandatoryThinkingPolicy,
  normalizeModelId,
  resolveModelConfig,
} from '../agent-registry/model-settings.ts';

function entry(overrides: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry {
  return {
    id: 'claude-sonnet-5',
    aliases: ['sonnet'],
    displayName: 'Sonnet 5',
    description: 'Fixture model',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high'],
    supportsAdaptiveThinking: true,
    ...overrides,
  };
}

function snapshot(models: ModelCatalogEntry[] = [entry()]): ModelCatalogSnapshot {
  return {
    models,
    fetchedAt: '2026-09-06T00:00:00.000Z',
    revision: 7,
    stale: false,
    error: null,
  };
}

describe('model settings resolution', () => {
  it('preserves extended context through selection and mandatory-thinking policy', () => {
    const resolved = resolveModelConfig(
      { session: { model: 'opus[1m]', effort: 'high' }, defaults: { model: 'sonnet' } },
      snapshot([entry({ id: 'claude-opus-5[1m]', aliases: ['opus[1m]'] })]),
    );
    expect(resolved.model).toBe('claude-opus-5[1m]');
    expect(resolved.effort).toBe('high');
    expect(getMandatoryThinkingPolicy('claude-fable-5-1[1m]')).not.toBeNull();
  });

  it('merges fields by turn, session, project, agent, installation precedence', () => {
    const resolved = resolveModelConfig(
      {
        turn: { effort: 'high' },
        session: { thinking: 'adaptive' },
        project: { model: 'sonnet' },
        agent: { model: 'haiku', effort: 'low' },
        defaults: { model: 'opus', thinking: 'disabled' },
      },
      snapshot(),
    );

    expect(resolved).toMatchObject({
      model: 'claude-sonnet-5',
      effort: 'high',
      thinking: 'adaptive',
      catalogRevision: 7,
      source: { model: 'project', effort: 'turn', thinking: 'session' },
    });
    expect(resolved.metadata?.id).toBe('claude-sonnet-5');
  });

  it('normalizes only stable friendly aliases', () => {
    expect(normalizeModelId('haiku')).toBe('claude-haiku-4-5');
    expect(normalizeModelId('sonnet')).toBe('claude-sonnet-5');
    expect(normalizeModelId('opus')).toBe('claude-opus-5');
    expect(normalizeModelId('claude-custom-20260906')).toBe('claude-custom-20260906');
  });

  it('uses the catalog canonical ID when an alias resolves to a newer model', () => {
    const resolved = resolveModelConfig(
      { turn: { model: 'opus' }, defaults: { model: 'sonnet' } },
      snapshot([
        entry({
          id: 'claude-opus-5-1',
          aliases: ['opus'],
          displayName: 'Opus 5.1',
        }),
      ]),
    );

    expect(resolved.model).toBe('claude-opus-5-1');
    expect(resolved.metadata?.id).toBe('claude-opus-5-1');
  });

  it('allows an omitted-control installation default when discovery is unavailable', () => {
    expect(
      resolveModelConfig({ defaults: { model: 'claude-custom-default' } }, snapshot([])),
    ).toMatchObject({ model: 'claude-custom-default', metadata: null });
  });

  it('rejects unreported explicit models when catalog evidence exists', () => {
    expect(() =>
      resolveModelConfig(
        { turn: { model: 'claude-missing' }, defaults: { model: 'sonnet' } },
        snapshot(),
      ),
    ).toThrow(/not present in catalog revision 7/);
  });

  it('requires matching capability metadata for explicit effort and thinking', () => {
    expect(() =>
      resolveModelConfig({ turn: { effort: 'max' }, defaults: { model: 'sonnet' } }, snapshot()),
    ).toThrow(/does not support effort "max"/);
    expect(() =>
      resolveModelConfig(
        { turn: { thinking: 'adaptive' }, defaults: { model: 'sonnet' } },
        snapshot([entry({ supportsAdaptiveThinking: false })]),
      ),
    ).toThrow(/does not support adaptive thinking/);
    expect(() =>
      resolveModelConfig(
        { turn: { thinking: 'disabled' }, defaults: { model: 'sonnet' } },
        snapshot([]),
      ),
    ).toThrow(/Cannot validate disabled thinking/);
  });

  it('enforces the documented Fable adaptive-thinking policy', () => {
    const fable = entry({
      id: 'claude-fable-5-1',
      aliases: [],
      displayName: 'Fable 5.1',
      mandatoryThinking: true,
    });
    expect(() =>
      resolveModelConfig(
        { turn: { model: fable.id, thinking: 'disabled' }, defaults: { model: 'sonnet' } },
        snapshot([fable]),
      ),
    ).toThrow(/requires adaptive thinking/);
    const resolved = resolveModelConfig({ defaults: { model: fable.id } }, snapshot([]));
    expect(resolved.thinking).toBe('adaptive');
    expect(resolved.mandatoryThinkingPolicy).toEqual(getMandatoryThinkingPolicy(fable.id));
  });
});
