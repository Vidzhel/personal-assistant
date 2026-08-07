import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRaven, type RavenInstance } from '../raven.ts';
import type { AppConfig } from '../config.ts';
import type { AgentBackend, BackendOptions } from '../agent-manager/agent-backend.ts';
import {
  generateId,
  SOURCE_GMAIL,
  type NewEmailEvent,
  type EmailTriageProcessedEvent,
} from '@raven/shared';

/**
 * E2E email-triage round-trip over the real composition root: createRaven
 * (real background services this time — no `skipSuites`) -> start -> emit
 * `email:new` on the bus exactly as imap-watcher.ts would
 * (services/email/imap-watcher.ts's `fetchNewMessages` emits this same
 * shape) -> the REAL email-triage service (services/email/email-triage.ts,
 * started by services/runner.ts's env-gating, not a reimplementation)
 * matches the rule, and its rule actions (archive + markRead) run through
 * `AgentManager.executeAction` — a genuine agent task that reaches
 * the injected fake backend — then the service emits the real
 * `email:triage:processed` event.
 *
 * Coupling verified by reading the source: email-triage.ts pulls its
 * `agentManager` from `context.config.agentManager` (raven.ts wires this in
 * via `Object.assign(baseContext.config, { agentManager })`), and its rules
 * from the real `config/email-rules.json` on disk (via `context.projectRoot`,
 * not the temp `dataDir` override — same as templates in
 * e2e-schedule-roundtrip.test.ts). The email used here matches ONLY that
 * file's "automated-noreply" rule (archive + markRead, no label/flag/
 * extractActions), so email-triage's own dispatch count stays deterministic
 * — no cascading action-extractor calls.
 *
 * `email:new` also has a SECOND, independent subscriber: orchestrator.ts's
 * own `handleNewEmail` (registered in the Orchestrator constructor, not
 * part of the suites/services stratum at all) fires on every new email
 * regardless of triage rules, dispatching its own gmail-skill "analyze this
 * email" agent task. Discovered by running this test and seeing three
 * backend calls instead of the two triage actions alone — real, correct
 * behavior once traced to orchestrator.ts, not a bug, so this test asserts
 * on all three real dispatches rather than forcing a narrower expectation.
 *
 * The email-triage/reply-composer/action-extractor/imap-watcher service
 * group is gated on GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN (services/registry
 * .ts's GMAIL_ENV) — set to fake values here so the group starts; none of
 * these three vars are used for any outbound call in email-triage.ts's
 * start() (verified by reading it — it only reads rule config and
 * registers listeners). imap-watcher separately gates its own real IMAP
 * connection on GMAIL_IMAP_USER/PASSWORD, deliberately blanked here.
 *
 * IMPORTANT: an earlier draft of this test — before the credential-blanking
 * below was structural — only touched the Gmail vars, which let the real
 * `.env`'s Telegram bot token reach `process.env` and caused the REAL
 * telegram-bot service to start and call the live Telegram Bot API
 * (bootstrapGroupModeTopics -> ensureAllAgentTopics, plus forwarding this
 * test's own agent:task:complete events to the real chat). Two structural
 * fixes now make that impossible regardless of what this file does: `config
 * .ts` skips `dotenv.config()` entirely under `VITEST`/`NODE_ENV=test`, and
 * `__tests__/setup/env-guard.ts` (this package's `test.setupFiles`) deletes
 * every credential-prefixed `process.env` key before this file's module
 * graph even loads. So the only env this test needs to manage itself is the
 * one thing that guard deliberately doesn't provide: the fake Gmail values
 * that let the Gmail service group's `requiresEnv` gate (services/registry
 * .ts) pass.
 */

function buildTestConfig(): AppConfig {
  return {
    ANTHROPIC_API_KEY: '',
    CLAUDE_MODEL: 'claude-sonnet-4-6',
    RAVEN_PORT: 0,
    RAVEN_TIMEZONE: 'UTC',
    RAVEN_DIGEST_TIME: '08:00',
    RAVEN_MAX_CONCURRENT_AGENTS: 3,
    RAVEN_AGENT_MAX_TURNS: 25,
    RAVEN_MAX_BUDGET_USD_PER_DAY: 5,
    DATABASE_PATH: './data/raven.db',
    SESSION_PATH: './data/sessions',
    LOG_LEVEL: 'info',
    // No Neo4j runs in this test environment. cross-domain-detector
    // (requiresEnv: []) starts unconditionally and probes Neo4j once at
    // boot (see services/proactive-intelligence/cross-domain-detector.ts) —
    // connecting to a closed local port fails immediately (ECONNREFUSED),
    // so it degrades to no-op well within this test's budget, same
    // resilience path boot-smoke.test.ts exercises.
    NEO4J_URI: 'bolt://localhost:7687',
    NEO4J_USER: 'neo4j',
    NEO4J_PASSWORD: 'ravenpassword',
    RAVEN_SESSION_IDLE_TIMEOUT_MS: 1_800_000,
    RAVEN_CONSOLIDATION_CRON: '0 3 * * 0',
    RAVEN_AUTO_RETROSPECTIVE_ENABLED: true,
    RAVEN_HEARTBEAT_ACTIVE_HOURS: '08-22',
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('e2e: email triage round-trip over the real composition root', () => {
  let tmpDir: string | undefined;
  let raven: RavenInstance | undefined;

  beforeEach(() => {
    // env-guard.ts (this package's test.setupFiles) already deleted every
    // credential-prefixed env var — including GMAIL_* — before this file
    // loaded, and config.ts's own dotenv.config() is skipped under the test
    // runner, so there's nothing left to save/blank/restore here. The only
    // thing this test needs to do is supply the fake Gmail values that let
    // services/registry.ts's Gmail group `requiresEnv` gate pass. Fake
    // values just need to be present — services/email/email-triage.ts's
    // start() never uses them for an outbound call (verified by reading it:
    // it only reads local rule config and registers listeners).
    process.env.GMAIL_CLIENT_ID = 'test-gmail-client-id';
    process.env.GMAIL_CLIENT_SECRET = 'test-gmail-client-secret';
    process.env.GMAIL_REFRESH_TOKEN = 'test-gmail-refresh-token';
  });

  afterEach(async () => {
    if (raven) await raven.stop();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    raven = undefined;
    tmpDir = undefined;
  });

  it('email:new drives the real triage service, whose rule actions genuinely dispatch to the fake backend', async () => {
    const calls: BackendOptions[] = [];
    const fakeBackend: AgentBackend = async (opts) => {
      calls.push(opts);
      opts.onAssistantMessage('done');
      return { result: 'ok', success: true, errors: [] };
    };

    tmpDir = mkdtempSync(join(tmpdir(), 'raven-e2e-triage-'));
    const dbPath = join(tmpDir, 'test.db');

    // Deliberately no `skipSuites` override — the whole point is exercising
    // the real registered services (services/registry.ts), started by
    // services/runner.ts's env-gating exactly as production boot does.
    raven = await createRaven(buildTestConfig(), {
      dbPath,
      dataDir: tmpDir,
      agentBackend: fakeBackend,
    });
    await raven.start();

    const baseUrl = `http://localhost:${String(raven.port)}`;

    // Sanity check: the Gmail service group actually started (gate let it
    // through) rather than every service being skipped for missing env.
    const healthRes = await fetch(`${baseUrl}/api/health`);
    expect(healthRes.status).toBe(200);
    const health = (await healthRes.json()) as { services: { loaded: number } };
    expect(health.services.loaded).toBeGreaterThan(0);

    const processed: EmailTriageProcessedEvent[] = [];
    raven.eventBus.on<EmailTriageProcessedEvent>('email:triage:processed', (e) => {
      processed.push(e);
    });

    // Matches config/email-rules.json's "automated-noreply" rule ONLY (from
    // contains "noreply@" AND has "automated"): not "newsletter-archive"
    // (no "unsubscribe") and not "important-senders" (from doesn't match
    // any listed contact) — keeps the dispatch count deterministic.
    const emailEvent: NewEmailEvent = {
      id: generateId(),
      timestamp: Date.now(),
      source: SOURCE_GMAIL,
      type: 'email:new',
      payload: {
        from: 'noreply@updates.example.com',
        subject: 'Automated system notification',
        snippet: 'This is an automated message, no reply is needed.',
        messageId: 'e2e-triage-msg-1',
        receivedAt: Date.now(),
      },
    };
    raven.eventBus.emit(emailEvent);

    await waitFor(() => processed.length >= 1);

    expect(processed[0].payload.emailId).toBe('e2e-triage-msg-1');
    expect(processed[0].payload.rulesMatched).toEqual(['automated-noreply']);
    expect(processed[0].payload.actionsTaken.sort()).toEqual(['archive', 'markRead']);

    // Three genuine agent-task dispatches to the fake backend for this one
    // email:new event — the real, complete picture (see module docstring):
    // orchestrator.ts's independent "analyze this new email" dispatch, plus
    // email-triage's two rule actions via AgentManager.executeAction
    // (yellow-tier gmail:archive-email / gmail:mark-read; executeAction
    // marks its own re-dispatch pre-approved by construction, so neither
    // touches the approval queue).
    expect(calls.length).toBe(3);

    const orchestratorCall = calls.find((c) => c.prompt.includes('A new email has arrived'));
    expect(orchestratorCall?.prompt).toContain('Automated system notification');
    expect(orchestratorCall?.prompt).toContain('noreply@updates.example.com');

    const archiveCall = calls.find((c) =>
      c.prompt.startsWith('Execute approved action: gmail:archive-email'),
    );
    expect(archiveCall?.prompt).toContain('e2e-triage-msg-1');

    const markReadCall = calls.find((c) =>
      c.prompt.startsWith('Execute approved action: gmail:mark-read'),
    );
    expect(markReadCall?.prompt).toContain('e2e-triage-msg-1');

    // Clean stop — no dangling handles (real services this time: interval
    // timers, IMAP reconnect timers, etc. must all be torn down).
    await raven.stop();
    raven = undefined;
  }, 15000);
});
