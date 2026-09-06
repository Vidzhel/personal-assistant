import { createServer } from 'node:http';

export async function createMcpFixture(write) {
  let rejected = false;
  const methods = [];
  const server = createServer((request, response) => {
    if (rejected || request.headers.authorization !== 'Bearer fake-browser-mcp-token') {
      response.writeHead(401).end('Fake authentication rejected');
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const message = JSON.parse(body);
      methods.push(message.method);
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const result = message.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
        : { tools: Array.from({ length: 47 }, (_, i) => ({ name: `fixture_${i}`, inputSchema: { type: 'object' } })) };
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.RAVEN_E2E_MCP_TOKEN = 'fake-browser-mcp-token';
  write('library/mcps/http-fixture.json', {
    name: 'http-fixture', displayName: 'HTTP fixture', type: 'http',
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    headers: { Authorization: 'Bearer ${RAVEN_E2E_MCP_TOKEN}' },
  });
  write('library/skills/http-fixture/config.json', { name: 'http-fixture', displayName: 'HTTP connection fixture', description: 'Local read-only protocol fixture', mcps: ['http-fixture'] });
  write('library/skills/http-fixture/skill.md', 'Local read-only fixture.');
  write('projects/mcp-readiness/context.md', '# MCP readiness fixture\n');
  write('projects/mcp-readiness/agents/raven/agent.yaml', {
    name: 'raven', displayName: 'Readiness agent', description: 'Readiness fixture', isDefault: true, skills: ['http-fixture'],
  });
  return {
    methods,
    setRejected: (value) => { rejected = value; },
    stop: () => new Promise((resolve, reject) => {
      delete process.env.RAVEN_E2E_MCP_TOKEN;
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
