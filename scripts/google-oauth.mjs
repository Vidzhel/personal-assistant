#!/usr/bin/env node
/**
 * Google OAuth2 Token Generator for Gmail
 *
 * Usage:
 *   node scripts/google-oauth.mjs <CLIENT_ID> <CLIENT_SECRET>
 *
 * This script:
 * 1. Starts a local HTTP server on port 4002
 * 2. Opens Google's OAuth consent page
 * 3. Captures the auth code
 * 4. Exchanges it for access + refresh tokens
 * 5. Prints tokens for .env
 *
 * SETUP FIRST - see docs/GOOGLE_OAUTH_SETUP.md
 */

import http from 'node:http';
import { URL } from 'node:url';
import { execFileSync } from 'node:child_process';

const CLIENT_ID = process.argv[2] || process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.argv[3] || process.env.GMAIL_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:4002/callback';

// Scopes needed for Gmail MCP
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.labels',
].join(' ');

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Usage: node scripts/google-oauth.mjs <CLIENT_ID> <CLIENT_SECRET>');
  console.error('  Or set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET env vars');
  console.error('\nSee docs/GOOGLE_OAUTH_SETUP.md for setup instructions.');
  process.exit(1);
}

const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
  `client_id=${encodeURIComponent(CLIENT_ID)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&response_type=code` +
  `&scope=${encodeURIComponent(SCOPES)}` +
  `&access_type=offline` +
  `&prompt=consent`;

console.log('\n=== Google OAuth2 Token Generator (Gmail) ===\n');
console.log('Starting local server on http://localhost:4002...');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:4002');

  if (url.pathname === '/callback') {
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(`<h1>Error: ${error}</h1>`);
      console.error(`\nAuthorization denied: ${error}`);
      setTimeout(() => process.exit(1), 1000);
      return;
    }

    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<h1>Error: No authorization code received</h1>');
      return;
    }

    console.log(`\nReceived authorization code: ${code.slice(0, 15)}...`);
    console.log('Exchanging for tokens...');

    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          code,
          grant_type: 'authorization_code',
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
      console.log(`GMAIL_CLIENT_ID=${CLIENT_ID}`);
      console.log(`GMAIL_CLIENT_SECRET=${CLIENT_SECRET}`);
      console.log(`GMAIL_REFRESH_TOKEN=${tokenData.refresh_token}`);

      if (!tokenData.refresh_token) {
        console.log('\n⚠️  No refresh_token returned. This happens if you already authorized.');
        console.log('   Go to https://myaccount.google.com/connections and revoke Raven access,');
        console.log('   then run this script again.');
      }

      console.log(`\nAccess token (temporary): ${tokenData.access_token?.slice(0, 20)}...`);
      console.log(`Scopes granted: ${tokenData.scope}`);

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html><body style="font-family:system-ui;max-width:600px;margin:80px auto;text-align:center">
          <h1 style="color:#22c55e">Gmail Authorization Successful!</h1>
          <p>Your refresh token has been generated.</p>
          <p>Check the terminal for the values to add to your <code>.env</code> file.</p>
          <p style="color:#737373;margin-top:40px">You can close this tab.</p>
        </body></html>
      `);
    } catch (err) {
      console.error('\nToken exchange failed:', err.message);
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(`<h1>Error</h1><p>${err.message}</p>`);
    }

    setTimeout(() => {
      server.close();
      process.exit(0);
    }, 1000);
  } else {
    res.writeHead(302, { Location: authUrl });
    res.end();
  }
});

server.listen(4002, () => {
  console.log(`\nOpening browser to authorize Gmail access...\n`);
  console.log(`If the browser doesn't open, visit:\n${authUrl}\n`);

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
