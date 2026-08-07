/**
 * Structural, defense-in-depth test safety net.
 *
 * Registered as this package's `test.setupFiles` (see ../../../vitest.config.ts),
 * so it runs once per test file before that file's own module graph is
 * imported — in particular before any test file (or a module it imports,
 * e.g. `raven.ts` / `config.ts`) can read a real credential out of
 * `process.env`.
 *
 * `config.ts` itself now skips `dotenv.config()` entirely under
 * `VITEST`/`NODE_ENV=test` (see config.ts), which handles the direct cause of
 * the incident this guards against: a test that only blanked the Gmail env
 * vars it cared about, leaving the real `.env`'s Telegram bot token in
 * `process.env`, which caused `createRaven()` (no `skipSuites`) to boot the
 * REAL telegram-bot service against the live Telegram Bot API.
 *
 * This module is the backstop for every OTHER way a credential can end up in
 * `process.env` — inherited from the parent shell (a developer's `.bashrc`
 * exporting these directly), a differently-invoked test runner, or a future
 * test file that loads `.env` itself. It unconditionally deletes every
 * `process.env` key matching a known credential prefix, scanning
 * `process.env` itself rather than checking a fixed list of variable names —
 * so a new variable under an already-listed prefix (e.g. a hypothetical
 * `TELEGRAM_WEBHOOK_SECRET`) is caught automatically, with no need to update
 * this file when a skill adds one.
 *
 * Individual tests remain free to set whatever fake values they need (see
 * e.g. e2e-email-triage.test.ts's beforeEach) — this only runs once, before
 * the file's tests are collected, so it never fights a test's own setup.
 */

// One entry per credential family currently in the codebase (grep
// `packages/core/src/config.ts` and `library/` for the full source list).
// Entries are prefixes, not exact names — `ANTHROPIC_API_KEY`/
// `NEO4J_PASSWORD`/`GOOGLE_API_KEY` have no siblings today, so their "prefix"
// is just their own full name; that still means any future
// `ANTHROPIC_API_KEY_*`-shaped addition is covered without touching this file.
const CREDENTIAL_ENV_PREFIXES = [
  'TELEGRAM_',
  'TICKTICK_',
  'GMAIL_',
  'GWS_',
  'YNAB_',
  'MONOBANK_',
  'PRIVATBANK_',
  'GOOGLE_API_KEY',
  'ANTHROPIC_API_KEY',
  'NEO4J_PASSWORD',
] as const;

for (const key of Object.keys(process.env)) {
  if (CREDENTIAL_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    Reflect.deleteProperty(process.env, key);
  }
}
