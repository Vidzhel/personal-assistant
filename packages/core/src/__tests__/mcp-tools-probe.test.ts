import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { probeMcpTools } from '../diagnostics/mcp-tools-probe.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

type RpcMessage = { id?: number; method: string; params?: { cursor?: string } };
const tool = (name: string) => ({ name, inputSchema: { type: 'object' } });

async function server(
  handle: (message: RpcMessage, response: ServerResponse) => void,
  options: { rejectAuth?: boolean } = {},
): Promise<{ url: string; methods: string[]; authorizations: Array<string | undefined> }> {
  const methods: string[] = [];
  const authorizations: Array<string | undefined> = [];
  const instance = createServer((request: IncomingMessage, response: ServerResponse) => {
    authorizations.push(request.headers.authorization);
    if (options.rejectAuth) {
      response.writeHead(401).end('Authorization: Bearer fake-private-value');
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      const message = JSON.parse(body) as RpcMessage;
      methods.push(message.method);
      if (message.method === 'initialize') {
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'fake-ticktick', version: '1' },
            },
          }),
        );
      } else if (message.method === 'notifications/initialized') {
        response.writeHead(202).end();
      } else {
        handle(message, response);
      }
    });
  });
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        instance.closeAllConnections();
        instance.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  return {
    url: `http://127.0.0.1:${(instance.address() as AddressInfo).port}/mcp`,
    methods,
    authorizations,
  };
}

function reply(response: ServerResponse, message: RpcMessage, result: unknown): void {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
}

describe('read-only HTTP MCP readiness probe', () => {
  it('authenticates, follows bounded pagination and only lists tools', async () => {
    const fixture = await server((message, response) => {
      reply(
        response,
        message,
        message.params?.cursor === 'page2'
          ? { tools: [tool('list_projects')] }
          : { tools: [tool('search_task')], nextCursor: 'page2' },
      );
    });
    expect(
      await probeMcpTools({ url: fixture.url, headers: { Authorization: 'Bearer fake-token' } }),
    ).toEqual({ state: 'verified', toolNames: ['search_task', 'list_projects'] });
    expect(fixture.methods).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
      'tools/list',
    ]);
    expect(fixture.authorizations.every((value) => value === 'Bearer fake-token')).toBe(true);
  });

  it('reports rejected authentication without returning provider text or credentials', async () => {
    const fixture = await server(() => undefined, { rejectAuth: true });
    const result = await probeMcpTools({
      url: fixture.url,
      headers: { Authorization: 'Bearer fake-private-value' },
    });
    expect(result).toEqual({
      state: 'failed',
      stage: 'authentication',
      reason: expect.stringContaining('rejected authentication'),
    });
    expect(JSON.stringify(result)).not.toContain('fake-private-value');
    expect(fixture.methods).toEqual([]);
  });

  it('aborts a hanging response and closes the connection', async () => {
    const fixture = await server(() => undefined);
    const started = Date.now();
    expect(await probeMcpTools({ url: fixture.url, headers: {}, timeoutMs: 50 })).toEqual({
      state: 'failed',
      stage: 'tools',
      reason: expect.stringContaining('time limit'),
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('does not connect after caller cancellation', async () => {
    const fixture = await server(() => undefined);
    expect(
      await probeMcpTools({ url: fixture.url, headers: {}, signal: AbortSignal.abort() }),
    ).toEqual({
      state: 'failed',
      stage: 'connection',
      reason: expect.stringContaining('cancelled'),
    });
    expect(fixture.methods).toEqual([]);
  });

  it.each([
    ['invalid schema', { tools: [{ name: 'bad' }] }],
    ['duplicate tools', { tools: [tool('same'), tool('same')] }],
    ['repeated cursor', { tools: [], nextCursor: 'same' }],
    [
      'oversized catalog',
      { tools: Array.from({ length: 201 }, (_, index) => tool(`tool_${index}`)) },
    ],
  ])('rejects %s instead of reporting partial success', async (_name, result) => {
    const fixture = await server((message, response) => reply(response, message, result));
    expect((await probeMcpTools({ url: fixture.url, headers: {} })).state).toBe('failed');
    expect(fixture.methods.filter((method) => method === 'tools/list').length).toBeLessThanOrEqual(
      4,
    );
  });

  it('bounds response bytes and never exposes an oversized provider payload', async () => {
    const fixture = await server((message, response) =>
      reply(response, message, {
        tools: [{ ...tool('list_projects'), description: 'secret'.repeat(200_000) }],
      }),
    );
    const result = await probeMcpTools({ url: fixture.url, headers: {} });
    expect(result.state).toBe('failed');
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});
