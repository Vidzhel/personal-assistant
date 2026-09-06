import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configuredBrowserOrigins,
  parseBrowserOrigin,
  registerBrowserOriginPolicy,
} from '../api/browser-origin.ts';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function server() {
  app = Fastify();
  registerBrowserOriginPolicy(app, ['https://raven.example.test']);
  await app.register(cors, { origin: ['https://raven.example.test'] });
  await app.register(websocket);
  const mutation = vi.fn(() => ({ ok: true }));
  app.post('/api/mutate', mutation);
  app.get('/ws', { websocket: true }, (socket) => socket.send('connected'));
  return { app, mutation };
}

describe('exact browser-origin boundary', () => {
  it.each([
    'null',
    'file:///tmp/a',
    'https://user:pass@raven.test',
    'https://raven.test/path',
    'https://raven.test?x=1',
    'https://raven.test#x',
    ' https://raven.test',
  ])('rejects non-origin configuration %s', (value) => {
    expect(() => parseBrowserOrigin(value)).toThrow();
  });

  it('uses only configured origins remotely and explicit local defaults otherwise', () => {
    expect(
      configuredBrowserOrigins({
        RAVEN_BASE_URL: 'https://raven.test/',
        RAVEN_BROWSER_ORIGINS: 'http://127.0.0.1:4420',
      }),
    ).toEqual(['https://raven.test', 'http://127.0.0.1:4420']);
    expect(configuredBrowserOrigins({})).toContain('http://localhost:4000');
    expect(() =>
      configuredBrowserOrigins({ RAVEN_BROWSER_ORIGINS: 'https://raven.test,' }),
    ).toThrow();
  });

  it('rejects disallowed origins before mutation, including spoofed forwarded host and preflight', async () => {
    const { app, mutation } = await server();
    for (const origin of ['null', 'https://evil.test', 'https://raven.example.test.evil.test']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/mutate',
        headers: { origin, host: 'raven.example.test', 'x-forwarded-host': 'raven.example.test' },
      });
      expect(response.statusCode).toBe(403);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    }
    expect(
      (
        await app.inject({
          method: 'OPTIONS',
          url: '/api/mutate',
          headers: { origin: 'https://evil.test', 'access-control-request-method': 'POST' },
        })
      ).statusCode,
    ).toBe(403);
    expect(mutation).not.toHaveBeenCalled();
    const allowed = await app.inject({
      method: 'POST',
      url: '/api/mutate',
      headers: { origin: 'https://raven.example.test' },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers['access-control-allow-origin']).toBe('https://raven.example.test');
    expect((await app.inject({ method: 'POST', url: '/api/mutate' })).statusCode).toBe(200);
    expect(mutation).toHaveBeenCalledTimes(2);
  });

  it('applies the same boundary before WebSocket upgrade', async () => {
    const { app } = await server();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('No test address');
    const url = `ws://127.0.0.1:${String(address.port)}/ws`;
    const denied = new WebSocket(url, { origin: 'https://evil.test' });
    const status = await new Promise<number>((resolve, reject) => {
      denied.once('unexpected-response', (request, response) => {
        request.destroy();
        response.resume();
        resolve(response.statusCode ?? 0);
        denied.terminate();
      });
      denied.once('error', reject);
    });
    expect(status).toBe(403);
    for (const origin of ['https://raven.example.test', undefined]) {
      const socket = new WebSocket(url, origin ? { origin } : {});
      const message = await new Promise<string>((resolve, reject) => {
        socket.once('message', (data) => resolve(data.toString()));
        socket.once('error', reject);
      });
      expect(message).toBe('connected');
      await new Promise<void>((resolve) => {
        socket.once('close', resolve);
        socket.close();
      });
    }
  });
});
