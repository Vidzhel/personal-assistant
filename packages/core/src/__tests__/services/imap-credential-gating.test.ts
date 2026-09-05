import { afterEach, describe, expect, it, vi } from 'vitest';
import { SERVICE_DEFINITIONS } from '../../services/registry.ts';
import { createServiceRunner } from '../../services/runner.ts';
import { createJobRegistry } from '../../scheduler/job-registry.ts';
import type { ServiceContext } from '../../services/types.ts';

const context: ServiceContext = {
  eventBus: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  db: { run: vi.fn(), get: vi.fn(), all: vi.fn() },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  config: {},
  projectRoot: '/unused-fixture',
  integrationsConfig: { ynab: { planId: '' }, accounts: [] },
  jobRegistry: createJobRegistry(),
};
afterEach(() => vi.unstubAllEnvs());

describe('IMAP credential gating', () => {
  it.each([true, false])(
    'requires IMAP credentials, independently of OAuth (IMAP configured: %s)',
    async (imapConfigured) => {
      for (const name of ['GMAIL_IMAP_USER', 'GMAIL_IMAP_PASSWORD'])
        vi.stubEnv(name, imapConfigured ? 'fake-imap' : '');
      for (const name of ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'])
        vi.stubEnv(name, imapConfigured ? '' : 'fake-oauth');
      const definition = SERVICE_DEFINITIONS.find((item) => item.name === 'imap-watcher')!;
      const start = vi.fn();
      const stop = vi.fn();
      const runner = createServiceRunner();
      // Exercise the production registry gate with an inert service implementation.
      await runner.startServices([{ ...definition, start, stop }], context);
      expect(start).toHaveBeenCalledTimes(imapConfigured ? 1 : 0);
      expect(runner.getRunningCount()).toBe(imapConfigured ? 1 : 0);
      await runner.stopAll();
    },
  );
});
