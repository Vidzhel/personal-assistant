import {
  createLogger,
  generateId,
  SUITE_PROACTIVE_INTELLIGENCE,
  AGENT_PATTERN_ANALYZER,
  type EventBusInterface,
  type DatabaseInterface,
} from '@raven/shared';
import type { ServiceContext, SuiteService } from '@raven/core/suite-registry/service-runner.ts';

const log = createLogger('data-collector');

const DEFAULT_WINDOW_DAYS = 7;
const SESSION_WINDOW_DAYS = 30;
const MAX_SNAPSHOT_TOKENS = 2000;

interface EventSummary {
  type: string;
  count: number;
}

interface TaskSummary {
  skill_name: string;
  status: string;
  count: number;
}

interface PipelineSummary {
  pipeline_name: string;
  status: string;
  count: number;
}

interface AuditSummary {
  action_name: string;
  outcome: string;
  count: number;
}

interface SessionSummary {
  project_id: string;
  session_count: number;
  last_active: number;
}

let eventBus: EventBusInterface;
let db: DatabaseInterface;

function epochCutoff(days: number): number {
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

function isoCutoff(days: number): string {
  return new Date(epochCutoff(days)).toISOString();
}

function collectEventSnapshot(): string {
  const cutoff = epochCutoff(DEFAULT_WINDOW_DAYS);
  const rows = db.all<EventSummary>(
    'SELECT type, COUNT(*) as count FROM events WHERE timestamp > ? GROUP BY type ORDER BY count DESC',
    cutoff,
  );

  if (rows.length === 0) return 'No events in the last 7 days.';

  const lines = rows.map((r) => `  ${r.type}: ${r.count}`);
  return `Events (7d):\n${lines.join('\n')}`;
}

function collectTaskSnapshot(): string {
  const cutoff = epochCutoff(DEFAULT_WINDOW_DAYS);
  const rows = db.all<TaskSummary>(
    'SELECT skill_name, status, COUNT(*) as count FROM agent_tasks WHERE created_at > ? GROUP BY skill_name, status ORDER BY count DESC',
    cutoff,
  );

  if (rows.length === 0) return 'No agent tasks in the last 7 days.';

  const lines = rows.map((r) => `  ${r.skill_name} [${r.status}]: ${r.count}`);
  return `Agent Tasks (7d):\n${lines.join('\n')}`;
}

function collectAuditSnapshot(): string {
  const cutoff = isoCutoff(DEFAULT_WINDOW_DAYS);
  const rows = db.all<AuditSummary>(
    'SELECT action_name, outcome, COUNT(*) as count FROM audit_log WHERE timestamp > ? GROUP BY action_name, outcome ORDER BY count DESC',
    cutoff,
  );

  if (rows.length === 0) return 'No audit entries in the last 7 days.';

  const lines = rows.map((r) => `  ${r.action_name} → ${r.outcome}: ${r.count}`);
  return `Audit Log (7d):\n${lines.join('\n')}`;
}

function collectPipelineSnapshot(): string {
  const cutoff = isoCutoff(DEFAULT_WINDOW_DAYS);
  const rows = db.all<PipelineSummary>(
    'SELECT pipeline_name, status, COUNT(*) as count FROM pipeline_runs WHERE started_at > ? GROUP BY pipeline_name, status ORDER BY count DESC',
    cutoff,
  );

  if (rows.length === 0) return 'No pipeline runs in the last 7 days.';

  const lines = rows.map((r) => `  ${r.pipeline_name} [${r.status}]: ${r.count}`);
  return `Pipeline Runs (7d):\n${lines.join('\n')}`;
}

function collectSessionSnapshot(): string {
  const cutoff = epochCutoff(SESSION_WINDOW_DAYS);
  const rows = db.all<SessionSummary>(
    'SELECT project_id, COUNT(*) as session_count, MAX(last_active_at) as last_active FROM sessions WHERE last_active_at > ? GROUP BY project_id ORDER BY last_active DESC',
    cutoff,
  );

  if (rows.length === 0) return 'No sessions in the last 30 days.';

  const lines = rows.map((r) => {
    const daysAgo = Math.round((Date.now() - r.last_active) / (24 * 60 * 60 * 1000));
    return `  ${r.project_id}: ${r.session_count} sessions, last active ${daysAgo}d ago`;
  });
  return `Sessions (30d):\n${lines.join('\n')}`;
}

function collectKnowledgeSnapshot(): string {
  const cutoff = epochCutoff(DEFAULT_WINDOW_DAYS);
  const rows = db.all<EventSummary>(
    "SELECT type, COUNT(*) as count FROM events WHERE timestamp > ? AND type LIKE 'knowledge:%' GROUP BY type ORDER BY count DESC",
    cutoff,
  );

  if (rows.length === 0) return 'No knowledge activity in the last 7 days.';

  const lines = rows.map((r) => `  ${r.type}: ${r.count}`);
  return `Knowledge Activity (7d):\n${lines.join('\n')}`;
}

function collectConversationSnapshot(): string {
  const cutoff = epochCutoff(DEFAULT_WINDOW_DAYS);

  // Use agent_tasks as a proxy for conversation themes — each task captures what was asked
  const rows = db.all<{ skill_name: string; count: number }>(
    "SELECT skill_name, COUNT(*) as count FROM agent_tasks WHERE created_at > ? AND status = 'completed' GROUP BY skill_name ORDER BY count DESC",
    cutoff,
  );

  // Also get session turn counts per project for engagement signals
  const sessionRows = db.all<{ project_id: string; total_turns: number }>(
    'SELECT project_id, SUM(turn_count) as total_turns FROM sessions WHERE last_active_at > ? GROUP BY project_id ORDER BY total_turns DESC',
    cutoff,
  );

  const parts: string[] = [];

  if (rows.length > 0) {
    const taskLines = rows.map((r) => `  ${r.skill_name}: ${r.count} completed tasks`);
    parts.push(`Task Topics (7d):\n${taskLines.join('\n')}`);
  }

  if (sessionRows.length > 0) {
    const sessionLines = sessionRows.map((r) => `  ${r.project_id}: ${r.total_turns} turns`);
    parts.push(`Conversation Volume (7d):\n${sessionLines.join('\n')}`);
  }

  if (parts.length === 0) return 'No conversation activity in the last 7 days.';

  return parts.join('\n');
}

function collectInsightHistory(): string {
  const cutoff = isoCutoff(DEFAULT_WINDOW_DAYS);
  const rows = db.all<{ pattern_key: string; count: number }>(
    'SELECT pattern_key, COUNT(*) as count FROM insights WHERE created_at > ? GROUP BY pattern_key ORDER BY count DESC LIMIT 10',
    cutoff,
  );

  if (rows.length === 0) return 'No prior insights in the last 7 days.';

  const lines = rows.map((r) => `  ${r.pattern_key}: ${r.count} occurrences`);
  return `Recent Insights (7d, avoid duplicating):\n${lines.join('\n')}`;
}

export function buildSnapshot(database: DatabaseInterface): string {
  db = database;

  const sections = [
    collectEventSnapshot(),
    collectTaskSnapshot(),
    collectAuditSnapshot(),
    collectPipelineSnapshot(),
    collectSessionSnapshot(),
    collectKnowledgeSnapshot(),
    collectConversationSnapshot(),
    collectInsightHistory(),
  ];

  let snapshot = sections.join('\n\n');

  // Rough token estimate: ~4 chars per token
  const estimatedTokens = Math.ceil(snapshot.length / 4);
  if (estimatedTokens > MAX_SNAPSHOT_TOKENS) {
    snapshot = snapshot.slice(0, MAX_SNAPSHOT_TOKENS * 4) + '\n[...truncated]';
  }

  return snapshot;
}

function handleScheduleTriggered(event: unknown): void {
  try {
    const e = event as Record<string, unknown>;
    const payload = e.payload as Record<string, unknown>;

    if (payload.taskType !== 'pattern-analysis') return;

    log.info('Pattern analysis triggered — collecting data snapshot');

    const snapshot = buildSnapshot(db);

    log.info(`Data snapshot collected (${snapshot.length} chars)`);

    eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: SUITE_PROACTIVE_INTELLIGENCE,
      type: 'agent:task:request',
      payload: {
        taskId: generateId(),
        prompt: `Analyze the following data snapshot and identify actionable patterns:\n\n${snapshot}`,
        skillName: SUITE_PROACTIVE_INTELLIGENCE,
        actionName: 'intelligence:generate-insight',
        mcpServers: {},
        agentDefinitions: { [AGENT_PATTERN_ANALYZER]: undefined },
        priority: 'low' as const,
      },
    });
  } catch (err) {
    log.error(`Data collection failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const service: SuiteService = {
  async start(context: ServiceContext): Promise<void> {
    eventBus = context.eventBus;
    db = context.db;
    eventBus.on('schedule:triggered', handleScheduleTriggered);
    log.info('Data collector service started');
  },

  async stop(): Promise<void> {
    eventBus.off('schedule:triggered', handleScheduleTriggered);
    log.info('Data collector service stopped');
  },
};

export default service;
