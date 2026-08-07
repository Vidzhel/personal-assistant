import { createLogger, generateId, META_PROJECT_ID } from '@raven/shared';
import type {
  AgentTask,
  McpServerConfig,
  SubAgentDefinition,
  Project,
  SystemAccessLevel,
} from '@raven/shared';
import type Database from 'better-sqlite3';
import type { EventBus } from '../../event-bus/event-bus.ts';
import type { SessionManager } from '../../session-manager/session-manager.ts';
import type { NamedAgentStore } from '../../agent-registry/yaml-named-agent-store.ts';
import type { AgentResolver } from '../../agent-registry/agent-resolver.ts';
import type { CapabilityLibrary } from '../../capability-library/capability-library.ts';
import type { RavenMcpDeps } from '../../mcp-server/index.ts';
import type { MemoryStore } from '../../agent-memory/memory-store.ts';
import type { PermissionDeps } from '../../agent-manager/agent-session.ts';
import { runAgentTask } from '../../agent-manager/agent-session.ts';
import { createKnowledgeAgentDefinition } from '../../knowledge-engine/knowledge-agent.ts';
import { resolveSystemAccessInstructions } from '../../project-manager/system-access-gate.ts';
import type { AppConfig } from '../../config.ts';
import type { FireHeartbeat } from '../../scheduler/schedule-engine.ts';

const log = createLogger('heartbeat');

const HEARTBEAT_SKILL_NAME = 'heartbeat';
const HEARTBEAT_OK = 'HEARTBEAT_OK';
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

interface ResolvedHeartbeatCapabilities {
  mcpServers: Record<string, McpServerConfig>;
  agentDefinitions: Record<string, SubAgentDefinition>;
  plugins: Array<{ type: 'local'; path: string }>;
  namedAgentInstructions?: string;
  namedAgentId?: string;
}

/** Mirrors orchestrator.ts handleUserChat's own capability resolution
 * (named agent's explicit skills, falling back to the full library) so the
 * heartbeat's synthetic turn sees the SAME tools a real chat turn would —
 * duplicated rather than extracted from orchestrator.ts to avoid widening
 * that file's surface for a single internal caller. */
function resolveCapabilities(deps: HeartbeatDeps): ResolvedHeartbeatCapabilities {
  const { namedAgentStore, agentResolver, capabilityLibrary } = deps;

  if (namedAgentStore && agentResolver) {
    try {
      const namedAgent = namedAgentStore.getDefaultAgent();
      const capabilities = agentResolver.resolveAgentCapabilities(namedAgent);
      return {
        mcpServers: capabilities.mcpServers,
        agentDefinitions: capabilities.agentDefinitions,
        plugins: capabilities.plugins,
        ...(namedAgent.instructions && { namedAgentInstructions: namedAgent.instructions }),
        namedAgentId: namedAgent.id,
      };
    } catch (err) {
      log.warn(`Named agent resolution failed, falling back to the full library: ${err}`);
    }
  }

  if (!capabilityLibrary) return { mcpServers: {}, agentDefinitions: {}, plugins: [] };
  return {
    mcpServers: capabilityLibrary.collectMcpServers(),
    agentDefinitions: capabilityLibrary.collectAgentDefinitions(),
    plugins: capabilityLibrary.resolveVendorPlugins(),
  };
}

function resolveTargetSystemAccessInstructions(db: Database.Database, projectId: string): string {
  const row = db.prepare('SELECT name, system_access FROM projects WHERE id = ?').get(projectId) as
    | { name: string; system_access: string }
    | undefined;
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

/** Dispatches ONE synthetic chat-style turn on the target project's
 * existing session — reuses runAgentTask directly (same primitive
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
 * Session continuity ("resume the default agent's current session") comes
 * from passing sessionManager + task.sessionId: runAgentTask resumes the
 * same SDK session a real chat turn would and re-links the new SDK session
 * id afterward, so the next real user turn continues from here forward.
 * messageStore is deliberately NOT passed, so this synthetic turn never
 * shows up in the owner's own chat transcript — only its (rare)
 * notification is owner-visible, per the silence contract. */
async function dispatchHeartbeatTurn(deps: HeartbeatDeps): Promise<string> {
  const { db, eventBus, sessionManager, ravenMcpDeps, memoryStore, permissionDeps, config } = deps;
  const projectId = deps.targetProjectId ?? META_PROJECT_ID;
  const session = sessionManager.getOrCreateSession(projectId);
  const capabilities = resolveCapabilities(deps);
  // Every real chat turn carries the knowledge-agent sub-agent (see
  // orchestrator.ts) — heartbeat mirrors that for parity.
  capabilities.agentDefinitions['knowledge-agent'] = createKnowledgeAgentDefinition();

  const task: AgentTask = {
    id: generateId(),
    sessionId: session.id,
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
      if (response.trim() === HEARTBEAT_OK) {
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
