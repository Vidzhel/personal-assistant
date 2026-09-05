import { createLogger, META_PROJECT_ID } from '@raven/shared';
import type { TaskTree } from '@raven/shared';
import type {
  ExecutionLogger,
  TaskStats,
  PerSkillStats,
} from '../agent-manager/execution-logger.ts';
import type { MemoryStore } from './memory-store.ts';
import { writeMemoryCandidate } from './memory-candidates.ts';

const log = createLogger('system-retrospective');

const MS_PER_DAY = 86_400_000;
const LOOKBACK_DAYS = 7;
const TOP_SKILLS_LIMIT = 5;
const PERCENT = 100;

export interface SystemRetrospectiveDeps {
  memoryStore: MemoryStore;
  executionEngine: ExecutionTreeQuery;
  executionLogger: ExecutionLogger;
}

export interface SystemRetrospectiveResult {
  candidateWritten: boolean;
  failureCount: number;
  stuckTreeCount: number;
}

interface ExecutionTreeQuery {
  queryTrees(): TaskTree[];
}

function countStuckTrees(engine: ExecutionTreeQuery, cutoffMs: number): number {
  return engine
    .queryTrees()
    .filter((tree) => tree.status === 'running' && new Date(tree.updatedAt).getTime() < cutoffMs)
    .length;
}

function buildSummary(stats: TaskStats, perSkill: PerSkillStats[], stuckTreeCount: number): string {
  const errorRate = stats.total1h > 0 ? Math.round((stats.failed1h / stats.total1h) * PERCENT) : 0;
  const lines = [
    `Over the last ${LOOKBACK_DAYS} days: ${stats.total1h} agent tasks ran, ${stats.failed1h} failed (${errorRate}% error rate).`,
  ];

  const failingSkills = perSkill
    .filter((s) => s.failed > 0)
    .sort((a, b) => b.failed - a.failed)
    .slice(0, TOP_SKILLS_LIMIT);
  if (failingSkills.length > 0) {
    lines.push(
      `Skills with the most failures: ${failingSkills.map((s) => `${s.skillName} (${s.failed}/${s.total})`).join(', ')}.`,
    );
  }

  if (stuckTreeCount > 0) {
    lines.push(
      `${stuckTreeCount} task tree(s) have been stuck in "running" for over ${LOOKBACK_DAYS} days.`,
    );
  }

  if (stats.failed1h === 0 && stuckTreeCount === 0) {
    lines.push('No failures or stuck work this week.');
  }

  return lines.join(' ');
}

/** Weekly, deterministic (zero model calls): aggregates recorded agent run
 * failures/error-rates and stuck task trees over the last 7 days into ONE
 * memory candidate for the system project — "what kept failing". Purely
 * mechanical aggregation, so there's no judgment call here that needs an
 * LLM (unlike session retrospectives, which summarize open-ended
 * conversation). Writes nothing when there's nothing to report. */
export async function runSystemRetrospective(
  deps: SystemRetrospectiveDeps,
): Promise<SystemRetrospectiveResult> {
  const { memoryStore, executionEngine, executionLogger } = deps;
  const lookbackMs = LOOKBACK_DAYS * MS_PER_DAY;
  const cutoffMs = Date.now() - lookbackMs;

  const stats = executionLogger.getTaskStats(lookbackMs);
  const perSkill = executionLogger.getPerSkillStats(lookbackMs);
  const stuckTreeCount = countStuckTrees(executionEngine, cutoffMs);

  if (stats.failed1h === 0 && stuckTreeCount === 0) {
    log.info('System retrospective: nothing to report this week');
    return { candidateWritten: false, failureCount: 0, stuckTreeCount: 0 };
  }

  const summary = buildSummary(stats, perSkill, stuckTreeCount);
  const filename = await writeMemoryCandidate({ memoryStore }, META_PROJECT_ID, {
    title: `System health check-in (${LOOKBACK_DAYS}d)`,
    content: summary,
    source: 'system-retrospective',
  });

  if (filename === undefined) throw new Error('System retrospective candidate could not be saved');
  log.info(`System retrospective candidate: ${filename}`);
  return {
    candidateWritten: filename !== undefined,
    failureCount: stats.failed1h,
    stuckTreeCount,
  };
}
