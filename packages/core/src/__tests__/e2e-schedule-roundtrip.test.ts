import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRaven, type RavenInstance } from '../raven.ts';
import type { AppConfig } from '../config.ts';
import type { AgentBackend, BackendOptions } from '../agent-manager/agent-backend.ts';
import type { NotificationDeliverEvent } from '@raven/shared';

/**
 * E2E schedule round-trip over the real composition root: createRaven ->
 * start -> trigger a real template (the REST route templates.ts already
 * exposes: POST /api/templates/:name/trigger -> templateScheduler
 * .triggerTemplate, no new RavenInstance surface needed) -> the task
 * execution engine drives every `agent`-type task through the real
 * execution bridge -> agent manager -> agent-session -> the injected fake
 * backend -> tree reaches `completed` -> the template's `notify`-type task
 * emits a real event.
 *
 * Uses the real morning-digest.yaml template from projects/templates/
 * (fetch-tasks -> ticktick agent, fetch-emails -> gmail agent, compile-digest
 * -> digest agent, then a `notify` task) — TemplateRegistry.load resolves
 * projects/ from `projectRoot`, not from the dataDir override (see
 * raven.ts's `projectsDir` construction), so createRaven always loads the
 * real templates/agents on disk regardless of the temp dataDir used for
 * db/logs/sessions here.
 *
 * The `notify` task type does NOT emit a `notification` event — reading
 * task-execution-engine.ts's executeNotifyTask shows it emits
 * `notification:deliver` directly (the plain `notification` event is a
 * different, higher-level type used elsewhere — e.g. raven.ts's
 * task:created/task:completed handler, retrospective). This test asserts
 * on the event the runtime actually fires.
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
    RAVEN_CONSOLIDATION_CRON: '0 3 * * 0',
    RAVEN_AUTO_RETROSPECTIVE_ENABLED: true,
  };
}

interface TaskTreeTaskView {
  id: string;
  type: string;
  status: string;
  agent?: string;
}

interface TaskTreeView {
  id: string;
  status: string;
  tasks: TaskTreeTaskView[];
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

/** Polls the REST endpoint (not an injected engine reference — the tree's
 * completion is observed exactly as a real client would) until the tree
 * reaches a terminal status or the timeout elapses. */
async function pollTreeUntilTerminal(
  baseUrl: string,
  treeId: string,
  timeoutMs = 8000,
): Promise<TaskTreeView> {
  const start = Date.now();
  const terminal = new Set(['completed', 'failed', 'cancelled']);
  for (;;) {
    const res = await fetch(`${baseUrl}/api/task-trees/${treeId}`);
    expect(res.status).toBe(200);
    const tree = (await res.json()) as TaskTreeView;
    if (terminal.has(tree.status)) return tree;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Tree ${treeId} did not reach a terminal status within ${String(timeoutMs)}ms (status: ${tree.status})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('e2e: schedule round-trip over the real composition root', () => {
  let tmpDir: string | undefined;
  let raven: RavenInstance | undefined;

  afterEach(async () => {
    if (raven) await raven.stop();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    raven = undefined;
    tmpDir = undefined;
  });

  it('triggering morning-digest dispatches every agent step to the fake backend, completes the tree, and emits a notification', async () => {
    const calls: BackendOptions[] = [];
    const fakeBackend: AgentBackend = async (opts) => {
      calls.push(opts);
      opts.onAssistantMessage('done');
      return { result: 'ok', success: true, errors: [] };
    };

    tmpDir = mkdtempSync(join(tmpdir(), 'raven-e2e-schedule-'));
    const dbPath = join(tmpDir, 'test.db');

    raven = await createRaven(buildTestConfig(), {
      dbPath,
      dataDir: tmpDir,
      agentBackend: fakeBackend,
      skipSuites: true,
    });
    await raven.start();

    const notifications: NotificationDeliverEvent[] = [];
    raven.eventBus.on<NotificationDeliverEvent>('notification:deliver', (e) => {
      notifications.push(e);
    });

    const baseUrl = `http://localhost:${String(raven.port)}`;

    const triggerRes = await fetch(`${baseUrl}/api/templates/morning-digest/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ params: {} }),
    });
    expect(triggerRes.status).toBe(202);
    const { treeId } = (await triggerRes.json()) as { treeId: string };
    expect(treeId).toBeTruthy();

    await waitFor(() => calls.length >= 3);

    const tree = await pollTreeUntilTerminal(baseUrl, treeId);

    expect(tree.status).toBe('completed');

    const agentTasks = tree.tasks.filter((t) => t.type === 'agent');
    expect(agentTasks).toHaveLength(3);
    expect(agentTasks.every((t) => t.status === 'completed')).toBe(true);
    expect(agentTasks.map((t) => t.agent).sort()).toEqual(['digest', 'gmail', 'ticktick']);

    const notifyTask = tree.tasks.find((t) => t.type === 'notify');
    expect(notifyTask?.status).toBe('completed');

    // Every agent-type task was genuinely dispatched to the fake backend
    // (not just resolved via the raven MCP's own complete_task tool).
    expect(calls.length).toBe(3);

    // The template's `notify` task fired a real notification:deliver event.
    expect(notifications.length).toBeGreaterThanOrEqual(1);
    expect(notifications[0].payload.channel).toBe('telegram');
    expect(notifications[0].payload.body).toContain('digest');

    await raven.stop();
    raven = undefined;
  }, 15000);
});
