import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from '@playwright/test';
import WebSocket, { WebSocketServer } from 'ws';

const binary = process.env.CADDY_BINARY;
if (!binary) throw new Error('Set CADDY_BINARY to a verified Caddy 2.11.4 executable. This test starts only temporary local services.');
const user = 'gateway-test-owner';
const password = 'gateway-fake-password-649105';
async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
async function waitFor(operation) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if (await operation()) return; } catch { /* startup only */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error('Temporary gateway did not become ready');
}
async function deniedSocket(url) {
  const socket = new WebSocket(url);
  return new Promise((resolveStatus, reject) => {
    socket.once('unexpected-response', (request, response) => {
      const status = response.statusCode;
      request.destroy(); response.resume(); socket.terminate(); resolveStatus(status);
    });
    socket.once('error', reject);
    socket.once('open', () => { socket.close(); reject(new Error('Unauthenticated socket opened')); });
  });
}
const html = `<!doctype html><meta name="viewport" content="width=device-width"><title>Raven private fixture</title>
<output id="status">connecting</output><output id="api"></output><a id="artifact" href="/api/projects/fixture/files/content?path=report.txt">Open artifact</a>
<script>
fetch('/api/profile').then(r=>r.text()).then(t=>document.querySelector('#api').textContent=t);
let attempt=0; function connect(){ attempt++; const s=new WebSocket('ws://'+location.host+'/ws');
s.onmessage=e=>{document.querySelector('#status').textContent=e.data; document.querySelector('#status').dataset.attempt=attempt;};
s.onclose=()=>setTimeout(connect,30); } connect();
</script>`;

test('private gateway authenticates every route and browser-cached credentials support mobile WebSocket/artifacts', { timeout: 60000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'raven-private-gateway-'));
  const requests = [];
  const core = createServer((request, response) => {
    requests.push(`core:${request.url}`);
    response.setHeader('content-type', 'text/plain');
    response.end(request.url.startsWith('/api/projects/') ? 'MOBILE-ARTIFACT-672' : 'core fixture');
  });
  const web = createServer((request, response) => {
    requests.push(`web:${request.url}`);
    response.setHeader('content-type', request.url === '/' ? 'text/html' : 'text/plain');
    response.end(request.url === '/' ? html : 'web fixture');
  });
  const sockets = new WebSocketServer({ noServer: true });
  let connection = 0;
  core.on('upgrade', (request, socket, head) => {
    sockets.handleUpgrade(request, socket, head, (client) => {
      connection++;
      client.send('ready');
      if (connection === 1) setTimeout(() => client.close(), 80);
    });
  });
  let child;
  let browser;
  try {
    const corePort = await listen(core);
    const webPort = await listen(web);
    const reservation = createServer();
    const gatewayPort = await listen(reservation);
    await new Promise((done) => reservation.close(done));
    const hash = spawnSync(binary, ['hash-password'], { input: `${password}\n`, encoding: 'utf8', timeout: 10000 });
    assert.equal(hash.status, 0, 'Caddy password hashing failed');
    const config = readFileSync(new URL('../deployment/Caddyfile.private', import.meta.url), 'utf8')
      .replace(':4002 {', `http://127.0.0.1:${gatewayPort} {`)
      .replace('bind 0.0.0.0', 'bind 127.0.0.1')
      .replace('raven-core:4001', `127.0.0.1:${corePort}`)
      .replace('raven-web:4000', `127.0.0.1:${webPort}`);
    const configPath = join(root, 'Caddyfile');
    writeFileSync(configPath, config);
    child = spawn(binary, ['run', '--config', configPath, '--adapter', 'caddyfile'], {
      cwd: root,
      env: { PATH: process.env.PATH, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, RAVEN_PRIVATE_USERNAME: user, RAVEN_PRIVATE_PASSWORD_HASH: hash.stdout.trim() },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let errors = '';
    child.stderr.on('data', (data) => { errors = (errors + data).slice(-4000); });
    const base = `http://127.0.0.1:${gatewayPort}`;
    await waitFor(async () => (await fetch(base)).status === 401);
    for (const path of ['/', '/api', '/api/profile', '/ws', '/_next/static/test.js', '/api/projects/fixture/files/content?path=report.txt']) {
      const response = await fetch(base + path);
      assert.equal(response.status, 401, path);
      await response.text();
    }
    assert.equal(await deniedSocket(`ws://127.0.0.1:${gatewayPort}/ws`), 401);
    assert.equal(requests.length, 0, 'Unauthenticated requests reached an upstream');
    const headers = { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` };
    for (const path of ['/api', '/api/profile', '/_next/static/test.js']) {
      assert.equal((await fetch(base + path, { headers })).status, 200);
    }
    assert(requests.includes('core:/api'));
    assert(requests.includes('core:/api/profile'));
    assert(requests.includes('web:/_next/static/test.js'));
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    let challenges = 0;
    cdp.on('Fetch.authRequired', async ({ requestId }) => {
      challenges++;
      await cdp.send('Fetch.continueWithAuth', { requestId, authChallengeResponse: { response: 'ProvideCredentials', username: user, password } });
    });
    cdp.on('Fetch.requestPaused', async ({ requestId }) => { await cdp.send('Fetch.continueRequest', { requestId }); });
    await cdp.send('Fetch.enable', { handleAuthRequests: true });
    assert.equal((await page.goto(base)).status(), 200);
    await page.waitForFunction(() => document.querySelector('#status').dataset.attempt === '2');
    assert(challenges > 0);
    assert.equal(await page.locator('#api').textContent(), 'core fixture');
    await cdp.send('Fetch.disable');
    assert.equal((await page.reload()).status(), 200);
    await page.waitForFunction(() => document.querySelector('#status').textContent === 'ready');
    await page.locator('#artifact').click();
    await page.waitForURL('**/api/projects/**');
    assert((await page.locator('body').textContent()).includes('MOBILE-ARTIFACT-672'));
    assert(!errors.includes(password));
  } finally {
    await browser?.close();
    if (child && child.exitCode === null) { const closed = once(child, 'close'); child.kill('SIGTERM'); await closed; }
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    for (const server of [core, web]) { server.closeAllConnections(); await new Promise((done) => server.close(done)); }
    rmSync(root, { recursive: true, force: true });
  }
});
