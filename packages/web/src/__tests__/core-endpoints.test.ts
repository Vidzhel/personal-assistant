import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('browser core endpoints', () => {
  it('uses the documented local API and websocket defaults', async () => {
    vi.stubEnv('NEXT_PUBLIC_CORE_API_URL', '');
    vi.stubEnv('NEXT_PUBLIC_CORE_WS_URL', '');
    const endpoints = await import('@/lib/core-endpoints');
    expect(endpoints.CORE_API_URL).toBe('http://localhost:4001/api');
    expect(endpoints.CORE_WS_URL).toBe('ws://localhost:4001/ws');
  });

  it('keeps a remote TLS host and path consistently across transports', async () => {
    vi.stubEnv('NEXT_PUBLIC_CORE_API_URL', 'https://raven.example/core/api/');
    vi.stubEnv('NEXT_PUBLIC_CORE_WS_URL', 'wss://raven.example/core/ws');
    const endpoints = await import('@/lib/core-endpoints');
    expect(`${endpoints.CORE_API_URL}/health`).toBe('https://raven.example/core/api/health');
    expect(endpoints.CORE_WS_URL).toBe('wss://raven.example/core/ws');
  });
});
