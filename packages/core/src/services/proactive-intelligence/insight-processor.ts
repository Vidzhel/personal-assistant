import {
  createLogger,
  generateId,
  SUITE_PROACTIVE_INTELLIGENCE,
  DEFAULT_INSIGHT_AUTO_DISMISS_HOURS,
  type EventBusInterface,
  type DatabaseInterface,
  AgentInsightResultSchema,
} from '@raven/shared';
import type { ServiceContext, RavenService } from '../types.ts';
import {
  computeSuppressionHash,
  insertInsight,
  findRecentByHash,
  getInsightsByStatus,
  updateInsightStatus,
} from '../../insight-engine/insight-store.ts';

const log = createLogger('insight-processor');

const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;
const DEFAULT_SUPPRESSION_WINDOW_DAYS = 7;
const DEFAULT_MAX_INSIGHTS_PER_RUN = 5;
const PERCENT_MULTIPLIER = 100;

let eventBus: EventBusInterface;
let db: DatabaseInterface;
let confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD;
let suppressionWindowDays = DEFAULT_SUPPRESSION_WINDOW_DAYS;
let maxInsightsPerRun = DEFAULT_MAX_INSIGHTS_PER_RUN;
let insightAutoDismissHours = DEFAULT_INSIGHT_AUTO_DISMISS_HOURS;

const MS_PER_HOUR = 3_600_000;

type ParsedInsightResult = ReturnType<typeof AgentInsightResultSchema.parse>;
type InsightRecommendation = ParsedInsightResult['insights'][number];

function autoDismissStaleInsights(): void {
  const cutoff = new Date(Date.now() - insightAutoDismissHours * MS_PER_HOUR).toISOString();
  const queued = getInsightsByStatus(db, 'queued');

  let dismissed = 0;
  for (const insight of queued) {
    if (insight.created_at < cutoff) {
      updateInsightStatus(db, insight.id, 'dismissed');
      dismissed++;
    }
  }

  if (dismissed > 0) {
    log.info(
      `Auto-dismissed ${dismissed} unacknowledged insight(s) older than ${insightAutoDismissHours}h`,
    );
  }
}

function extractInsightJson(resultStr: string): string {
  const firstBrace = resultStr.indexOf('{');
  if (firstBrace < 0) return resultStr;
  const lastBrace = resultStr.lastIndexOf('}');
  if (lastBrace <= firstBrace) return resultStr;
  return resultStr.slice(firstBrace, lastBrace + 1);
}

function parseInsightPayload(resultStr: string): ParsedInsightResult | null {
  const jsonStr = extractInsightJson(resultStr);

  let rawData: unknown;
  try {
    rawData = JSON.parse(jsonStr);
  } catch {
    log.error('Failed to parse pattern analysis result as JSON');
    return null;
  }

  const parsed = AgentInsightResultSchema.safeParse(rawData);
  if (!parsed.success) {
    log.error(`Invalid insight result structure: ${parsed.error.message}`);
    return null;
  }

  return parsed.data;
}

function suppressLowConfidenceInsight(insight: InsightRecommendation, hash: string): void {
  const id = insertInsight(db, {
    patternKey: insight.patternKey,
    title: insight.title,
    body: insight.body,
    confidence: insight.confidence,
    status: 'pending',
    serviceSources: insight.serviceSources,
    suppressionHash: hash,
  });

  eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: SUITE_PROACTIVE_INTELLIGENCE,
    type: 'insight:suppressed',
    payload: {
      insightId: id,
      patternKey: insight.patternKey,
      reason: 'low-confidence' as const,
    },
  });

  log.info(
    `Insight ${insight.patternKey} suppressed (confidence ${insight.confidence} < ${confidenceThreshold})`,
  );
}

function suppressDuplicateInsight(insight: InsightRecommendation, hash: string): void {
  const id = insertInsight(db, {
    patternKey: insight.patternKey,
    title: insight.title,
    body: insight.body,
    confidence: insight.confidence,
    status: 'pending',
    serviceSources: insight.serviceSources,
    suppressionHash: hash,
  });

  eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: SUITE_PROACTIVE_INTELLIGENCE,
    type: 'insight:suppressed',
    payload: {
      insightId: id,
      patternKey: insight.patternKey,
      reason: 'duplicate' as const,
    },
  });

  log.info(
    `Insight ${insight.patternKey} suppressed (duplicate within ${suppressionWindowDays}d window)`,
  );
}

function emitInsightQueuedNotification(insight: InsightRecommendation, id: string): void {
  eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: SUITE_PROACTIVE_INTELLIGENCE,
    type: 'notification',
    payload: {
      channel: 'telegram' as const,
      title: insight.title,
      body: insight.body,
      topicName: 'General',
      actions: [
        { label: 'Useful', action: `insight:acted:${id}` },
        { label: 'Dismiss', action: `insight:dismissed:${id}` },
      ],
    },
  });
}

function queueInsightForDelivery(insight: InsightRecommendation, hash: string): void {
  const id = insertInsight(db, {
    patternKey: insight.patternKey,
    title: insight.title,
    body: insight.body,
    confidence: insight.confidence,
    status: 'queued',
    serviceSources: insight.serviceSources,
    suppressionHash: hash,
  });

  eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: SUITE_PROACTIVE_INTELLIGENCE,
    type: 'insight:generated',
    payload: {
      insightId: id,
      patternKey: insight.patternKey,
      title: insight.title,
      confidence: insight.confidence,
      serviceSources: insight.serviceSources,
    },
  });

  eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: SUITE_PROACTIVE_INTELLIGENCE,
    type: 'insight:queued',
    payload: {
      insightId: id,
      patternKey: insight.patternKey,
    },
  });

  emitInsightQueuedNotification(insight, id);

  log.info(`Insight ${insight.patternKey} queued for delivery (confidence: ${insight.confidence})`);
}

function processInsightRecommendation(insight: InsightRecommendation): void {
  const hash = computeSuppressionHash(insight.patternKey, insight.keyFacts);

  // Check confidence threshold
  if (insight.confidence < confidenceThreshold) {
    suppressLowConfidenceInsight(insight, hash);
    return;
  }

  // Check for duplicates
  const existing = findRecentByHash(db, hash, suppressionWindowDays);
  if (existing) {
    suppressDuplicateInsight(insight, hash);
    return;
  }

  // Store as queued and emit for delivery
  queueInsightForDelivery(insight, hash);
}

function handleTaskComplete(event: unknown): void {
  try {
    const e = event as Record<string, unknown>;
    const payload = e.payload as Record<string, unknown>;

    if (payload.skillName !== SUITE_PROACTIVE_INTELLIGENCE) return;
    if (!payload.success) {
      log.warn('Pattern analysis task failed — no insights to process');
      return;
    }

    // Auto-dismiss stale insights before processing new ones
    autoDismissStaleInsights();

    const resultStr = payload.result as string;
    if (!resultStr) return;

    const parsedResult = parseInsightPayload(resultStr);
    if (!parsedResult) return;

    const { insights } = parsedResult;
    log.info(`Processing ${insights.length} insights from pattern analysis`);

    let processedCount = 0;

    for (const insight of insights) {
      if (processedCount >= maxInsightsPerRun) {
        log.info(`Max insights per run (${maxInsightsPerRun}) reached, skipping remaining`);
        break;
      }

      processInsightRecommendation(insight);
      processedCount++;
    }

    log.info(`Insight processing complete: ${processedCount} insights processed`);
  } catch (err) {
    log.error(`Insight processing failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

interface CrossDomainBubble {
  id: string;
  title: string;
  domains: string[];
}

interface CrossDomainInsightPayload {
  sourceBubble: CrossDomainBubble;
  targetBubble: CrossDomainBubble;
  confidence: number;
  relationshipType: string;
}

function buildCrossDomainPatternKey(
  sourceBubble: CrossDomainBubble,
  targetBubble: CrossDomainBubble,
): string {
  const sortedDomains = [...new Set([...sourceBubble.domains, ...targetBubble.domains])].sort();
  return `cross-domain:${sortedDomains.join('-')}`;
}

function queueCrossDomainInsight(
  payload: CrossDomainInsightPayload,
  patternKey: string,
  hash: string,
): void {
  const { sourceBubble, targetBubble, confidence, relationshipType } = payload;
  const title = `Cross-domain: ${sourceBubble.title} ↔ ${targetBubble.title}`;
  const pct = Math.round(confidence * PERCENT_MULTIPLIER);
  const body = `Connection detected between **${sourceBubble.title}** (${sourceBubble.domains.join(', ')}) and **${targetBubble.title}** (${targetBubble.domains.join(', ')}) — *${relationshipType}* (confidence: ${pct}%)`;

  const id = insertInsight(db, {
    patternKey,
    title,
    body,
    confidence,
    status: 'queued',
    serviceSources: ['knowledge-engine', `bubbles:${sourceBubble.id},${targetBubble.id}`],
    suppressionHash: hash,
  });

  eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: SUITE_PROACTIVE_INTELLIGENCE,
    type: 'notification',
    payload: {
      channel: 'telegram' as const,
      title,
      body,
      topicName: 'General',
      actions: [
        { label: 'View in Graph', action: `ki:v:${id}` },
        { label: 'Interesting', action: `ki:i:${id}` },
        { label: 'Not Useful', action: `ki:n:${id}` },
      ],
    },
  });

  log.info(`Cross-domain insight queued: ${patternKey} (confidence: ${confidence})`);
}

function handleCrossDomainInsight(event: unknown): void {
  try {
    const e = event as Record<string, unknown>;
    const payload = e.payload as CrossDomainInsightPayload;

    const { sourceBubble, targetBubble } = payload;
    const patternKey = buildCrossDomainPatternKey(sourceBubble, targetBubble);
    const hash = computeSuppressionHash(patternKey, [sourceBubble.id, targetBubble.id].sort());

    // Check for duplicates
    const existing = findRecentByHash(db, hash, suppressionWindowDays);
    if (existing) {
      log.info(`Cross-domain insight ${patternKey} suppressed (duplicate)`);
      return;
    }

    queueCrossDomainInsight(payload, patternKey, hash);
  } catch (err) {
    log.error(
      `Cross-domain insight processing failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

const service: RavenService = {
  async start(context: ServiceContext): Promise<void> {
    eventBus = context.eventBus;
    db = context.db;

    const config = context.config as Record<string, unknown>;
    if (typeof config.confidenceThreshold === 'number') {
      confidenceThreshold = config.confidenceThreshold;
    }
    if (typeof config.suppressionWindowDays === 'number') {
      suppressionWindowDays = config.suppressionWindowDays;
    }
    if (typeof config.maxInsightsPerRun === 'number') {
      maxInsightsPerRun = config.maxInsightsPerRun;
    }
    if (typeof config.insightAutoDismissHours === 'number') {
      insightAutoDismissHours = config.insightAutoDismissHours;
    }

    eventBus.on('agent:task:complete', handleTaskComplete);
    eventBus.on('knowledge:insight:cross-domain', handleCrossDomainInsight);
    log.info(
      `Insight processor started (threshold: ${confidenceThreshold}, window: ${suppressionWindowDays}d, max: ${maxInsightsPerRun})`,
    );
  },

  async stop(): Promise<void> {
    eventBus.off('agent:task:complete', handleTaskComplete);
    eventBus.off('knowledge:insight:cross-domain', handleCrossDomainInsight);
    log.info('Insight processor service stopped');
  },
};

export default service;
