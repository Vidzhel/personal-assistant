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
 * `AgentManager.executeAction`, which this time DOES reach the fake
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
    // M11: results of exercising the fine-grained, per-tool-call gate
    // (canUseTool) from inside a real run — as opposed to the coarse,
    // pre-query gate the rest of this test exercises via a top-level
    // actionName. Populated below, once, by the third dispatch.
    const toolPolicyResults: unknown[] = [];
    // Matches tool-policy.test.ts's own fake — the SDK's real CanUseTool
    // type requires this third argument (sdk.d.ts), even though the fields
    // in it are irrelevant to every policy branch this test exercises.
    const FAKE_CAN_USE_TOOL_OPTIONS = {
      signal: new AbortController().signal,
      toolUseID: 'test-tool-use',
    };
    const fakeBackend: AgentBackend = async (opts) => {
      calls.push(opts);

      // M11: allowedTools must never include Bash or an integration-MCP
      // wildcard — canUseTool is the SOLE gate for those (see tool-policy
      // .ts's module docstring: either one in allowedTools would let the SDK
      // auto-allow the call and skip this callback entirely). Checked on
      // every dispatch this fake backend sees, not just one.
      expect(opts.allowedTools).not.toContain('Bash');
      expect(opts.allowedTools.some((t) => t.startsWith('mcp__gmail__'))).toBe(false);
      expect(typeof opts.canUseTool).toBe('function');

      if (calls.length === 2) {
        // This is the third eventBus dispatch below — it carries no
        // actionName, so it skips the coarse pre-query gate entirely and
        // reaches here with a REAL canUseTool built from this task's own
        // permissionDeps (agent-session.ts), not undefined. Exercise it
        // exactly as the SDK would for a tool call the model makes mid-run:
        // gmail:send-email is red-tier and this task never pre-approved it,
        // so the policy must deny the call and queue a fresh approval —
        // the same fallback path the coarse gate above delegates to for
        // actions it doesn't already know about.
        toolPolicyResults.push(
          await opts.canUseTool!('mcp__gmail__send_email', { to: 'x' }, FAKE_CAN_USE_TOOL_OPTIONS),
        );
      }

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
    // agentManager.executeAction end-to-end before replying, so by
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

    // executeAction's re-dispatch genuinely reached the fake backend.
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

    // ── M11: the fine-grained, per-tool-call gate (canUseTool), exercised
    // via a dispatch with no top-level actionName — the shape orchestrator
    // .ts's own "analyze this new email" dispatch has in production — so it
    // skips enforcePermissionGate entirely and reaches the fake backend.
    const taskId3 = generateId();
    const analyzeRequest: AgentTaskRequestEvent = {
      id: generateId(),
      timestamp: Date.now(),
      source: 'test-harness',
      type: 'agent:task:request',
      payload: {
        taskId: taskId3,
        prompt: 'Look into this email thread and summarize it.',
        skillName: 'gmail',
        mcpServers: {},
        priority: 'normal',
      },
    };
    raven.eventBus.emit(analyzeRequest);

    await waitFor(() => calls.length >= 2);
    await waitFor(() => completions.some((c) => c.payload.taskId === taskId3));

    // No coarse-gate block for this dispatch (it never carried an
    // actionName), but the per-call gate inside the fake backend above
    // denied its one gmail:send-email tool call — the SAME PermissionResult
    // shape enforcePermissionGate's callers get: `allow()` now must echo
    // `updatedInput` (the SDK's actual runtime schema — see tool-policy.ts's
    // module docstring), and `deny()` is `{ behavior: 'deny', message }`.
    expect(toolPolicyResults).toEqual([
      { behavior: 'deny', message: expect.stringContaining('Queued for approval') },
    ]);

    // That denial queued a fresh approval. Dedup is keyed on (actionName,
    // sessionId) — this task, like task1/task2 above, carries no sessionId,
    // and pendingRes3 just confirmed the queue is empty (both prior
    // gmail:send-email/gmail:delete-email approvals are already resolved,
    // so neither is "unresolved" and neither can be deduped against) — so
    // this can only be a genuinely new row, not a resurfaced old one.
    const pendingRes4 = await fetch(`${baseUrl}/api/approvals/pending`);
    const pending4 = (await pendingRes4.json()) as PendingApproval[];
    const sendEmailApprovals = pending4.filter((p) => p.actionName === 'gmail:send-email');
    expect(sendEmailApprovals.length).toBe(1);
    expect(sendEmailApprovals[0].id).not.toBe(approvalId1);

    // Clean stop — no dangling handles.
    await raven.stop();
    raven = undefined;
  }, 10000);
});
