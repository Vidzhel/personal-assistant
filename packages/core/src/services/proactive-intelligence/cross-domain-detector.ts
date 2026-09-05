import { z } from 'zod';
import {
  createLogger,
  generateId,
  SUITE_PROACTIVE_INTELLIGENCE,
  type EventBusInterface,
  type DatabaseInterface,
} from '@raven/shared';
import type { ServiceContext, RavenService } from '../types.ts';
import { createNeo4jClient, type Neo4jClient } from '../../knowledge-engine/neo4j-client.ts';

const log = createLogger('cross-domain-detector');

const DEFAULT_THRESHOLD = 0.75;

let eventBus: EventBusInterface;
let db: DatabaseInterface;
let neo4j: Neo4jClient | undefined;
let confidenceThreshold = DEFAULT_THRESHOLD;
let degraded = true;
const GraphConfigSchema = z.object({
  enabled: z.boolean(),
  uri: z.string(),
  user: z.string(),
  password: z.string(),
});

interface BubbleDomainInfo {
  id: string;
  title: string;
  domains: string[];
}

async function getBubbleDomains(client: Neo4jClient, bubbleId: string): Promise<BubbleDomainInfo> {
  const rows = await client.query<{ title: string; name: string | null }>(
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

interface SuggestedLink {
  targetBubbleId: string;
  confidence: number;
  relationshipType: string;
}

function isCurrentClient(client: Neo4jClient): boolean {
  return !degraded && neo4j === client;
}

function emitInsight(
  sourceBubble: BubbleDomainInfo,
  targetBubble: BubbleDomainInfo,
  link: SuggestedLink,
): void {
  eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: SUITE_PROACTIVE_INTELLIGENCE,
    type: 'knowledge:insight:cross-domain',
    payload: {
      sourceBubble,
      targetBubble,
      confidence: link.confidence,
      relationshipType: link.relationshipType,
    },
  });
  log.info(
    `Cross-domain insight: ${sourceBubble.title} → ${targetBubble.title} [${link.confidence}]`,
  );
}

async function processLink(
  client: Neo4jClient,
  bubbleId: string,
  link: SuggestedLink,
): Promise<void> {
  const sourceBubble = await getBubbleDomains(client, bubbleId);
  if (!isCurrentClient(client)) return;
  const targetBubble = await getBubbleDomains(client, link.targetBubbleId);
  if (!isCurrentClient(client)) return;
  if (sourceBubble.domains.length === 0 || targetBubble.domains.length === 0) return;
  if (haveDomainOverlap(sourceBubble.domains, targetBubble.domains)) return;
  const domainPair = makeDomainPairKey(sourceBubble.domains, targetBubble.domains);
  if (link.confidence < getAdaptiveThreshold(domainPair)) return;
  emitInsight(sourceBubble, targetBubble, link);
}

async function handleLinksSuggested(event: unknown): Promise<void> {
  const client = neo4j;
  if (!client || !isCurrentClient(client)) return;
  try {
    const { payload } = event as { payload: { bubbleId: string; links: SuggestedLink[] } };
    for (const link of payload.links) {
      if (!isCurrentClient(client)) return;
      await processLink(client, payload.bubbleId, link);
    }
  } catch (err) {
    log.error(`Cross-domain detection failed: ${err}`);
  }
}

const service: RavenService = {
  async start(context: ServiceContext): Promise<void> {
    await service.stop();
    eventBus = context.eventBus;
    db = context.db;

    confidenceThreshold = DEFAULT_THRESHOLD;
    const envThreshold = process.env.RAVEN_CROSS_DOMAIN_INSIGHT_THRESHOLD;
    if (envThreshold) {
      const parsed = parseFloat(envThreshold);
      if (!isNaN(parsed)) confidenceThreshold = parsed;
    }

    const graph = GraphConfigSchema.parse(context.config.neo4j);
    if (!graph.enabled) return;
    let client: Neo4jClient | undefined;
    try {
      client = createNeo4jClient(graph);
      neo4j = client;
      await client.query('RETURN 1');
    } catch (err) {
      if (neo4j === client) neo4j = undefined;
      await client
        ?.close()
        .catch((closeErr: unknown) => log.warn(`Graph cleanup failed: ${closeErr}`));
      log.warn(`Cross-domain graph unavailable: ${err}`);
      return;
    }
    // A concurrent stop owns disposal and prevents late subscription.
    if (neo4j !== client) return;

    degraded = false;
    eventBus.on('knowledge:links:suggested', handleLinksSuggested);
    log.info(`Cross-domain detector started (threshold: ${confidenceThreshold})`);
  },

  async stop(): Promise<void> {
    const client = neo4j;
    neo4j = undefined;
    degraded = true;
    eventBus?.off('knowledge:links:suggested', handleLinksSuggested);
    await client?.close();
    log.info('Cross-domain detector stopped');
  },
};

export default service;
