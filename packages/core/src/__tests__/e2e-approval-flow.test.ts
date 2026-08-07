import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRaven, type RavenInstance } from '../raven.ts';
import type { AppConfig } from '../config.ts';
import type { AgentBackend, BackendOptions } from '../agent-manager/agent-backend.ts';
import type { PendingApproval } from '../permission-engine/pending-approvals.ts';
import {
  generateId,
  type AgentTaskRequestEvent,
  type AgentTaskCompleteEvent,
  type PermissionBlockedEvent,
  type PermissionApprovedEvent,
  type PermissionDeniedEvent,
  type AuditEntry,
} from '@raven/shared';

/**
 * E2E approval-flow round-trip over the real composition root: createRaven
 * -> start -> a raw `agent:task:request` on the bus (the production shape —
 * AgentManager's constructor is the sole subscriber, see agent-manager.ts;
 * this is exactly how a background service like email-triage.ts dispatches
 * a red-tier action it doesn't pre-approve itself) carrying a red-tier
 * `actionName` -> agent-session.ts's `enforcePermissionGate` blocks it
 * BEFORE the fake backend is ever called -> a pending approval row +
 * `permission:blocked` are queued -> REST `POST /api/approvals/:id/resolve`
 * resolves it -> approve re-dispatches through
 * `AgentManager.executeApprovedAction`, which this time DOES reach the fake
 * backend (prompt: "Execute approved action: ...") -> deny never
 * re-dispatches. Audit rows are asserted via the real `/api/audit-logs`
 * route.
 *
 * `gmail:send-email` / `gmail:delete-email` are red-tier by declaration
 * (library/skills/communication/email/gmail/config.json) — resolved via the
 * real CapabilityLibrary the same way production permission-engine.ts does,
 * not stubbed.
 *
 * No mocked SDK: the same fake `AgentBackend` seam boot-smoke.test.ts and
 * the other e2e-*.test.ts files use.
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
    NEO4J_URI: 'bolt://localhost:7687',
    NEO4J_USER: 'neo4j',
    NEO4J_PASSWORD: 'ravenpassword',
    RAVEN_SESSION_IDLE_TIMEOUT_MS: 1_800_000,
    RAVEN_SESSION_COMPACTION_THRESHOLD: 40,
    RAVEN_CONSOLIDATION_CRON: '0 3 * * 0',
    RAVEN_AUTO_RETROSPECTIVE_ENABLED: true,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('e2e: approval flow round-trip over the real composition root', () => {
  let tmpDir: string | undefined;
  let raven: RavenInstance | undefined;

  afterEach(async () => {
    if (raven) await raven.stop();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    raven = undefined;
    tmpDir = undefined;
  });

  it('blocks a red-tier action pre-query and queues approval; approve re-dispatches to the backend, deny never does', async () => {
    const calls: BackendOptions[] = [];
    const fakeBackend: AgentBackend = async (opts) => {
      calls.push(opts);
      opts.onAssistantMessage('done');
      return { result: 'ok', success: true, errors: [] };
    };

    tmpDir = mkdtempSync(join(tmpdir(), 'raven-e2e-approval-'));
    const dbPath = join(tmpDir, 'test.db');

    // No background services needed for this flow — the gate lives entirely
    // in agent-manager/agent-session/permission-engine.
    raven = await createRaven(buildTestConfig(), {
      dbPath,
      dataDir: tmpDir,
      agentBackend: fakeBackend,
      skipSuites: true,
    });
    await raven.start();

    const baseUrl = `http://localhost:${String(raven.port)}`;

    const blocked: PermissionBlockedEvent[] = [];
    raven.eventBus.on<PermissionBlockedEvent>('permission:blocked', (e) => {
      blocked.push(e);
    });
    const approved: PermissionApprovedEvent[] = [];
    raven.eventBus.on<PermissionApprovedEvent>('permission:approved', (e) => {
      approved.push(e);
    });
    const denied: PermissionDeniedEvent[] = [];
    raven.eventBus.on<PermissionDeniedEvent>('permission:denied', (e) => {
      denied.push(e);
    });
    const completions: AgentTaskCompleteEvent[] = [];
    raven.eventBus.on<AgentTaskCompleteEvent>('agent:task:complete', (e) => {
      completions.push(e);
    });

    // ── Pre-approval path: dispatch a red-tier action the way a background
    // service does — a raw agent:task:request on the bus, no prior human
    // approval. runAgentTask's pre-query gate (enforcePermissionGate) must
    // block this before the fake backend ever sees it.
    const taskId1 = generateId();
    const sendEmailRequest: AgentTaskRequestEvent = {
      id: generateId(),
      timestamp: Date.now(),
      source: 'test-harness',
      type: 'agent:task:request',
      payload: {
        taskId: taskId1,
        prompt: 'Email the board with the quarterly numbers.',
        skillName: 'gmail',
        actionName: 'gmail:send-email', // red tier (library/skills/communication/email/gmail/config.json)
        mcpServers: {},
        priority: 'normal',
      },
    };
    raven.eventBus.emit(sendEmailRequest);

    await waitFor(() => blocked.length >= 1);
    await waitFor(() => completions.some((c) => c.payload.taskId === taskId1));

    // The gate ran BEFORE any backend dispatch.
    expect(calls.length).toBe(0);
    expect(blocked[0].payload.actionName).toBe('gmail:send-email');
    expect(blocked[0].payload.skillName).toBe('gmail');
    expect(blocked[0].payload.tier).toBe('red');
    const approvalId1 = blocked[0].payload.approvalId;

    const complete1 = completions.find((c) => c.payload.taskId === taskId1);
    expect(complete1?.payload.success).toBe(false);
    expect(complete1?.payload.blocked).toBe(true);

    const pendingRes1 = await fetch(`${baseUrl}/api/approvals/pending`);
    expect(pendingRes1.status).toBe(200);
    const pending1 = (await pendingRes1.json()) as PendingApproval[];
    expect(pending1.map((p) => p.id)).toContain(approvalId1);

    // ── Resolve: approve. The route (routes/approvals.ts) awaits
    // agentManager.executeApprovedAction end-to-end before replying, so by
    // the time this fetch resolves, the re-dispatch has already reached (or
    // failed to reach) the fake backend — no polling needed.
    const resolveRes1 = await fetch(`${baseUrl}/api/approvals/${approvalId1}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolution: 'approved' }),
    });
    expect(resolveRes1.status).toBe(200);
    expect(await resolveRes1.json()).toEqual({
      id: approvalId1,
      resolution: 'approved',
      status: 'resolved',
    });

    expect(approved.length).toBe(1);
    expect(approved[0].payload.actionName).toBe('gmail:send-email');

    // executeApprovedAction's re-dispatch genuinely reached the fake backend.
    expect(calls.length).toBe(1);
    expect(calls[0].prompt).toContain('Execute approved action: gmail:send-email');

    // Approval queue is empty again.
    const pendingRes2 = await fetch(`${baseUrl}/api/approvals/pending`);
    const pending2 = (await pendingRes2.json()) as PendingApproval[];
    expect(pending2.find((p) => p.id === approvalId1)).toBeUndefined();

    // Audit trail: queued (gate) -> approved (resolve) -> executed (post-exec).
    const auditRes1 = await fetch(`${baseUrl}/api/audit-logs`);
    expect(auditRes1.status).toBe(200);
    const audit1 = (await auditRes1.json()) as AuditEntry[];
    const sendEmailAudit = audit1.filter((a) => a.actionName === 'gmail:send-email');
    expect(sendEmailAudit.map((a) => a.outcome).sort()).toEqual(['approved', 'executed', 'queued']);

    // ── Deny path: a second red-tier action never gets re-dispatched.
    const taskId2 = generateId();
    const deleteEmailRequest: AgentTaskRequestEvent = {
      id: generateId(),
      timestamp: Date.now(),
      source: 'test-harness',
      type: 'agent:task:request',
      payload: {
        taskId: taskId2,
        prompt: 'Permanently delete the email with id msg-999.',
        skillName: 'gmail',
        actionName: 'gmail:delete-email', // also red tier
        mcpServers: {},
        priority: 'normal',
      },
    };
    raven.eventBus.emit(deleteEmailRequest);

    await waitFor(() => blocked.length >= 2);
    await waitFor(() => completions.some((c) => c.payload.taskId === taskId2));

    expect(calls.length).toBe(1); // still just the one approved re-dispatch
    const approvalId2 = blocked[1].payload.approvalId;

    const resolveRes2 = await fetch(`${baseUrl}/api/approvals/${approvalId2}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolution: 'denied' }),
    });
    expect(resolveRes2.status).toBe(200);
    expect(await resolveRes2.json()).toEqual({
      id: approvalId2,
      resolution: 'denied',
      status: 'resolved',
    });

    // Deny never re-dispatches to the backend.
    expect(calls.length).toBe(1);
    expect(denied.length).toBe(1);
    expect(denied[0].payload.actionName).toBe('gmail:delete-email');

    const auditRes2 = await fetch(`${baseUrl}/api/audit-logs`);
    const audit2 = (await auditRes2.json()) as AuditEntry[];
    const deleteEmailAudit = audit2.filter((a) => a.actionName === 'gmail:delete-email');
    expect(deleteEmailAudit.map((a) => a.outcome).sort()).toEqual(['denied', 'queued']);

    const pendingRes3 = await fetch(`${baseUrl}/api/approvals/pending`);
    const pending3 = (await pendingRes3.json()) as PendingApproval[];
    expect(pending3.length).toBe(0);

    // Clean stop — no dangling handles.
    await raven.stop();
    raven = undefined;
  }, 10000);
});
