import { describe, expect, it, vi } from 'vitest';
import {
  ModelCatalog,
  normalizeCatalogEntries,
  type DiscoveredModel,
} from '../agent-registry/model-catalog.ts';

function fixtureModel(): DiscoveredModel {
  return { value: 'sonnet', displayName: 'Sonnet', description: 'Fixture' };
}

describe('ModelCatalog', () => {
  it('starts unavailable and publishes a normalized immutable snapshot', async () => {
    const discover = vi.fn().mockResolvedValue([
      {
        value: 'sonnet',
        resolvedModel: 'claude-sonnet-5',
        displayName: 'Sonnet 5',
        description: 'General model',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'high'],
        supportsAdaptiveThinking: true,
      },
      {
        value: 'claude-fable-5-1',
        displayName: 'Fable 5.1',
        description: 'Mandatory thinking model',
        supportsAdaptiveThinking: true,
      },
    ]);
    const catalog = new ModelCatalog({ discover, now: () => new Date('2026-09-06T10:00:00Z') });

    expect(catalog.getSnapshot()).toMatchObject({ revision: 0, stale: true, models: [] });
    const refreshed = await catalog.refresh();
    expect(refreshed).toMatchObject({
      revision: 1,
      stale: false,
      fetchedAt: '2026-09-06T10:00:00.000Z',
      error: null,
    });
    expect(refreshed.models).toEqual([
      expect.objectContaining({ id: 'claude-fable-5-1', mandatoryThinking: true }),
      expect.objectContaining({
        id: 'claude-sonnet-5',
        aliases: ['sonnet'],
        supportedEffortLevels: ['low', 'high'],
      }),
    ]);
    refreshed.models[0].aliases.push('mutation');
    expect(catalog.getSnapshot().models[0].aliases).not.toContain('mutation');
  });

  it('deduplicates concurrent refreshes', async () => {
    let release = (): void => undefined;
    const held = new Promise<readonly never[]>((resolve) => {
      release = () => resolve([]);
    });
    const discover = vi.fn(() => held);
    const catalog = new ModelCatalog({ discover });
    const first = catalog.refresh();
    const second = catalog.refresh();
    release();
    await Promise.all([first, second]);
    expect(discover).toHaveBeenCalledTimes(1);
  });

  it('retains prior models as stale when a later refresh fails', async () => {
    const discover = vi
      .fn()
      .mockResolvedValueOnce([{ value: 'sonnet', displayName: 'Sonnet', description: 'Fixture' }])
      .mockRejectedValueOnce(new Error('authorization: secret-value'));
    const catalog = new ModelCatalog({ discover });
    await catalog.refresh();
    const failed = await catalog.refresh();

    expect(failed.models).toHaveLength(1);
    expect(failed).toMatchObject({ revision: 2, stale: true });
    expect(failed.error).toContain('authorization=[redacted]');
    expect(failed.error).not.toContain('secret-value');
  });

  it('redacts an entire bearer credential from discovery failures', async () => {
    const catalog = new ModelCatalog({
      discover: vi
        .fn()
        .mockRejectedValue(
          new Error(
            'request failed: Authorization: Bearer oauth-secret-value endpoint unavailable',
          ),
        ),
    });

    const failed = await catalog.refresh();

    expect(failed.error).toContain('request failed: Authorization=[redacted] endpoint unavailable');
    expect(failed.error).not.toContain('Bearer');
    expect(failed.error).not.toContain('oauth-secret-value');
  });

  it('bounds discovery that does not settle and aborts its signal', async () => {
    let observedSignal: AbortSignal | undefined;
    const discover = vi.fn((signal: AbortSignal) => {
      observedSignal = signal;
      return new Promise<readonly never[]>(() => undefined);
    });
    const catalog = new ModelCatalog({ discover, timeoutMs: 10 });
    const result = await catalog.refresh();

    expect(observedSignal?.aborted).toBe(true);
    expect(result).toMatchObject({ stale: true, revision: 1 });
    expect(result.error).toMatch(/timed out/);
  });

  it('marks an otherwise healthy snapshot stale after its cache age', async () => {
    let now = new Date('2026-09-06T10:00:00Z');
    const catalog = new ModelCatalog({
      discover: async () => [{ value: 'sonnet', displayName: 'Sonnet', description: 'Fixture' }],
      staleAfterMs: 100,
      now: () => now,
    });
    await catalog.refresh();
    now = new Date('2026-09-06T10:00:00.101Z');
    expect(catalog.getSnapshot().stale).toBe(true);
  });

  it('stops refresh admission and aborts active discovery boundedly', async () => {
    let signal: AbortSignal | undefined;
    const catalog = new ModelCatalog({
      discover: async (value) => {
        signal = value;
        await new Promise(() => undefined);
        return [];
      },
      timeoutMs: 10,
    });
    const refresh = catalog.refresh();
    await catalog.stop();
    await refresh;

    expect(signal?.aborted).toBe(true);
    await expect(catalog.refresh()).resolves.toMatchObject({
      stale: true,
      error: expect.stringMatching(/stopp/),
    });
  });

  it('cleans up a synchronous discovery failure', async () => {
    let discoverySignal: AbortSignal | undefined;
    const catalog = new ModelCatalog({
      discover: (signal) => {
        discoverySignal = signal;
        throw new Error('synchronous discovery failure');
      },
    });

    const result = await catalog.refresh();

    expect(result).toMatchObject({ stale: true, error: expect.stringContaining('synchronous') });
    expect(discoverySignal?.aborted).toBe(true);
  });

  it('retains the stopped snapshot when abort-ignoring discovery resolves late', async () => {
    let resolveDiscovery: ((models: DiscoveredModel[]) => void) | undefined;
    const catalog = new ModelCatalog({
      discover: () =>
        new Promise<DiscoveredModel[]>((resolve) => {
          resolveDiscovery = resolve;
        }),
      timeoutMs: 100,
    });
    const refresh = catalog.refresh();
    await Promise.resolve();
    const stopped = catalog.stop();
    resolveDiscovery?.([fixtureModel()]);

    await Promise.all([refresh, stopped]);

    expect(catalog.getSnapshot()).toMatchObject({
      models: [],
      stale: true,
      error: 'Model catalog is stopped',
    });
  });
});

describe('catalog normalization', () => {
  it('merges alias and canonical rows without inventing capabilities', () => {
    expect(
      normalizeCatalogEntries([
        { value: 'sonnet', displayName: 'Sonnet', description: 'Alias row' },
        {
          value: 'claude-sonnet-5',
          displayName: 'Sonnet Canonical',
          description: 'Canonical row',
          supportsEffort: true,
          supportedEffortLevels: ['medium'],
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        id: 'claude-sonnet-5',
        aliases: ['sonnet'],
        supportsEffort: true,
        supportedEffortLevels: ['medium'],
      }),
    ]);
  });
});
