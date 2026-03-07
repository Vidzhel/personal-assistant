import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';

// Mock claude-code SDK and config — hoisted by Vitest, applies to all tests
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn().mockImplementation(async function* () {
    yield { type: 'result', subtype: 'success', result: 'test result' };
  }),
}));

vi.mock('../config.ts', () => ({
  getConfig: () => ({
    ANTHROPIC_API_KEY: 'test-key',
    CLAUDE_MODEL: 'test-model',
    RAVEN_AGENT_MAX_TURNS: 10,
  }),
}));

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { initDatabase, getDb } from '../db/database.ts';
import { createAuditLog } from '../permission-engine/audit-log.ts';
import { createPendingApprovals } from '../permission-engine/pending-approvals.ts';
import { enforcePermissionGate, runAgentTask } from '../agent-manager/agent-session.ts';
import type { PermissionDeps } from '../agent-manager/agent-session.ts';
import type { PermissionEngine } from '../permission-engine/permission-engine.ts';
import { EventBus } from '../event-bus/event-bus.ts';
import type { PermissionTier, RavenEvent } from '@raven/shared';

describe('Pending Approvals', () => {
  let tmpDir: string;
  let pendingApprovals: ReturnType<typeof createPendingApprovals>;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pending-approvals-'));
    initDatabase(join(tmpDir, 'test.db'));
    pendingApprovals = createPendingApprovals(getDb());
    pendingApprovals.initialize();
  });

  afterAll(() => {
    try {
      getDb().close();
    } catch {
      /* */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('initializes and verifies table exists', () => {
    expect(() => pendingApprovals.initialize()).not.toThrow();
  });

  it('inserts a pending approval with auto-generated id and requestedAt', () => {
    const approval = pendingApprovals.insert({
      actionName: 'gmail:send-email',
      skillName: 'gmail',
      details: 'Test approval',
      sessionId: 'sess-1',
    });

    expect(approval.id).toBeDefined();
    expect(approval.requestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(approval.actionName).toBe('gmail:send-email');
    expect(approval.skillName).toBe('gmail');
    expect(approval.details).toBe('Test approval');
    expect(approval.sessionId).toBe('sess-1');
    expect(approval.resolution).toBeUndefined();
    expect(approval.resolvedAt).toBeUndefined();
  });

  it('query returns only unresolved approvals', () => {
    const a1 = pendingApprovals.insert({
      actionName: 'ticktick:delete-task',
      skillName: 'ticktick',
    });

    const results = pendingApprovals.query();
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.id === a1.id)).toBe(true);
    expect(results.every((r) => r.resolution === undefined)).toBe(true);
  });

  it('resolve updates resolution and resolvedAt', () => {
    const approval = pendingApprovals.insert({
      actionName: 'gmail:forward-email',
      skillName: 'gmail',
    });

    const resolved = pendingApprovals.resolve(approval.id, 'approved');
    expect(resolved.resolution).toBe('approved');
    expect(resolved.resolvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Should no longer appear in unresolved query
    const unresolved = pendingApprovals.query();
    expect(unresolved.some((r) => r.id === approval.id)).toBe(false);
  });

  it('resolve with denied works', () => {
    const approval = pendingApprovals.insert({
      actionName: 'gmail:delete-email',
      skillName: 'gmail',
    });

    const resolved = pendingApprovals.resolve(approval.id, 'denied');
    expect(resolved.resolution).toBe('denied');
  });

  it('resolve throws for nonexistent id', () => {
    expect(() => pendingApprovals.resolve('nonexistent-id', 'approved')).toThrow(
      'Pending approval not found',
    );
  });

  it('resolve throws for already-resolved approval', () => {
    const approval = pendingApprovals.insert({
      actionName: 'test:double-resolve',
      skillName: 'test',
    });
    pendingApprovals.resolve(approval.id, 'approved');
    expect(() => pendingApprovals.resolve(approval.id, 'denied')).toThrow('already resolved');
  });

  it('query returns results ordered by requestedAt ASC', () => {
    const results = pendingApprovals.query();
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].requestedAt <= results[i].requestedAt).toBe(true);
    }
  });
});

describe('Permission Gate', () => {
  let tmpDir: string;
  let auditLog: ReturnType<typeof createAuditLog>;
  let pendingApprovals: ReturnType<typeof createPendingApprovals>;
  let eventBus: EventBus;
  let events: RavenEvent[];

  function createMockPermissionEngine(tierMap: Record<string, PermissionTier>): PermissionEngine {
    return {
      initialize: vi.fn(),
      resolveTier: (actionName: string) => tierMap[actionName] ?? 'red',
      shutdown: vi.fn(),
      getConfig: vi.fn().mockReturnValue({}),
    };
  }

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'permission-gate-'));
    initDatabase(join(tmpDir, 'test.db'));
    auditLog = createAuditLog(getDb());
    auditLog.initialize();
    pendingApprovals = createPendingApprovals(getDb());
    pendingApprovals.initialize();
  });

  beforeEach(() => {
    eventBus = new EventBus();
    events = [];
    eventBus.on('*', (event) => {
      events.push(event);
    });
  });

  afterAll(() => {
    try {
      getDb().close();
    } catch {
      /* */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('green tier: allows execution, writes audit entry, no event emitted', () => {
    const engine = createMockPermissionEngine({ 'ticktick:get-tasks': 'green' });
    const deps: PermissionDeps & { eventBus: EventBus } = {
      permissionEngine: engine,
      auditLog,
      pendingApprovals,
      eventBus,
    };

    const result = enforcePermissionGate('ticktick:get-tasks', deps, {
      skillName: 'ticktick',
      sessionId: 'sess-g',
    });

    expect(result.allowed).toBe(true);
    expect(result.tier).toBe('green');

    // Audit entry written
    const entries = auditLog.query({ outcome: 'executed', skillName: 'ticktick' });
    expect(entries.some((e) => e.sessionId === 'sess-g')).toBe(true);

    // No permission events
    expect(events.filter((e) => e.type.startsWith('permission:'))).toHaveLength(0);
  });

  it('yellow tier: allows execution, writes audit entry, emits permission:approved event', () => {
    const engine = createMockPermissionEngine({ 'gmail:archive-email': 'yellow' });
    const deps: PermissionDeps & { eventBus: EventBus } = {
      permissionEngine: engine,
      auditLog,
      pendingApprovals,
      eventBus,
    };

    const result = enforcePermissionGate('gmail:archive-email', deps, {
      skillName: 'gmail',
      sessionId: 'sess-y',
    });

    expect(result.allowed).toBe(true);
    expect(result.tier).toBe('yellow');

    // Audit entry written
    const entries = auditLog.query({ outcome: 'executed', skillName: 'gmail' });
    expect(entries.some((e) => e.sessionId === 'sess-y')).toBe(true);

    // permission:approved event emitted
    const permEvents = events.filter((e) => e.type === 'permission:approved');
    expect(permEvents).toHaveLength(1);
    const payload = (permEvents[0] as any).payload;
    expect(payload.actionName).toBe('gmail:archive-email');
    expect(payload.skillName).toBe('gmail');
    expect(payload.tier).toBe('yellow');
  });

  it('red tier: blocks execution, writes audit with queued, inserts pending approval, emits permission:blocked', () => {
    const engine = createMockPermissionEngine({ 'gmail:send-email': 'red' });
    const deps: PermissionDeps & { eventBus: EventBus } = {
      permissionEngine: engine,
      auditLog,
      pendingApprovals,
      eventBus,
    };

    const result = enforcePermissionGate('gmail:send-email', deps, {
      skillName: 'gmail',
      sessionId: 'sess-r',
    });

    expect(result.allowed).toBe(false);
    expect(result.tier).toBe('red');
    expect(result.reason).toBe('queued-for-approval');

    // Audit entry with outcome: queued
    const entries = auditLog.query({ outcome: 'queued', skillName: 'gmail' });
    expect(entries.some((e) => e.sessionId === 'sess-r')).toBe(true);

    // Pending approval inserted
    const approvals = pendingApprovals.query();
    expect(approvals.some((a) => a.sessionId === 'sess-r')).toBe(true);

    // permission:blocked event emitted
    const permEvents = events.filter((e) => e.type === 'permission:blocked');
    expect(permEvents.length).toBeGreaterThanOrEqual(1);
    const payload = (permEvents[permEvents.length - 1] as any).payload;
    expect(payload.actionName).toBe('gmail:send-email');
    expect(payload.skillName).toBe('gmail');
    expect(payload.tier).toBe('red');
    expect(payload.approvalId).toBeDefined();
  });

  it('undeclared action: defaults to red tier, follows red behavior', () => {
    const engine = createMockPermissionEngine({}); // empty map → resolveTier returns 'red'
    const deps: PermissionDeps & { eventBus: EventBus } = {
      permissionEngine: engine,
      auditLog,
      pendingApprovals,
      eventBus,
    };

    const result = enforcePermissionGate('unknown:undeclared', deps, {
      skillName: 'unknown',
      sessionId: 'sess-u',
    });

    expect(result.allowed).toBe(false);
    expect(result.tier).toBe('red');
    expect(result.reason).toBe('queued-for-approval');

    // Pending approval for undeclared action
    const approvals = pendingApprovals.query();
    expect(
      approvals.some((a) => a.actionName === 'unknown:undeclared' && a.sessionId === 'sess-u'),
    ).toBe(true);
  });

  it('backward compat: when permissionDeps not provided, agent executes normally', async () => {
    vi.mocked(query).mockClear();

    const task = {
      id: 'task-compat',
      skillName: 'ticktick',
      prompt: 'test prompt',
      status: 'running' as const,
      priority: 'normal' as const,
      mcpServers: {},
      agentDefinitions: {},
      createdAt: Date.now(),
    };

    const result = await runAgentTask({
      task,
      eventBus,
      mcpServers: {},
      agentDefinitions: {},
    });

    expect(result.taskId).toBe('task-compat');
    expect(result.success).toBe(true);
    expect(result.blocked).toBeUndefined();
  });

  it('runAgentTask with permissionDeps but no actionName: skips gating, executes', async () => {
    vi.mocked(query).mockClear();
    const engine = createMockPermissionEngine({});

    const task = {
      id: 'task-no-action',
      skillName: 'ticktick',
      prompt: 'test prompt',
      status: 'running' as const,
      priority: 'normal' as const,
      mcpServers: {},
      agentDefinitions: {},
      createdAt: Date.now(),
    };

    const result = await runAgentTask({
      task,
      eventBus,
      mcpServers: {},
      agentDefinitions: {},
      permissionDeps: { permissionEngine: engine, auditLog, pendingApprovals },
    });

    expect(result.success).toBe(true);
    expect(result.blocked).toBeUndefined();
    expect(vi.mocked(query)).toHaveBeenCalled();
  });

  it('runAgentTask with red-tier action: blocks without calling SDK query', async () => {
    vi.mocked(query).mockClear();
    const engine = createMockPermissionEngine({ 'gmail:send-email': 'red' });

    const task = {
      id: 'task-blocked',
      skillName: 'gmail',
      prompt: 'send an email',
      status: 'running' as const,
      priority: 'normal' as const,
      mcpServers: {},
      agentDefinitions: {},
      createdAt: Date.now(),
    };

    const result = await runAgentTask({
      task,
      eventBus,
      mcpServers: {},
      agentDefinitions: {},
      actionName: 'gmail:send-email',
      permissionDeps: { permissionEngine: engine, auditLog, pendingApprovals },
    });

    expect(result.success).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.errors).toContain('queued-for-approval');
    expect(vi.mocked(query)).not.toHaveBeenCalled();
  });

  it('runAgentTask with green-tier action: executes via SDK query', async () => {
    vi.mocked(query).mockClear();
    const engine = createMockPermissionEngine({ 'ticktick:get-tasks': 'green' });

    const task = {
      id: 'task-green',
      skillName: 'ticktick',
      prompt: 'get tasks',
      status: 'running' as const,
      priority: 'normal' as const,
      mcpServers: {},
      agentDefinitions: {},
      createdAt: Date.now(),
    };

    const result = await runAgentTask({
      task,
      eventBus,
      mcpServers: {},
      agentDefinitions: {},
      actionName: 'ticktick:get-tasks',
      permissionDeps: { permissionEngine: engine, auditLog, pendingApprovals },
    });

    expect(result.success).toBe(true);
    expect(result.blocked).toBeUndefined();
    expect(vi.mocked(query)).toHaveBeenCalled();
  });

  it('permission gate with mock engine returning each tier', () => {
    const engine = createMockPermissionEngine({
      'test:green-action': 'green',
      'test:yellow-action': 'yellow',
      'test:red-action': 'red',
    });
    const deps: PermissionDeps & { eventBus: EventBus } = {
      permissionEngine: engine,
      auditLog,
      pendingApprovals,
      eventBus,
    };

    const greenResult = enforcePermissionGate('test:green-action', deps, {
      skillName: 'test',
    });
    expect(greenResult.allowed).toBe(true);
    expect(greenResult.tier).toBe('green');

    const yellowResult = enforcePermissionGate('test:yellow-action', deps, {
      skillName: 'test',
    });
    expect(yellowResult.allowed).toBe(true);
    expect(yellowResult.tier).toBe('yellow');

    const redResult = enforcePermissionGate('test:red-action', deps, {
      skillName: 'test',
    });
    expect(redResult.allowed).toBe(false);
    expect(redResult.tier).toBe('red');
  });
});
