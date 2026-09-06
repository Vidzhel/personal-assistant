import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { createRaven, type RavenInstance } from '../raven.ts';
import { buildTestConfig, createRavenTestFixture } from './fixtures/raven-fixture.ts';

let root: string | undefined;
let raven: RavenInstance | undefined;
afterEach(async () => {
  await raven?.stop();
  raven = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe('composed browser origin enforcement', () => {
  it('protects actual project mutation and WebSocket routes with the configured origin', async () => {
    root = mkdtempSync(join(tmpdir(), 'raven-origin-composed-'));
    raven = await createRaven(
      { ...buildTestConfig(), RAVEN_BASE_URL: 'https://private.raven.test' },
      {
        ...createRavenTestFixture(root),
        apiHost: '127.0.0.1',
        skipSuites: true,
        agentBackend: async () => {
          throw new Error('Origin tests must not run models');
        },
      },
    );
    await raven.start();
    const base = `http://127.0.0.1:${String(raven.port)}`;
    const denied = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Forbidden origin project' }),
    });
    expect(denied.status).toBe(403);
    await denied.text();
    const allowed = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { Origin: 'https://private.raven.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Allowed origin project' }),
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://private.raven.test');
    await allowed.text();
    const list = (await (await fetch(`${base}/api/projects`)).json()) as { name: string }[];
    expect(list.some((project) => project.name === 'Forbidden origin project')).toBe(false);
    const socket = new WebSocket(base.replace('http:', 'ws:') + '/ws', {
      origin: 'https://evil.test',
    });
    const status = await new Promise<number>((resolve, reject) => {
      socket.once('unexpected-response', (request, response) => {
        request.destroy();
        response.resume();
        resolve(response.statusCode ?? 0);
        socket.terminate();
      });
      socket.once('error', reject);
      socket.once('open', () => {
        socket.close();
        reject(new Error('Disallowed WebSocket opened'));
      });
    });
    expect(status).toBe(403);
    const accepted = new WebSocket(base.replace('http:', 'ws:') + '/ws', {
      origin: 'https://private.raven.test',
    });
    await new Promise<void>((resolve, reject) => {
      accepted.once('open', resolve);
      accepted.once('error', reject);
    });
    await new Promise<void>((resolve) => {
      accepted.once('close', resolve);
      accepted.close();
    });
  });
});
