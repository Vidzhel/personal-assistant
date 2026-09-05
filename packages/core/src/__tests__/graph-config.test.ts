import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.ts';

describe('graph configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  it('preserves enabled behavior for existing installations', () => {
    vi.stubEnv('NEO4J_ENABLED', undefined);
    expect(loadConfig().NEO4J_ENABLED).toBe(true);
  });
  it.each(['true', 'false'])('parses explicit %s without truthy string coercion', (value) => {
    vi.stubEnv('NEO4J_ENABLED', value);
    expect(loadConfig().NEO4J_ENABLED).toBe(value === 'true');
  });
});
