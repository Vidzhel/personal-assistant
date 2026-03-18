import { createLogger, generateId, SUITE_PROACTIVE_INTELLIGENCE, AgentInsightResultSchema, } from '@raven/shared';
import { computeSuppressionHash, insertInsight, findRecentByHash, } from '@raven/core/insight-engine/insight-store.ts';
const log = createLogger('insight-processor');
const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;
const DEFAULT_SUPPRESSION_WINDOW_DAYS = 7;
const DEFAULT_MAX_INSIGHTS_PER_RUN = 5;
let eventBus;
let db;
let confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD;
let suppressionWindowDays = DEFAULT_SUPPRESSION_WINDOW_DAYS;
let maxInsightsPerRun = DEFAULT_MAX_INSIGHTS_PER_RUN;
function handleTaskComplete(event) {
    try {
        const e = event;
        const payload = e.payload;
        if (payload.skillName !== SUITE_PROACTIVE_INTELLIGENCE)
            return;
        if (!payload.success) {
            log.warn('Pattern analysis task failed — no insights to process');
            return;
        }
        const resultStr = payload.result;
        if (!resultStr)
            return;
        // Extract JSON from agent result
        let jsonStr = resultStr;
        const firstBrace = resultStr.indexOf('{');
        if (firstBrace >= 0) {
            const lastBrace = resultStr.lastIndexOf('}');
            if (lastBrace > firstBrace) {
                jsonStr = resultStr.slice(firstBrace, lastBrace + 1);
            }
        }
        let rawData;
        try {
            rawData = JSON.parse(jsonStr);
        }
        catch {
            log.error('Failed to parse pattern analysis result as JSON');
            return;
        }
        const parsed = AgentInsightResultSchema.safeParse(rawData);
        if (!parsed.success) {
            log.error(`Invalid insight result structure: ${parsed.error.message}`);
            return;
        }
        const { insights } = parsed.data;
        log.info(`Processing ${insights.length} insights from pattern analysis`);
        let processedCount = 0;
        for (const insight of insights) {
            if (processedCount >= maxInsightsPerRun) {
                log.info(`Max insights per run (${maxInsightsPerRun}) reached, skipping remaining`);
                break;
            }
            const hash = computeSuppressionHash(insight.patternKey, insight.keyFacts);
            // Check confidence threshold
            if (insight.confidence < confidenceThreshold) {
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
                        reason: 'low-confidence',
                    },
                });
                log.info(`Insight ${insight.patternKey} suppressed (confidence ${insight.confidence} < ${confidenceThreshold})`);
                processedCount++;
                continue;
            }
            // Check for duplicates
            const existing = findRecentByHash(db, hash, suppressionWindowDays);
            if (existing) {
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
                        reason: 'duplicate',
                    },
                });
                log.info(`Insight ${insight.patternKey} suppressed (duplicate within ${suppressionWindowDays}d window)`);
                processedCount++;
                continue;
            }
            // Store as queued and emit for delivery
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
            eventBus.emit({
                id: generateId(),
                timestamp: Date.now(),
                source: SUITE_PROACTIVE_INTELLIGENCE,
                type: 'notification',
                payload: {
                    channel: 'telegram',
                    title: insight.title,
                    body: insight.body,
                    topicName: 'General',
                    actions: [
                        { label: 'Useful', action: `insight:acted:${id}` },
                        { label: 'Dismiss', action: `insight:dismissed:${id}` },
                    ],
                },
            });
            log.info(`Insight ${insight.patternKey} queued for delivery (confidence: ${insight.confidence})`);
            processedCount++;
        }
        log.info(`Insight processing complete: ${processedCount} insights processed`);
    }
    catch (err) {
        log.error(`Insight processing failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}
const service = {
    async start(context) {
        eventBus = context.eventBus;
        db = context.db;
        const config = context.config;
        if (typeof config.confidenceThreshold === 'number') {
            confidenceThreshold = config.confidenceThreshold;
        }
        if (typeof config.suppressionWindowDays === 'number') {
            suppressionWindowDays = config.suppressionWindowDays;
        }
        if (typeof config.maxInsightsPerRun === 'number') {
            maxInsightsPerRun = config.maxInsightsPerRun;
        }
        eventBus.on('agent:task:complete', handleTaskComplete);
        log.info(`Insight processor started (threshold: ${confidenceThreshold}, window: ${suppressionWindowDays}d, max: ${maxInsightsPerRun})`);
    },
    async stop() {
        eventBus.off('agent:task:complete', handleTaskComplete);
        log.info('Insight processor service stopped');
    },
};
export default service;
//# sourceMappingURL=insight-processor.js.map