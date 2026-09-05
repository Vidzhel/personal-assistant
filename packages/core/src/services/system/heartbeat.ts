import { createLogger, generateId, META_PROJECT_ID } from '@raven/shared';
import type { AgentTask, Project, SystemAccessLevel } from '@raven/shared';
import type Database from 'better-sqlite3';
import type { EventBus } from '../../event-bus/event-bus.ts';
import type { SessionManager } from '../../session-manager/session-manager.ts';
import type { NamedAgentStore } from '../../agent-registry/yaml-named-agent-store.ts';
import {
  resolveDefaultAgentCapabilities,
  type AgentResolver,
} from '../../agent-registry/agent-resolver.ts';
import type { CapabilityLibrary } from '../../capability-library/capability-library.ts';
import type { RavenMcpDeps } from '../../mcp-server/index.ts';
import type { MemoryStore } from '../../agent-memory/memory-store.ts';
import type { PermissionDeps } from '../../agent-manager/agent-session.ts';
import { runAgentTask } from '../../agent-manager/agent-session.ts';
import { resolveSystemAccessInstructions } from '../../project-manager/system-access-gate.ts';
import type { AppConfig } from '../../config.ts';
import type { FireHeartbeat } from '../../scheduler/schedule-engine.ts';

const log = createLogger('heartbeat');

const HEARTBEAT_SKILL_NAME = 'heartbeat';
const HEARTBEAT_OK = 'HEARTBEAT_OK';
/** Matched against the trimmed model reply instead of an exact `===`
 * comparison (F5): a model can wrap the sentinel in markdown emphasis
 * (**HEARTBEAT_OK**), trailing punctuation (HEARTBEAT_OK.), or different
 * case without changing its meaning — none of that should turn a swallowed
 * check-in into a spurious owner notification. \W* only eats *surrounding*
 * non-word characters, so real content appended after the sentinel (e.g.
 * "HEARTBEAT_OK, nothing else to report") still fails to match and is
 * correctly treated as a real notification. */
const HEARTBEAT_OK_RE = /^\W*heartbeat_ok\W*$/i;
/** Unattended background dispatch, not an interactive turn — capped well
 * below config.RAVEN_AGENT_MAX_TURNS so a confused run can't burn budget
 * silently overnight. */
const HEARTBEAT_MAX_TURNS = 8;
/** Busy-deferral window: skip firing if a real agent task (any chat/task
 * activity) ran this recently — an ambient check-in right on top of active
 * use is redundant and noisy, not useful. Not tied to the schedule's own
 * cron cadence (which this module has no visibility into) — a fixed,
 * documented window is simpler and independently testable. */
const BUSY_DEFERRAL_WINDOW_MINUTES = 30;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const BUSY_DEFERRAL_WINDOW_MS = BUSY_DEFERRAL_WINDOW_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;

const HEARTBEAT_PROMPT = [
  'Ambient check-in. Review your memory, pending approvals, task board, and recent events for',
  `anything the owner must know NOW. If nothing: reply exactly ${HEARTBEAT_OK}.`,
].join(' ');

const ACTIVE_HOURS_RE = /^(\d{1,2})-(\d{1,2})$/;

function getLocalHour(nowMs: number, timezone: string): number {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hourCycle: 'h23',
  }).format(new Date(nowMs));
  return Number(formatted);
}

/** Pure: is `nowMs` inside the "HH-HH" local-hour window (see config.ts's
 * RAVEN_HEARTBEAT_ACTIVE_HOURS)? Malformed input fails OPEN (returns true)
 * — a bad config value should never be the reason the heartbeat silently
 * never fires again; config.ts's own zod validation is the real gate on
 * shape. Supports a window that wraps past midnight (e.g. "22-06"). */
export function isWithinActiveHours(nowMs: number, activeHours: string, timezone: string): boolean {
  const match = ACTIVE_HOURS_RE.exec(activeHours);
  if (!match) return true;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const hour = getLocalHour(nowMs, timezone);
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** Pure (given a db handle): busy-deferral — was there any agent_tasks
 * activity at or after `sinceMs`? Deliberately broad (any task, any
 * project) rather than scoped to the heartbeat's own target project: a
 * busy owner anywhere in the system is a signal ambient noise would be
 * unwelcome right now. */
export function hadRecentAgentActivity(db: Database.Database, sinceMs: number): boolean {
  const row = db.prepare('SELECT 1 FROM agent_tasks WHERE created_at >= ? LIMIT 1').get(sinceMs);
  return row !== undefined;
}

export interface HeartbeatDeps {
  db: Database.Database;
  eventBus: EventBus;
  sessionManager: SessionManager;
  config: AppConfig;
  namedAgentStore?: NamedAgentStore;
  agentResolver?: AgentResolver;
  capabilityLibrary?: CapabilityLibrary;
  ravenMcpDeps?: RavenMcpDeps;
  memoryStore?: MemoryStore;
  permissionDeps?: PermissionDeps;
  /** Defaults to the meta/system project (read-write system access) —
   * heartbeat is a system-scoped ambient check, not tied to any one
   * owner-facing project. Overridable for tests. */
  targetProjectId?: string;
}

function resolveTargetSystemAccessInstructions(db: Database.Database, projectId: string): string {
  const row = db.prepare('SELECT name, system_access FROM projects WHERE id = ?').get(projectId) as
    { name: string; system_access: string } | undefined;
  const project: Project = {
    id: projectId,
    name: row?.name ?? 'Raven System',
    skills: [],
    systemAccess: (row?.system_access as SystemAccessLevel) ?? 'read-write',
    createdAt: 0,
    updatedAt: 0,
  };
  return resolveSystemAccessInstructions(project);
}

/** Dispatches ONE synthetic chat-style turn on a dedicated, throwaway
 * session — reuses runAgentTask directly (same primitive
 * session-retrospective.ts/memory-consolidation.ts use for their own
 * internal dispatches) rather than emitting `agent:task:request` through
 * the event bus. That distinction matters here specifically: every
 * `agent:task:complete` event is broadcast with source:'agent-manager'
 * regardless of what requested it, and telegram-bot.ts's
 * handleAgentTaskComplete delivers ALL of those to the project's Telegram
 * topic unconditionally — going through that path would leak a raw
 * "HEARTBEAT_OK" to the owner every single fire, exactly the silence
 * contract this exists to prevent. Calling runAgentTask directly returns
 * the result synchronously so this module — not a generic completion
 * broadcast — is what decides swallow vs. notify.
 *
 * Session id is a fresh generateId() each fire, deliberately NOT looked up
 * via sessionManager.getOrCreateSession(projectId) (F4): that call returns
 * whichever session is currently idle/running for the project — the SAME
 * row a real chat turn on META could be mid-turn on right now. The
 * heartbeat's cron cadence has no visibility into (and no serialization
 * with) agent-manager's own task dispatch, so two runAgentTask calls
 * resuming/linking the same sdkSessionId concurrently would corrupt SDK
 * session continuity for the owner's real conversation. A fresh, never-
 * persisted session id sidesteps that entirely: getSdkSessionId(freshId)
 * always misses (cold start, no resume), and the finally-block
 * linkSdkSession(freshId, ...) is a harmless no-op UPDATE against a row
 * that was never inserted. The heartbeat doesn't need chat history or
 * cross-fire continuity — only memory/approvals/task-board tool access,
 * which capability resolution provides independently of any session.
 * messageStore is deliberately NOT passed either, so this synthetic turn
 * never shows up in the owner's own chat transcript — only its (rare)
 * notification is owner-visible, per the silence contract. */
async function dispatchHeartbeatTurn(deps: HeartbeatDeps): Promise<string> {
  const { db, eventBus, sessionManager, ravenMcpDeps, memoryStore, permissionDeps, config } = deps;
  const projectId = deps.targetProjectId ?? META_PROJECT_ID;
  const sessionId = generateId();
  const capabilities = resolveDefaultAgentCapabilities(deps);

  const task: AgentTask = {
    id: generateId(),
    sessionId,
    projectId,
    skillName: HEARTBEAT_SKILL_NAME,
    prompt: HEARTBEAT_PROMPT,
    status: 'queued',
    priority: 'low',
    mcpServers: capabilities.mcpServers,
    agentDefinitions: capabilities.agentDefinitions,
    plugins: capabilities.plugins,
    ...(capabilities.namedAgentInstructions !== undefined && {
      namedAgentInstructions: capabilities.namedAgentInstructions,
    }),
    systemAccessInstructions: resolveTargetSystemAccessInstructions(db, projectId),
    namedAgentId: capabilities.namedAgentId,
    createdAt: Date.now(),
  };

  const result = await runAgentTask({
    task,
    eventBus,
    mcpServers: task.mcpServers,
    agentDefinitions: task.agentDefinitions,
    plugins: task.plugins,
    permissionDeps,
    ravenMcpDeps,
    memoryStore,
    sessionManager,
    model: config.CLAUDE_MODEL,
    maxTurns: HEARTBEAT_MAX_TURNS,
  });

  if (!result.success) {
    throw new Error(
      `Heartbeat agent failed: ${result.errors?.join('; ') ?? 'unsuccessful result'}`,
    );
  }
  if (!result.result.trim()) throw new Error('Heartbeat agent returned an empty response');
  return result.result;
}

function notifyOwner(eventBus: EventBus, body: string): void {
  eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: HEARTBEAT_SKILL_NAME,
    type: 'notification',
    payload: {
      channel: 'telegram',
      title: 'Heartbeat',
      body,
      topicName: 'System',
    },
  });
}

export interface Heartbeat {
  fireHeartbeat: FireHeartbeat;
  /** Test/introspection seam — whether a fire is currently in flight. */
  isRunning: () => boolean;
}

/**
 * Ambient awareness with a silence contract: skip firing outside active
 * hours, skip on busy-deferral (recent agent activity), skip if a previous
 * fire hasn't finished; otherwise dispatch one synthetic turn and either
 * swallow an exact HEARTBEAT_OK reply (log only) or notify the owner.
 */
export function createHeartbeat(deps: HeartbeatDeps): Heartbeat {
  let running = false;

  async function fireHeartbeat(): Promise<{ summary: string }> {
    if (running) {
      log.info('Skipping: previous heartbeat is still running');
      return { summary: 'skipped: previous heartbeat still running' };
    }

    const now = Date.now();
    if (
      !isWithinActiveHours(
        now,
        deps.config.RAVEN_HEARTBEAT_ACTIVE_HOURS,
        deps.config.RAVEN_TIMEZONE,
      )
    ) {
      log.info('Skipping: outside active hours');
      return { summary: 'skipped: outside active hours' };
    }
    if (hadRecentAgentActivity(deps.db, now - BUSY_DEFERRAL_WINDOW_MS)) {
      log.info('Skipping: busy-deferral (recent agent activity)');
      return { summary: 'skipped: busy-deferral (recent agent activity)' };
    }

    running = true;
    try {
      const response = await dispatchHeartbeatTurn(deps);
      if (HEARTBEAT_OK_RE.test(response.trim())) {
        log.info(`${HEARTBEAT_OK} — swallowed`);
        return { summary: `${HEARTBEAT_OK} (swallowed)` };
      }
      notifyOwner(deps.eventBus, response);
      log.info('Notified owner');
      return { summary: 'notified owner' };
    } finally {
      running = false;
    }
  }

  return { fireHeartbeat, isRunning: () => running };
}
