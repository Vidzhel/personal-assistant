import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLogger, IntegrationsConfigSchema } from '@raven/shared';
import type { IntegrationsConfig } from '@raven/shared';

const log = createLogger('integrations-config');

let cachedConfig: IntegrationsConfig | null = null;

export function loadIntegrationsConfig(configDir: string): IntegrationsConfig {
  const path = resolve(configDir, 'integrations.json');

  if (!existsSync(path)) {
    log.info('No config/integrations.json found — using empty defaults');
    cachedConfig = IntegrationsConfigSchema.parse({});
    return cachedConfig;
  }

  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  const result = IntegrationsConfigSchema.safeParse(parsed);

  if (!result.success) {
    log.error(`Invalid integrations.json: ${result.error.message}`);
    cachedConfig = IntegrationsConfigSchema.parse({});
    return cachedConfig;
  }

  const enabledCount = result.data.accounts.filter((a) => a.enabled).length;
  log.info(`Integrations config loaded: ${enabledCount} enabled account(s)`);
  cachedConfig = result.data;
  return cachedConfig;
}

export function getIntegrationsConfig(): IntegrationsConfig {
  if (!cachedConfig)
    throw new Error('Integrations config not loaded. Call loadIntegrationsConfig() first.');
  return cachedConfig;
}

export function reloadIntegrationsConfig(configDir: string): IntegrationsConfig {
  return loadIntegrationsConfig(configDir);
}
