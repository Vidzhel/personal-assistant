import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, cpSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRaven, type RavenInstance } from '../raven.ts';
import type { AppConfig } from '../config.ts';
import type { AgentBackend, BackendOptions } from '../agent-manager/agent-backend.ts';
import {
  generateId,
  type SessionIdleEvent,
  type SessionRetrospectiveCompleteEvent,
} from '@raven/shared';

// Real projects/ tree, copied per-test into a tmp dir — same convention as
// e2e-chat-roundtrip.test.ts, so the real default agent ("raven",
// projects/agents/raven/agent.yaml) and the real memory-consolidation.yaml
// schedule are both present without touching the checked-out repo.
const REAL_PROJECTS_DIR = resolve(import.meta.dirname!, '..', '..', '..', '..', 'projects');

const DEFAULT_AGENT_NAME = 'raven';

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
    RAVEN_HEARTBEAT_ACTIVE_HOURS: '08-22',
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: timed out waiting for condition');
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * E2E memory loop over the real composition root: createRaven -> start ->
 * chat turn (interactive session) -> emit `session:idle` directly (the
 * plan's own sanctioned deterministic drive — real idle-detector timing is
 * a 30-minute wall-clock wait, not something to poll for in a test) ->
 * the real session-retrospective handler wired in raven.ts fires -> a
 * memory candidate file lands on disk -> trigger the real
 * `memory-consolidation` schedule via `POST /api/schedules/:id/trigger`
 * (the same route the dashboard's schedule "run now" button hits) ->
 * MEMORY.md is regenerated and the candidate is archived.
 *
 * One fake backend serves all three agent dispatches (chat turn,
 * retrospective, consolidation) — `runAgentTask`'s active backend is a
 * module-level singleton (agent-session.ts), so createRaven's
 * `agentBackend` override reaches every dispatch regardless of which
 * subsystem issued it. Responses are branched on prompt content since call
 * order alone doesn't self-document which dispatch is which.
 */
describe('e2e: memory loop closed (retrospective -> candidate -> consolidation)', () => {
  let tmpDir: string | undefined;
  let raven: RavenInstance | undefined;

  afterEach(async () => {
    if (raven) await raven.stop();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    raven = undefined;
    tmpDir = undefined;
  });

  it('interactive chat -> retrospective candidate -> consolidation -> MEMORY.md + archive', async () => {
    const fakeBackend: AgentBackend = async (opts: BackendOptions) => {
      if (opts.prompt.includes('session retrospective agent')) {
        const result = JSON.stringify({
          summary: 'Discussed favorite color.',
          decisions: [],
          findings: [],
          actionItems: [],
          candidateBubbles: [],
          memoryCandidates: [
            { title: 'Favorite color', content: "The owner's favorite color is teal." },
          ],
        });
        return { result, success: true, errors: [] };
      }
      if (opts.prompt.includes('memory consolidation agent')) {
        const result = JSON.stringify({
          ops: [
            {
              action: 'create',
              path: 'preferences.md',
              content: "# Preferences\n\nThe owner's favorite color is teal.",
            },
          ],
        });
        return { result, success: true, errors: [] };
      }
      // Chat turn.
      opts.onSessionId?.('sdk-1');
      const replyText = 'Got it, noted your favorite color.';
      opts.onAssistantMessage(replyText);
      return { sessionId: 'sdk-1', result: replyText, success: true, errors: [] };
    };

    tmpDir = mkdtempSync(join(tmpdir(), 'raven-e2e-memory-loop-'));
    const dbPath = join(tmpDir, 'test.db');
    const projectsDir = join(tmpDir, 'projects');
    cpSync(REAL_PROJECTS_DIR, projectsDir, { recursive: true });

    raven = await createRaven(buildTestConfig(), {
      dbPath,
      dataDir: tmpDir,
      projectsDir,
      agentBackend: fakeBackend,
      skipSuites: true,
    });
    await raven.start();

    const baseUrl = `http://localhost:${String(raven.port)}`;

    // ── Interactive chat turn ──────────────────────────────────────
    const projectRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Memory Loop Project' }),
    });
    expect(projectRes.status).toBe(200);
    const project = (await projectRes.json()) as { id: string };

    const sessionRes = await fetch(`${baseUrl}/api/projects/${project.id}/sessions`, {
      method: 'POST',
    });
    expect(sessionRes.status).toBe(200);
    const session = (await sessionRes.json()) as { id: string };

    const chatRes = await fetch(`${baseUrl}/api/projects/${project.id}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'My favorite color is teal.', sessionId: session.id }),
    });
    expect(chatRes.status).toBe(200);

    const chatMessages: string[] = [];
    raven.eventBus.on('agent:message', (e: any) => {
      if (e.payload.messageType === 'assistant') chatMessages.push(e.payload.content);
    });
    await waitFor(() => chatMessages.includes('Got it, noted your favorite color.'));

    // ── Drive the retrospective deterministically ──────────────────
    const retroCompletions: SessionRetrospectiveCompleteEvent[] = [];
    raven.eventBus.on<SessionRetrospectiveCompleteEvent>('session:retrospective:complete', (e) => {
      retroCompletions.push(e);
    });

    const idleEvent: SessionIdleEvent = {
      id: generateId(),
      timestamp: Date.now(),
      source: 'idle-detector',
      projectId: project.id,
      type: 'session:idle',
      payload: { sessionId: session.id, projectId: project.id, idleMinutes: 42 },
    };
    raven.eventBus.emit(idleEvent);

    await waitFor(() => retroCompletions.length >= 1);
    expect(retroCompletions[0].payload.summary).toContain('favorite color');

    // ── Candidate file landed on disk for the default agent ────────
    const candidatesDir = join(projectsDir, 'agents', DEFAULT_AGENT_NAME, 'memory', 'candidates');
    const candidateFiles = readdirSync(candidatesDir).filter((f) => f.endsWith('.md'));
    expect(candidateFiles).toHaveLength(1);
    expect(candidateFiles[0]).toMatch(/favorite-color\.md$/);
    const candidateContent = readFileSync(join(candidatesDir, candidateFiles[0]), 'utf-8');
    expect(candidateContent).toContain('teal');
    expect(candidateContent).toContain('status: pending');

    // ── Trigger the real memory-consolidation schedule over HTTP ───
    const triggerRes = await fetch(`${baseUrl}/api/schedules/memory-consolidation/trigger`, {
      method: 'POST',
    });
    expect(triggerRes.status).toBe(200);
    expect(await triggerRes.json()).toEqual({ triggered: true });

    // ── MEMORY.md regenerated + candidate archived ──────────────────
    const memoryDir = join(projectsDir, 'agents', DEFAULT_AGENT_NAME, 'memory');
    const memoryMd = readFileSync(join(memoryDir, 'MEMORY.md'), 'utf-8');
    expect(memoryMd).toContain('preferences.md');

    const preferences = readFileSync(join(memoryDir, 'preferences.md'), 'utf-8');
    expect(preferences).toContain('teal');

    const pendingAfterConsolidation = readdirSync(candidatesDir).filter((f) => f.endsWith('.md'));
    expect(pendingAfterConsolidation).toEqual([]);
    const archived = readdirSync(join(candidatesDir, 'archive'));
    expect(archived).toEqual(candidateFiles);

    await raven.stop();
    raven = undefined;
  }, 15000);
});
