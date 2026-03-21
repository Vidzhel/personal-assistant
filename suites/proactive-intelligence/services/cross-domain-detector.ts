import {
  createLogger,
  generateId,
  SUITE_PROACTIVE_INTELLIGENCE,
  type EventBusInterface,
  type DatabaseInterface,
} from '@raven/shared';
import type { ServiceContext, SuiteService } from '@raven/core/suite-registry/service-runner.ts';
import { createNeo4jClient, type Neo4jClient } from '@raven/core/knowledge-engine/neo4j-client.ts';

const log = createLogger('cross-domain-detector');

const DEFAULT_THRESHOLD = 0.75;

let eventBus: EventBusInterface;
let db: DatabaseInterface;
let neo4j: Neo4jClient;
let confidenceThreshold = DEFAULT_THRESHOLD;

interface BubbleDomainInfo {
  id: string;
  title: string;
  domains: string[];
}

async function getBubbleDomains(bubbleId: string): Promise<BubbleDomainInfo> {
  const rows = await neo4j.query<{ title: string; name: string | null }>(
    `MATCH (b:Bubble {id: $id})
     OPTIONAL MATCH (b)-[:IN_DOMAIN]->(d:Domain)
     RETURN b.title AS title, d.name AS name`,
    { id: bubbleId },
  );

  const title = rows[0]?.title ?? '';
  const domains = rows.filter((r) => r.name !== null).map((r) => r.name as string);
  return { id: bubbleId, title, domains };
}

function haveDomainOverlap(domainsA: string[], domainsB: string[]): boolean {
  const setA = new Set(domainsA);
  return domainsB.some((d) => setA.has(d));
}

function makeDomainPairKey(domainsA: string[], domainsB: string[]): string {
  const allDomains = [...new Set([...domainsA, ...domainsB])].sort();
  return allDomains.join('-');
}

function getAdaptiveThreshold(domainPair: string): number {
  const row = db.get<{ threshold: number }>(
    'SELECT threshold FROM cross_domain_thresholds WHERE domain_pair = ?',
    domainPair,
  );
  return row?.threshold ?? confidenceThreshold;
}

// eslint-disable-next-line max-lines-per-function -- event handler with domain comparison logic
async function handleLinksSuggested(event: unknown): Promise<void> {
  try {
    const e = event as Record<string, unknown>;
    const payload = e.payload as {
      bubbleId: string;
      links: Array<{ targetBubbleId: string; confidence: number; relationshipType: string }>;
    };

    for (const link of payload.links) {
      const sourceBubble = await getBubbleDomains(payload.bubbleId);
      const targetBubble = await getBubbleDomains(link.targetBubbleId);

      // Skip if either has no domains classified
      if (sourceBubble.domains.length === 0 || targetBubble.domains.length === 0) {
        continue;
      }

      // Same-domain: skip (AC 6 — existing behavior preserved)
      if (haveDomainOverlap(sourceBubble.domains, targetBubble.domains)) {
        continue;
      }

      // Check threshold (per-pair adaptive, fallback to env/default)
      const domainPair = makeDomainPairKey(sourceBubble.domains, targetBubble.domains);
      const threshold = getAdaptiveThreshold(domainPair);

      if (link.confidence < threshold) {
        log.debug(
          `Cross-domain link ${sourceBubble.id}→${targetBubble.id} below threshold (${link.confidence} < ${threshold})`,
        );
        continue;
      }

      eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: SUITE_PROACTIVE_INTELLIGENCE,
        type: 'knowledge:insight:cross-domain',
        payload: {
          sourceBubble: {
            id: sourceBubble.id,
            title: sourceBubble.title,
            domains: sourceBubble.domains,
          },
          targetBubble: {
            id: targetBubble.id,
            title: targetBubble.title,
            domains: targetBubble.domains,
          },
          confidence: link.confidence,
          relationshipType: link.relationshipType,
        },
      });

      log.info(
        `Cross-domain insight: ${sourceBubble.title} (${sourceBubble.domains.join(',')}) → ${targetBubble.title} (${targetBubble.domains.join(',')}) [${link.confidence}]`,
      );
    }
  } catch (err) {
    log.error(`Cross-domain detection failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const service: SuiteService = {
  async start(context: ServiceContext): Promise<void> {
    eventBus = context.eventBus;
    db = context.db;

    confidenceThreshold = DEFAULT_THRESHOLD;
    const envThreshold = process.env.RAVEN_CROSS_DOMAIN_INSIGHT_THRESHOLD;
    if (envThreshold) {
      const parsed = parseFloat(envThreshold);
      if (!isNaN(parsed)) confidenceThreshold = parsed;
    }

    neo4j = createNeo4jClient({
      uri: process.env.NEO4J_URI ?? 'bolt://localhost:7687',
      user: process.env.NEO4J_USER ?? 'neo4j',
      password: process.env.NEO4J_PASSWORD ?? 'ravenpassword',
    });

    eventBus.on('knowledge:links:suggested', handleLinksSuggested);
    log.info(`Cross-domain detector started (threshold: ${confidenceThreshold})`);
  },

  async stop(): Promise<void> {
    eventBus.off('knowledge:links:suggested', handleLinksSuggested);
    await neo4j.close();
    log.info('Cross-domain detector stopped');
  },
};

export default service;
