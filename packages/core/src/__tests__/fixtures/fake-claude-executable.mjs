#!/usr/bin/env node
// Fake `claude` CLI executable for sdk-backend-contract.test.ts.
//
// Speaks just enough of the stream-json protocol that createSdkBackend()'s
// message loop can parse a full turn: a system/init message carrying a
// session id, one assistant text message, and a result. Exercises the real
// SDK's process-spawn path (via `pathToClaudeCodeExecutable`) instead of
// mocking `query()` — see BackendOptions.executablePathOverride.
//
// Also records what the SDK actually spawned it with — argv (to verify
// `--resume <id>` reaches the subprocess) and a couple of env vars (to
// verify sdk-backend.ts's CLAUDECODE nesting-guard strip reaches the
// subprocess) — into the file named by FAKE_CLAUDE_ARGV_LOG, one JSON object
// per invocation (newline-delimited, so a test that calls the backend twice
// can inspect each call separately).
//
// Must be a plain .mjs (not .cjs/.ts) run from this fixed path: the SDK only
// takes the "spawn `node <path>`" branch for pathToClaudeCodeExecutable
// values ending in .js/.mjs/.tsx/.ts/.jsx — anything else is spawned
// directly as a native binary, which would need a shebang + exec bit.

import { appendFileSync } from 'node:fs';

const logPath = process.env.FAKE_CLAUDE_ARGV_LOG;
if (logPath) {
  const entry = {
    argv: process.argv.slice(2),
    env: {
      CLAUDECODE: process.env.CLAUDECODE ?? null,
      CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT ?? null,
    },
  };
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

emit({ type: 'system', subtype: 'init', session_id: 'fake-123' });
emit({
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'fake response' }] },
});
emit({ type: 'result', subtype: 'success', result: 'ok' });
