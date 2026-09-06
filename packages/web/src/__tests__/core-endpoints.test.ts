import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('browser core endpoints', () => {
  it('uses relative same-origin endpoints when no build-time endpoints are configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_CORE_API_URL', '');
    vi.stubEnv('NEXT_PUBLIC_CORE_WS_URL', '');
    const endpoints = await import('@/lib/core-endpoints');
    expect(endpoints.CORE_API_URL).toBe('/api');
    expect(endpoints.CORE_WS_URL).toBe('/ws');
  });

  it('derives a secure websocket endpoint from the current browser origin', async () => {
    vi.stubEnv('NEXT_PUBLIC_CORE_API_URL', '');
    vi.stubEnv('NEXT_PUBLIC_CORE_WS_URL', '');
    vi.stubGlobal('window', {
      location: { protocol: 'https:', host: 'raven.private.example' },
    });

    const endpoints = await import('@/lib/core-endpoints');

    expect(endpoints.CORE_API_URL).toBe('/api');
    expect(endpoints.CORE_WS_URL).toBe('wss://raven.private.example/ws');
  });

  it('preserves localhost core defaults for Next development without endpoint overrides', async () => {
    vi.stubEnv('NODE_ENV', 'development');
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
