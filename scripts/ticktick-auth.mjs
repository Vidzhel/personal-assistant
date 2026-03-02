#!/usr/bin/env node
/**
 * TickTick OAuth2 Token Generator
 *
 * Usage:
 *   node scripts/ticktick-auth.mjs <CLIENT_ID> <CLIENT_SECRET>
 *
 * Or set env vars:
 *   TICKTICK_CLIENT_ID=xxx TICKTICK_CLIENT_SECRET=yyy node scripts/ticktick-auth.mjs
 *
 * This script:
 * 1. Starts a local HTTP server on port 8080
 * 2. Opens the TickTick authorization page in your browser
 * 3. Captures the auth code from the redirect
 * 4. Exchanges it for an access token
 * 5. Prints the token for you to add to .env
 */

import http from 'node:http';
import { URL } from 'node:url';
import { execFileSync } from 'node:child_process';

const CLIENT_ID = process.argv[2] || process.env.TICKTICK_CLIENT_ID;
const CLIENT_SECRET = process.argv[3] || process.env.TICKTICK_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:8080/callback';
const SCOPE = 'tasks:read tasks:write';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Usage: node scripts/ticktick-auth.mjs <CLIENT_ID> <CLIENT_SECRET>');
  console.error('  Or set TICKTICK_CLIENT_ID and TICKTICK_CLIENT_SECRET env vars');
  process.exit(1);
}

const authUrl = `https://ticktick.com/oauth/authorize?` +
  `client_id=${encodeURIComponent(CLIENT_ID)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&response_type=code` +
  `&scope=${encodeURIComponent(SCOPE)}`;

console.log('\n=== TickTick OAuth2 Token Generator ===\n');
console.log('Starting local server on http://localhost:8080...');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:8080');

  if (url.pathname === '/callback') {
    const code = url.searchParams.get('code');

    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<h1>Error: No authorization code received</h1>');
      return;
    }

    console.log(`\nReceived authorization code: ${code.slice(0, 10)}...`);
    console.log('Exchanging for access token...');

    try {
      // Exchange code for token
      const tokenRes = await fetch('https://ticktick.com/oauth/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
        }).toString(),
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        throw new Error(`Token exchange failed (${tokenRes.status}): ${errText}`);
      }

      const tokenData = await tokenRes.json();

      console.log('\n=== SUCCESS ===\n');
      console.log('Add these to your .env file:\n');
      console.log(`TICKTICK_CLIENT_ID=${CLIENT_ID}`);
      console.log(`TICKTICK_CLIENT_SECRET=${CLIENT_SECRET}`);
      console.log(`TICKTICK_ACCESS_TOKEN=${tokenData.access_token}`);

      if (tokenData.refresh_token) {
        console.log(`TICKTICK_REFRESH_TOKEN=${tokenData.refresh_token}`);
      }

      console.log(`\nToken type: ${tokenData.token_type}`);
      if (tokenData.expires_in) {
        console.log(`Expires in: ${tokenData.expires_in} seconds`);
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html><body style="font-family:system-ui;max-width:600px;margin:80px auto;text-align:center">
          <h1 style="color:#22c55e">Authorization Successful!</h1>
          <p>Your TickTick access token has been generated.</p>
          <p>Check the terminal for the token values to add to your <code>.env</code> file.</p>
          <p style="color:#737373;margin-top:40px">You can close this tab.</p>
        </body></html>
      `);
    } catch (err) {
      console.error('\nToken exchange failed:', err.message);
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(`<h1>Error</h1><p>${err.message}</p>`);
    }

    // Shut down after a brief delay
    setTimeout(() => {
      server.close();
      process.exit(0);
    }, 1000);
  } else {
    res.writeHead(302, { Location: authUrl });
    res.end();
  }
});

server.listen(8080, () => {
  console.log(`\nOpening browser to authorize TickTick...\n`);
  console.log(`If the browser doesn't open, visit:\n${authUrl}\n`);

  // Try to open browser via WSL2 -> Windows
  try {
    execFileSync('cmd.exe', ['/c', 'start', '', authUrl], { stdio: 'ignore' });
  } catch {
    try {
      execFileSync('xdg-open', [authUrl], { stdio: 'ignore' });
    } catch {
      console.log('(Could not auto-open browser. Please open the URL manually.)');
    }
  }
});
