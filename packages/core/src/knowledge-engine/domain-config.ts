import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLogger, KnowledgeDomainConfigSchema, type KnowledgeDomain } from '@raven/shared';

const log = createLogger('domain-config');

export function loadKnowledgeDomainConfig(configDir: string): KnowledgeDomain[] {
  const path = resolve(configDir, 'knowledge-domains.json');
  if (!existsSync(path)) {
    log.warn(`Knowledge domains config not found: ${path}`);
    return [];
  }
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw);
  const result = KnowledgeDomainConfigSchema.safeParse(parsed);
  if (!result.success) {
    log.error(`Invalid knowledge domains config: ${result.error.message}`);
    return [];
  }
  log.info(`Loaded ${result.data.length} knowledge domains`);
  return result.data;
}
