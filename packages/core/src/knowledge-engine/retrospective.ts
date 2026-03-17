import { createLogger, generateId, type RavenEvent } from '@raven/shared';
import type { Neo4jClient } from './neo4j-client.ts';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { KnowledgeLifecycle, StaleBubble } from './knowledge-lifecycle.ts';

const log = createLogger('retrospective');

const DEFAULT_RETROSPECTIVE_DAYS = 7;
const MS_PER_DAY = 86_400_000;
const MAX_TITLES_IN_SUMMARY = 10;

export interface RetrospectiveSummary {
  period: { since: string; until: string };
  bubblesCreated: { count: number; titles: string[] };
  bubblesUpdated: { count: number; titles: string[] };
  linksCreated: number;
  domainsChanged: number;
  tagsReorganized: number;
  staleBubbles: StaleBubble[];
  temporaryBubbles: StaleBubble[];
}

export interface Retrospective {
  generateSummary: (since?: string) => Promise<RetrospectiveSummary>;
  formatSummaryMarkdown: (summary: RetrospectiveSummary) => string;
  runFullRetrospective: () => Promise<RetrospectiveSummary>;
}

interface RetrospectiveDeps {
  neo4j: Neo4jClient;
  eventBus: EventBus;
  lifecycle: KnowledgeLifecycle;
}

// eslint-disable-next-line max-lines-per-function -- factory function for retrospective engine
export function createRetrospective(deps: RetrospectiveDeps): Retrospective {
  const { neo4j, eventBus, lifecycle } = deps;

  async function generateSummary(since?: string): Promise<RetrospectiveSummary> {
    const now = new Date();
    const sinceDate =
      since ?? new Date(now.getTime() - DEFAULT_RETROSPECTIVE_DAYS * MS_PER_DAY).toISOString();

    // Bubbles created since date
    const created = await neo4j.query<{ id: string; title: string }>(
      `MATCH (b:Bubble) WHERE b.createdAt >= $since
       RETURN b.id AS id, b.title AS title ORDER BY b.createdAt DESC`,
      { since: sinceDate },
    );

    // Bubbles updated (but not created) since date
    const updated = await neo4j.query<{ id: string; title: string }>(
      `MATCH (b:Bubble) WHERE b.updatedAt >= $since AND b.createdAt < $since
       RETURN b.id AS id, b.title AS title ORDER BY b.updatedAt DESC`,
      { since: sinceDate },
    );

    // Links created since date
    const linksRow = await neo4j.queryOne<{ count: number }>(
      `MATCH ()-[r:LINKS_TO]->() WHERE r.createdAt >= $since RETURN count(r) AS count`,
      { since: sinceDate },
    );

    // Domain changes — count bubbles with domain assignments since date
    const domainsRow = await neo4j.queryOne<{ count: number }>(
      `MATCH (b:Bubble)-[:IN_DOMAIN]->(d:Domain) WHERE b.updatedAt >= $since
       RETURN count(DISTINCT d) AS count`,
      { since: sinceDate },
    );

    // Tags — count new tags created (approximate: tags linked to recently created bubbles)
    const tagsRow = await neo4j.queryOne<{ count: number }>(
      `MATCH (b:Bubble)-[:HAS_TAG]->(t:Tag) WHERE b.createdAt >= $since
       RETURN count(DISTINCT t) AS count`,
      { since: sinceDate },
    );

    // Stale detection
    const staleBubbles = await lifecycle.detectStaleBubbles();
    const temporaryBubbles = staleBubbles.filter((b) => b.permanence === 'temporary');
    const normalStale = staleBubbles.filter((b) => b.permanence === 'normal');

    return {
      period: { since: sinceDate, until: now.toISOString() },
      bubblesCreated: { count: created.length, titles: created.map((b) => b.title) },
      bubblesUpdated: { count: updated.length, titles: updated.map((b) => b.title) },
      linksCreated: linksRow?.count ?? 0,
      domainsChanged: domainsRow?.count ?? 0,
      tagsReorganized: tagsRow?.count ?? 0,
      staleBubbles: normalStale,
      temporaryBubbles,
    };
  }

  // eslint-disable-next-line max-lines-per-function, complexity -- markdown formatting with multiple sections
  function formatSummaryMarkdown(summary: RetrospectiveSummary): string {
    const lines: string[] = [];
    lines.push('# Knowledge Retrospective');
    lines.push('');
    lines.push(
      `**Period:** ${summary.period.since.split('T')[0]} → ${summary.period.until.split('T')[0]}`,
    );
    lines.push('');

    // Activity summary
    lines.push('## Activity');
    lines.push(`- **${summary.bubblesCreated.count}** new bubbles added`);
    if (summary.bubblesCreated.count > 0) {
      for (const title of summary.bubblesCreated.titles.slice(0, MAX_TITLES_IN_SUMMARY)) {
        lines.push(`  - ${title}`);
      }
    }
    lines.push(`- **${summary.bubblesUpdated.count}** bubbles updated`);
    if (summary.bubblesUpdated.count > 0) {
      for (const title of summary.bubblesUpdated.titles.slice(0, MAX_TITLES_IN_SUMMARY)) {
        lines.push(`  - ${title}`);
      }
    }
    lines.push(`- **${summary.linksCreated}** new links`);
    lines.push(`- **${summary.domainsChanged}** domains active`);
    lines.push(`- **${summary.tagsReorganized}** tags in use`);
    lines.push('');

    // Temporary bubbles needing review
    if (summary.temporaryBubbles.length > 0) {
      lines.push('## Temporary Bubbles for Review');
      lines.push(`${summary.temporaryBubbles.length} temporary bubble(s) need review (expired):`);
      for (const b of summary.temporaryBubbles) {
        lines.push(
          `- **${b.title}** — ${b.daysSinceAccess} days since last access [${b.tags.join(', ')}]`,
        );
      }
      lines.push('');
    }

    // Stale bubbles
    if (summary.staleBubbles.length > 0) {
      lines.push('## Stale Knowledge');
      lines.push(`${summary.staleBubbles.length} bubble(s) haven't been accessed in a while:`);
      for (const b of summary.staleBubbles) {
        lines.push(
          `- **${b.title}** — ${b.daysSinceAccess} days since last access [${b.tags.join(', ')}]`,
        );
      }
      lines.push('');
    }

    if (summary.temporaryBubbles.length === 0 && summary.staleBubbles.length === 0) {
      lines.push('## Health');
      lines.push('All knowledge is fresh and actively used!');
      lines.push('');
    }

    return lines.join('\n');
  }

  async function runFullRetrospective(): Promise<RetrospectiveSummary> {
    log.info('Running full knowledge retrospective...');

    const summary = await generateSummary();
    const markdown = formatSummaryMarkdown(summary);

    // Emit notification event for Telegram/dashboard delivery
    eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'retrospective',
      type: 'notification',
      payload: {
        channel: 'all',
        title: 'Weekly Knowledge Retrospective',
        body: markdown,
      },
    } as RavenEvent);

    // Emit retrospective complete event
    eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'retrospective',
      type: 'knowledge:retrospective:complete',
      payload: {
        period: summary.period,
        bubblesCreated: summary.bubblesCreated.count,
        bubblesUpdated: summary.bubblesUpdated.count,
        linksCreated: summary.linksCreated,
        staleBubblesCount: summary.staleBubbles.length,
        temporaryBubblesCount: summary.temporaryBubbles.length,
      },
    } as RavenEvent);

    // Emit stale bubbles detected event if any found
    const allStale = [...summary.staleBubbles, ...summary.temporaryBubbles];
    if (allStale.length > 0) {
      eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: 'retrospective',
        type: 'knowledge:stale:detected',
        payload: {
          staleBubbleIds: allStale.map((b) => b.id),
          count: allStale.length,
        },
      } as RavenEvent);
    }

    log.info(
      `Retrospective complete: ${summary.bubblesCreated.count} created, ${summary.bubblesUpdated.count} updated, ${allStale.length} stale`,
    );

    return summary;
  }

  return { generateSummary, formatSummaryMarkdown, runFullRetrospective };
}
