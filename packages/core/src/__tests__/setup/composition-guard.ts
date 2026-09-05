import { vi } from 'vitest';
import type { AppConfig } from '../../config.ts';
import type { RavenOverrides } from '../../raven.ts';
import type * as RavenModule from '../../raven.ts';
import type * as RavenShared from '@raven/shared';
import type * as SdkBackendModule from '../../agent-manager/sdk-backend.ts';

// Identify the real SDK backend even if a composition test explicitly passes
// one. SDK backend unit tests still run their actual code and fake SDK/executable.
// This prevents accidental real-backend wiring; it is not an arbitrary-code sandbox.
vi.mock('../../agent-manager/sdk-backend.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof SdkBackendModule>();
  const { sdkBackends } = await import('./isolated-composition.ts');
  return {
    ...actual,
    createSdkBackend: () => {
      const backend = actual.createSdkBackend();
      sdkBackends.add(backend);
      return backend;
    },
  };
});

// Wrap only the public composition boundary. Validation finishes before logs,
// SQLite, registries, timers or backend initialization can touch owner state.
// This setup file is absent from production and the opt-in Neo4j suite.
vi.mock('../../raven.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof RavenModule>();
  const { assertIsolatedComposition } = await import('./isolated-composition.ts');
  return {
    ...actual,
    createRaven: async (config: AppConfig, overrides: RavenOverrides = {}) => {
      assertIsolatedComposition(config, overrides);
      return actual.createRaven(config, overrides);
    },
  };
});

// Composition tests exercise definition writes and registry reloads, but must
// never stage or commit in the developer's checkout. The shared package tests
// the real Git helper separately at its subprocess boundary. Tests requiring
// real temporary Git history must explicitly opt into that helper.
vi.mock('@raven/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof RavenShared>()),
  gitAutoCommit: vi.fn(async () => {}),
}));
