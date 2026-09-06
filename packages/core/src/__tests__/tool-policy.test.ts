import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, getDb } from '../db/database.ts';
import { createAuditLog } from '../permission-engine/audit-log.ts';
import { createPendingApprovals } from '../permission-engine/pending-approvals.ts';
import { createToolPolicy } from '../permission-engine/tool-policy.ts';
import type { ToolPolicyDeps, ToolPolicyTaskContext } from '../permission-engine/tool-policy.ts';
import type {
  PermissionEngine,
  ActionCatalogEntry,
} from '../permission-engine/permission-engine.ts';
import type { AuditLog } from '../permission-engine/audit-log.ts';
import type { PendingApprovals } from '../permission-engine/pending-approvals.ts';
import { EventBus } from '../event-bus/event-bus.ts';
import type { CapabilityLibrary } from '../capability-library/capability-library.ts';
import type { BashAccess, PermissionTier, RavenEvent } from '@raven/shared';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';

function makeFakePermissionEngine(
  tierMap: Record<string, PermissionTier>,
  knownActionNames: string[] = Object.keys(tierMap),
): PermissionEngine {
  return {
    initialize: () => undefined,
    resolveTier: (actionName: string) => tierMap[actionName] ?? 'red',
    getActionCatalog: (): ActionCatalogEntry[] =>
      knownActionNames.map((name) => ({
        name,
        tier: tierMap[name] ?? 'red',
        source: 'library' as const,
      })),
    shutdown: () => undefined,
    getConfig: () => ({}),
  };
}

interface FakeSkill {
  name: string;
  mcps: string[];
  actions: Array<{ defaultTier: PermissionTier }>;
}

// CanUseTool's third parameter carries SDK-internal fields (signal,
// toolUseID, ...) that the policy under test never reads — a minimal stub
// satisfies the type without pulling in real SDK machinery.
const FAKE_CAN_USE_TOOL_OPTIONS = {
  signal: new AbortController().signal,
  toolUseID: 'test-tool-use',
  requestId: 'test-request-id',
};

// CanUseTool's return type is `PermissionResult | null` (SDK 0.3.x reserves
// null for callers that answer the permission request out-of-band). Raven's
// tool policy never does that — it always returns a real result, see
// tool-policy.ts — so tests assert that once here instead of a null check
// at every call site below.
async function callPolicy(
  policy: CanUseTool,
  toolName: string,
  input: Record<string, unknown>,
): Promise<PermissionResult> {
  const result = await policy(toolName, input, FAKE_CAN_USE_TOOL_OPTIONS);
  if (result === null) {
    throw new Error('expected a non-null PermissionResult from the tool policy under test');
  }
  return result;
}

function makeFakeCapabilityLibrary(skills: FakeSkill[]): CapabilityLibrary {
  const fake = {
    getSkillNames: () => skills.map((s) => s.name),
    getSkill: (name: string) => {
      const skill = skills.find((s) => s.name === name);
      return skill ? { config: { mcps: skill.mcps, actions: skill.actions } } : undefined;
    },
  };
  return fake as unknown as CapabilityLibrary;
}

const FULL_BASH_ACCESS: BashAccess = {
  access: 'full',
  allowedCommands: [],
  deniedCommands: [],
  allowedPaths: [],
  deniedPaths: [],
};

const NONE_BASH_ACCESS: BashAccess = {
  access: 'none',
  allowedCommands: [],
  deniedCommands: [],
  allowedPaths: [],
  deniedPaths: [],
};

describe('createToolPolicy', () => {
  let tmpDir: string;
  let auditLog: AuditLog;
  let pendingApprovals: PendingApprovals;
  let eventBus: EventBus;
  let events: RavenEvent[];

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tool-policy-'));
    initDatabase(join(tmpDir, 'test.db'));
    auditLog = createAuditLog(getDb());
    auditLog.initialize();
    pendingApprovals = createPendingApprovals(getDb());
    pendingApprovals.initialize();
  });

  afterAll(() => {
    try {
      getDb().close();
    } catch {
      /* already closed */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    eventBus = new EventBus();
    events = [];
    eventBus.on('*', (event) => events.push(event));
  });

  function baseDeps(overrides: Partial<ToolPolicyDeps> = {}): ToolPolicyDeps {
    return {
      permissionEngine: makeFakePermissionEngine({}),
      auditLog,
      pendingApprovals,
      eventBus,
      ...overrides,
    };
  }

  function baseTask(overrides: Partial<ToolPolicyTaskContext> = {}): ToolPolicyTaskContext {
    return { skillName: 'test-skill', sessionId: 'sess-1', ...overrides };
  }

  describe('Bash', () => {
    it('allows a command permitted by bashAccess and audits it green/executed', async () => {
      const deps = baseDeps();
      const task = baseTask({ bashAccess: FULL_BASH_ACCESS });
      const policy = createToolPolicy(deps, task);

      const result = await callPolicy(policy, 'Bash', { command: 'echo hello' });
      expect(result.behavior).toBe('allow');

      const entries = auditLog.query({ skillName: 'test-skill', outcome: 'executed' });
      expect(
        entries.some((e) => e.actionName === 'bash:echo' && e.permissionTier === 'green'),
      ).toBe(true);
    });

    it('denies a command blocked by bashAccess and audits it red/denied', async () => {
      const deps = baseDeps();
      const task = baseTask({ bashAccess: NONE_BASH_ACCESS });
      const policy = createToolPolicy(deps, task);

      const result = await callPolicy(policy, 'Bash', { command: 'ls -la' });
      expect(result.behavior).toBe('deny');
      if (result.behavior === 'deny') {
        expect(result.message).toContain('Bash access is disabled');
      }

      const entries = auditLog.query({ skillName: 'test-skill', outcome: 'denied' });
      expect(entries.some((e) => e.actionName === 'bash:ls' && e.permissionTier === 'red')).toBe(
        true,
      );
    });

    it('defaults to none (deny) when the task has no bashAccess at all', async () => {
      const deps = baseDeps();
      const task = baseTask();
      const policy = createToolPolicy(deps, task);

      const result = await callPolicy(policy, 'Bash', { command: 'whoami' });
      expect(result.behavior).toBe('deny');
    });

    it('does not queue a pending approval for a denied Bash command', async () => {
      const deps = baseDeps();
      const task = baseTask({ bashAccess: NONE_BASH_ACCESS, sessionId: 'sess-bash-noqueue' });
      const policy = createToolPolicy(deps, task);

      await callPolicy(policy, 'Bash', { command: 'rm -rf /' });

      const approvals = pendingApprovals.query();
      expect(approvals.some((a) => a.sessionId === 'sess-bash-noqueue')).toBe(false);
    });
  });

  describe('raven/memory MCP tools', () => {
    it('always allows mcp__raven__* without auditing or emitting events', async () => {
      const deps = baseDeps();
      const task = baseTask();
      const policy = createToolPolicy(deps, task);

      const before = auditLog.query({ skillName: 'test-skill' }).length;
      const result = await callPolicy(policy, 'mcp__raven__create_task', {});

      expect(result.behavior).toBe('allow');
      expect(auditLog.query({ skillName: 'test-skill' }).length).toBe(before);
      expect(events).toHaveLength(0);
    });

    it('always allows mcp__memory__*', async () => {
      const deps = baseDeps();
      const task = baseTask();
      const policy = createToolPolicy(deps, task);

      const result = await callPolicy(policy, 'mcp__memory__write_note', {});
      expect(result.behavior).toBe('allow');
    });
  });

  describe('integration MCP tools — known action mapping', () => {
    it('green tier: allows and audits executed, no event', async () => {
      const deps = baseDeps({
        permissionEngine: makeFakePermissionEngine({ 'ticktick:get-tasks': 'green' }),
      });
      const task = baseTask({ skillName: 'ticktick', sessionId: 'sess-green' });
      const policy = createToolPolicy(deps, task);

      const result = await callPolicy(policy, 'mcp__ticktick__get_tasks', {});
      expect(result.behavior).toBe('allow');

      const entries = auditLog.query({ sessionId: 'sess-green' });
      expect(
        entries.some((e) => e.actionName === 'ticktick:get-tasks' && e.outcome === 'executed'),
      ).toBe(true);
      expect(events.filter((e) => e.type.startsWith('permission:'))).toHaveLength(0);
    });

    it('yellow tier: allows, audits executed, and emits permission:approved', async () => {
      const deps = baseDeps({
        permissionEngine: makeFakePermissionEngine({ 'ticktick:create-task': 'yellow' }),
      });
      const task = baseTask({ skillName: 'ticktick', sessionId: 'sess-yellow' });
      const policy = createToolPolicy(deps, task);

      const result = await callPolicy(policy, 'mcp__ticktick__create_task', {});
      expect(result.behavior).toBe('allow');

      const approvedEvents = events.filter((e) => e.type === 'permission:approved');
      expect(approvedEvents).toHaveLength(1);
      const payload = (approvedEvents[0] as { payload: Record<string, unknown> }).payload;
      expect(payload.actionName).toBe('ticktick:create-task');
      expect(payload.tier).toBe('yellow');
    });

    it('red tier: denies, audits queued, inserts a pending approval, and emits permission:blocked', async () => {
      const deps = baseDeps({
        permissionEngine: makeFakePermissionEngine({ 'gmail:send-email': 'red' }),
      });
      const task = baseTask({ skillName: 'gmail', sessionId: 'sess-red' });
      const policy = createToolPolicy(deps, task);

      const result = await callPolicy(policy, 'mcp__gmail__send_email', { to: 'a@b.com' });
      expect(result.behavior).toBe('deny');
      if (result.behavior === 'deny') {
        expect(result.message).toMatch(/Queued for approval \(id .+\)/);
      }

      // Integration test: policy denial -> audit row.
      const queuedEntries = auditLog.query({ sessionId: 'sess-red', outcome: 'queued' });
      expect(queuedEntries.some((e) => e.actionName === 'gmail:send-email')).toBe(true);

      const approvals = pendingApprovals.query();
      const approval = approvals.find((a) => a.sessionId === 'sess-red');
      expect(approval).toBeDefined();
      expect(approval?.actionName).toBe('gmail:send-email');

      const blockedEvents = events.filter((e) => e.type === 'permission:blocked');
      expect(blockedEvents).toHaveLength(1);
      const payload = (blockedEvents[0] as { payload: Record<string, unknown> }).payload;
      expect(payload.approvalId).toBe(approval?.id);
    });

    it('maps all 48 confirmed official TickTick tools to their declared action tiers', async () => {
      const skill = JSON.parse(
        readFileSync(
          new URL(
            '../../../../library/skills/productivity/task-management/ticktick/config.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ) as { actions: Array<{ name: string; defaultTier: PermissionTier }> };
      expect(skill.actions).toHaveLength(48);
      const tiers = Object.fromEntries(
        skill.actions.map((action) => [action.name, action.defaultTier]),
      ) as Record<string, PermissionTier>;
      const deps = baseDeps({ permissionEngine: makeFakePermissionEngine(tiers) });
      const sessionId = 'sess-official-ticktick-catalog';
      const policy = createToolPolicy(deps, baseTask({ skillName: 'ticktick', sessionId }));

      for (const action of skill.actions) {
        const tool = action.name.slice('ticktick:'.length).replaceAll('-', '_');
        const result = await callPolicy(policy, `mcp__ticktick__${tool}`, {});
        expect(result.behavior).toBe(action.defaultTier === 'red' ? 'deny' : 'allow');
      }

      const audited = auditLog.query({ sessionId });
      expect(audited).toHaveLength(48);
      for (const action of skill.actions) {
        expect(audited).toContainEqual(
          expect.objectContaining({
            actionName: action.name,
            permissionTier: action.defaultTier,
            outcome: action.defaultTier === 'red' ? 'queued' : 'executed',
          }),
        );
      }
      expect(events.filter((event) => event.type === 'permission:approved')).toHaveLength(21);
      expect(events.filter((event) => event.type === 'permission:blocked')).toHaveLength(4);
    });
  });

  describe('integration MCP tools — unmapped tool name fallback', () => {
    it('falls back to the max declared tier of skills owning the server (red)', async () => {
      const capabilityLibrary = makeFakeCapabilityLibrary([
        {
          name: 'ticktick',
          mcps: ['ticktick'],
          actions: [{ defaultTier: 'green' }, { defaultTier: 'yellow' }, { defaultTier: 'red' }],
        },
      ]);
      const deps = baseDeps({
        permissionEngine: makeFakePermissionEngine({}, []),
        capabilityLibrary,
      });
      const task = baseTask({ skillName: 'ticktick' });
      const policy = createToolPolicy(deps, task);

      // get_all_tasks has no declared ticktick:* action counterpart.
      const result = await callPolicy(policy, 'mcp__ticktick__get_all_tasks', {});
      expect(result.behavior).toBe('deny');
    });

    it('falls back to the max declared tier of skills owning the server (yellow, no red action)', async () => {
      const capabilityLibrary = makeFakeCapabilityLibrary([
        {
          name: 'docs',
          mcps: ['markdownify'],
          actions: [{ defaultTier: 'green' }, { defaultTier: 'yellow' }],
        },
      ]);
      const deps = baseDeps({
        permissionEngine: makeFakePermissionEngine({}, []),
        capabilityLibrary,
      });
      const task = baseTask({ skillName: 'docs', sessionId: 'sess-fallback-yellow' });
      const policy = createToolPolicy(deps, task);

      const result = await callPolicy(policy, 'mcp__markdownify__convert', {});
      expect(result.behavior).toBe('allow');
      expect(events.filter((e) => e.type === 'permission:approved')).toHaveLength(1);
    });

    it('falls back to yellow when no capabilityLibrary is provided at all', async () => {
      const deps = baseDeps({ permissionEngine: makeFakePermissionEngine({}, []) });
      const task = baseTask({ skillName: 'unknown-skill' });
      const policy = createToolPolicy(deps, task);

      const result = await callPolicy(policy, 'mcp__unknown-server__do_something', {});
      expect(result.behavior).toBe('allow');
    });

    it('falls back to yellow when no skill references the MCP server', async () => {
      const capabilityLibrary = makeFakeCapabilityLibrary([
        { name: 'gmail', mcps: ['gmail'], actions: [{ defaultTier: 'red' }] },
      ]);
      const deps = baseDeps({
        permissionEngine: makeFakePermissionEngine({}, []),
        capabilityLibrary,
      });
      const task = baseTask({ skillName: 'orphan' });
      const policy = createToolPolicy(deps, task);

      const result = await callPolicy(policy, 'mcp__orphan-server__do_something', {});
      expect(result.behavior).toBe('allow');
    });
  });

  describe('approvedActionName loop-closure', () => {
    it('allows a red-tier action directly when it matches task.approvedActionName', async () => {
      const deps = baseDeps({
        permissionEngine: makeFakePermissionEngine({ 'gmail:send-email': 'red' }),
      });
      const task = baseTask({
        skillName: 'gmail',
        sessionId: 'sess-approved',
        approvedActionName: 'gmail:send-email',
      });
      const policy = createToolPolicy(deps, task);

      const result = await callPolicy(policy, 'mcp__gmail__send_email', { to: 'a@b.com' });
      expect(result.behavior).toBe('allow');

      // No new pending approval queued for the pre-approved re-run.
      const approvals = pendingApprovals.query();
      expect(approvals.some((a) => a.sessionId === 'sess-approved')).toBe(false);

      const entries = auditLog.query({ sessionId: 'sess-approved', outcome: 'executed' });
      expect(entries.some((e) => e.actionName === 'gmail:send-email')).toBe(true);
    });

    it('does not bypass tiering for a different action than the approved one', async () => {
      const deps = baseDeps({
        permissionEngine: makeFakePermissionEngine({ 'gmail:send-email': 'red' }),
      });
      const task = baseTask({
        skillName: 'gmail',
        approvedActionName: 'gmail:delete-email', // a different action was approved
      });
      const policy = createToolPolicy(deps, task);

      const result = await callPolicy(policy, 'mcp__gmail__send_email', { to: 'a@b.com' });
      expect(result.behavior).toBe('deny');
    });
  });

  describe('everything else', () => {
    it('allows base tools (Read, Glob, TodoWrite) without auditing', async () => {
      const deps = baseDeps();
      const task = baseTask();
      const policy = createToolPolicy(deps, task);

      for (const toolName of ['Read', 'Glob', 'TodoWrite']) {
        const before = auditLog.query({ skillName: 'test-skill' }).length;
        const result = await callPolicy(policy, toolName, {});
        expect(result.behavior).toBe('allow');
        expect(auditLog.query({ skillName: 'test-skill' }).length).toBe(before);
      }
    });

    it('echoes the tool input back as updatedInput on allow (SDK runtime requires it)', async () => {
      const deps = baseDeps();
      const task = baseTask();
      const policy = createToolPolicy(deps, task);

      const result = await callPolicy(policy, 'Read', { file_path: '/x.ts' });
      expect(result).toEqual({ behavior: 'allow', updatedInput: { file_path: '/x.ts' } });
    });
  });

  // H2: Write/Edit/MultiEdit/NotebookEdit used to reach the "everything
  // else" catch-all above and execute completely ungated, regardless of
  // task.bashAccess. They're now gated with the same access/path semantics
  // bash-gate.ts applies to Bash.
  describe('file-writing tools (Write/Edit/MultiEdit/NotebookEdit)', () => {
    it('denies and audits when bashAccess is none (including the default when unset)', async () => {
      const deps = baseDeps();
      const task = baseTask();
      const policy = createToolPolicy(deps, task);

      const result = await callPolicy(policy, 'Write', { file_path: '/tmp/x.ts' });
      expect(result.behavior).toBe('deny');

      const entries = auditLog.query({ skillName: 'test-skill', outcome: 'denied' });
      expect(entries.some((e) => e.actionName === 'fs:write' && e.permissionTier === 'red')).toBe(
        true,
      );
    });

    it('allows and audits executed when bashAccess is full', async () => {
      const deps = baseDeps();
      const task = baseTask({ bashAccess: FULL_BASH_ACCESS });
      const policy = createToolPolicy(deps, task);

      const result = await callPolicy(policy, 'Edit', { file_path: '/tmp/x.ts' });
      expect(result.behavior).toBe('allow');

      const entries = auditLog.query({ skillName: 'test-skill', outcome: 'executed' });
      expect(entries.some((e) => e.actionName === 'fs:edit' && e.permissionTier === 'green')).toBe(
        true,
      );
    });

    it('scoped: allows a path matching allowedPaths', async () => {
      const deps = baseDeps();
      const task = baseTask({
        bashAccess: {
          access: 'scoped',
          allowedCommands: [],
          deniedCommands: [],
          allowedPaths: ['/workspace/**'],
          deniedPaths: [],
        },
      });
      const policy = createToolPolicy(deps, task);

      const result = await callPolicy(policy, 'Write', { file_path: '/workspace/notes.md' });
      expect(result.behavior).toBe('allow');
    });

    it('scoped: denies a path not matching allowedPaths', async () => {
      const deps = baseDeps();
      const task = baseTask({
        bashAccess: {
          access: 'scoped',
          allowedCommands: [],
          deniedCommands: [],
          allowedPaths: ['/workspace/**'],
          deniedPaths: [],
        },
      });
      const policy = createToolPolicy(deps, task);

      const result = await callPolicy(policy, 'Write', { file_path: '/etc/passwd' });
      expect(result.behavior).toBe('deny');
      if (result.behavior === 'deny') {
        expect(result.message).toContain('not in the allowed paths');
      }
    });

    it('scoped: deniedPaths takes precedence over an otherwise-matching allowedPaths', async () => {
      const deps = baseDeps();
      const task = baseTask({
        bashAccess: {
          access: 'scoped',
          allowedCommands: [],
          deniedCommands: [],
          allowedPaths: ['/workspace/**'],
          deniedPaths: ['/workspace/secrets/**'],
        },
      });
      const policy = createToolPolicy(deps, task);

      const result = await callPolicy(policy, 'Edit', {
        file_path: '/workspace/secrets/api-key.txt',
      });
      expect(result.behavior).toBe('deny');
    });

    it('sandboxed: applies the same path rules as scoped', async () => {
      const deps = baseDeps();
      const task = baseTask({
        bashAccess: {
          access: 'sandboxed',
          allowedCommands: [],
          deniedCommands: [],
          allowedPaths: ['/workspace/**'],
          deniedPaths: [],
        },
      });
      const policy = createToolPolicy(deps, task);

      const result = await callPolicy(policy, 'MultiEdit', { file_path: '/other/x.ts' });
      expect(result.behavior).toBe('deny');
    });

    it('resolves NotebookEdit paths from notebook_path, not file_path', async () => {
      const deps = baseDeps();
      const task = baseTask({
        bashAccess: {
          access: 'scoped',
          allowedCommands: [],
          deniedCommands: [],
          allowedPaths: ['/workspace/**'],
          deniedPaths: [],
        },
      });
      const policy = createToolPolicy(deps, task);

      const result = await callPolicy(policy, 'NotebookEdit', {
        notebook_path: '/workspace/analysis.ipynb',
      });
      expect(result.behavior).toBe('allow');
    });
  });

  // M9: approvals must carry the tool's actual arguments so a post-approval
  // re-dispatch has them, with sensitive-looking keys redacted.
  describe('M9: approval details carry tool arguments', () => {
    it('includes the (redacted) tool arguments in the pending approval details', async () => {
      const deps = baseDeps({
        permissionEngine: makeFakePermissionEngine({ 'gmail:send-email': 'red' }),
      });
      const task = baseTask({ skillName: 'gmail', sessionId: 'sess-m9-args' });
      const policy = createToolPolicy(deps, task);

      await callPolicy(policy, 'mcp__gmail__send_email', {
        to: 'a@b.com',
        apiKey: 'sk-super-secret',
        body: 'hello',
      });

      const approval = pendingApprovals.query().find((a) => a.sessionId === 'sess-m9-args');
      expect(approval?.details).toContain('a@b.com');
      expect(approval?.details).toContain('[REDACTED]');
      expect(approval?.details).not.toContain('sk-super-secret');
    });
  });

  // M8: repeated attempts at the same still-blocked action within a session
  // must dedup into one pending row instead of spamming approvals/events.
  describe('M8: pending-approval dedup', () => {
    it('reuses the existing unresolved approval id on a repeated attempt, without a second permission:blocked event', async () => {
      const deps = baseDeps({
        permissionEngine: makeFakePermissionEngine({ 'gmail:send-email': 'red' }),
      });
      const task = baseTask({ skillName: 'gmail', sessionId: 'sess-m8-dedup' });
      const policy = createToolPolicy(deps, task);

      const first = await callPolicy(policy, 'mcp__gmail__send_email', { to: 'a@b.com' });
      const second = await callPolicy(policy, 'mcp__gmail__send_email', { to: 'a@b.com' });

      expect(first.behavior).toBe('deny');
      expect(second.behavior).toBe('deny');

      const approvalsForSession = pendingApprovals
        .query()
        .filter((a) => a.sessionId === 'sess-m8-dedup');
      expect(approvalsForSession).toHaveLength(1);

      const blockedEvents = events.filter(
        (e) =>
          e.type === 'permission:blocked' &&
          (e as { payload: { sessionId?: string } }).payload.sessionId === 'sess-m8-dedup',
      );
      expect(blockedEvents).toHaveLength(1);
    });
  });
});
