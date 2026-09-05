import { createProcessorLifecycle } from './processor-lifecycle.ts';
import { readKnowledgeSnapshots, mergeSources } from './knowledge-snapshots.ts';
import { waitForAgentTask } from './task-completion.ts';
import { unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createLogger, generateId, type Permanence } from '@raven/shared';
import type { Neo4jClient } from './neo4j-client.ts';
import type { KnowledgeStore } from './knowledge-store.ts';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { EmbeddingEngine } from './embeddings.ts';
import type { ChunkingEngine } from './chunking.ts';

const log = createLogger('knowledge-lifecycle');

const DEFAULT_STALE_DAYS_NORMAL = 30;
const DEFAULT_STALE_DAYS_TEMPORARY = 7;
const MS_PER_DAY = 86_400_000;
const MERGE_SYNTHESIS_TIMEOUT_MS = 30_000;

function parseStaleDays(envVar: string | undefined, fallback: number): number {
  if (!envVar) return fallback;
  const parsed = parseInt(envVar, 10);
  return isNaN(parsed) ? fallback : parsed;
}

export interface StaleBubble {
  id: string;
  title: string;
  permanence: Permanence;
  lastAccessedAt: string;
  daysSinceAccess: number;
  reason: 'temporary-expired' | 'normal-stale';
  tags: string[];
  domains: string[];
}

export interface KnowledgeLifecycle {
  detectStaleBubbles: (overrideDays?: number) => Promise<StaleBubble[]>;
  snoozeBubble: (id: string, days: number) => Promise<string | null>;
  removeBubbleWithMedia: (id: string) => Promise<boolean>;
  mergeBubbles: (bubbleIds: string[]) => Promise<string>;
  upgradePermanence: (id: string, newLevel: Permanence) => Promise<boolean>;
  stop: () => Promise<void>;
}

interface LifecycleDeps {
  neo4j: Neo4jClient;
  knowledgeStore: KnowledgeStore;
  eventBus: EventBus;
  embeddingEngine: EmbeddingEngine;
  chunkingEngine: ChunkingEngine;
  knowledgeDir: string;
}

// eslint-disable-next-line max-lines-per-function -- factory function for knowledge lifecycle engine
export function createKnowledgeLifecycle(deps: LifecycleDeps): KnowledgeLifecycle {
  const { eventBus } = deps;
  const lifetime = createProcessorLifecycle(eventBus, 'knowledge-lifecycle');
  const neo4j = lifetime.guard(deps.neo4j);
  const knowledgeStore = lifetime.guard(deps.knowledgeStore);
  const embeddingEngine = lifetime.guard(deps.embeddingEngine);
  const chunkingEngine = lifetime.guard(deps.chunkingEngine);
  const mediaDir = resolve(deps.knowledgeDir, '..', 'media');

  const staleDaysNormal = parseStaleDays(
    process.env['RAVEN_STALE_DAYS_NORMAL'],
    DEFAULT_STALE_DAYS_NORMAL,
  );
  const staleDaysTemporary = parseStaleDays(
    process.env['RAVEN_STALE_DAYS_TEMPORARY'],
    DEFAULT_STALE_DAYS_TEMPORARY,
  );

  async function detectStaleBubbles(overrideDays?: number): Promise<StaleBubble[]> {
    const now = new Date();
    const normalThreshold = overrideDays ?? staleDaysNormal;
    const temporaryThreshold = overrideDays ?? staleDaysTemporary;

    const normalCutoff = new Date(now.getTime() - normalThreshold * MS_PER_DAY).toISOString();
    const temporaryCutoff = new Date(now.getTime() - temporaryThreshold * MS_PER_DAY).toISOString();

    const rows = await neo4j.query<{
      id: string;
      title: string;
      permanence: string;
      lastAccessedAt: string;
      tags: string[];
      domains: string[];
    }>(
      `MATCH (b:Bubble)
       WHERE b.permanence <> 'robust'
         AND (b.snoozedUntil IS NULL OR b.snoozedUntil < $now)
         AND (
           (b.permanence = 'normal' AND b.lastAccessedAt < $normalCutoff)
           OR (b.permanence = 'temporary' AND b.lastAccessedAt < $temporaryCutoff)
         )
       OPTIONAL MATCH (b)-[:HAS_TAG]->(t:Tag)
       OPTIONAL MATCH (b)-[:IN_DOMAIN]->(d:Domain)
       RETURN b.id AS id, b.title AS title, b.permanence AS permanence,
              b.lastAccessedAt AS lastAccessedAt,
              collect(DISTINCT t.name) AS tags,
              collect(DISTINCT d.name) AS domains
       ORDER BY b.lastAccessedAt ASC`,
      { now: now.toISOString(), normalCutoff, temporaryCutoff },
    );

    return rows.map((r) => {
      const lastAccessed = new Date(r.lastAccessedAt);
      const daysSinceAccess = Math.floor((now.getTime() - lastAccessed.getTime()) / MS_PER_DAY);
      return {
        id: r.id,
        title: r.title,
        permanence: r.permanence as Permanence,
        lastAccessedAt: r.lastAccessedAt,
        daysSinceAccess,
        reason: r.permanence === 'temporary' ? 'temporary-expired' : 'normal-stale',
        tags: r.tags.filter(Boolean),
        domains: r.domains.filter(Boolean),
      };
    });
  }

  async function snoozeBubble(id: string, days: number): Promise<string | null> {
    const snoozedUntil = new Date(Date.now() + days * MS_PER_DAY).toISOString();
    const result = await neo4j.run(
      `MATCH (b:Bubble {id: $id}) SET b.snoozedUntil = $snoozedUntil RETURN b.id AS id`,
      { id, snoozedUntil },
    );
    const found = result.records.length > 0;
    if (found) {
      log.info(`Snoozed bubble ${id} for ${days} days (until ${snoozedUntil})`);
      return snoozedUntil;
    }
    return null;
  }

  async function removeBubbleWithMedia(id: string): Promise<boolean> {
    const bubble = await knowledgeStore.getById(id);
    if (!bubble) return false;

    lifetime.assertActive();
    // Clean up source media file if present
    if (bubble.sourceFile) {
      const mediaPath = join(mediaDir, bubble.sourceFile);
      try {
        await unlink(mediaPath);
        log.info(`Deleted media file: ${mediaPath}`);
      } catch {
        // File may already be gone — not critical
        log.warn(`Media file not found for cleanup: ${mediaPath}`);
      }
    }

    const removed = await knowledgeStore.remove(id);
    if (removed) {
      log.info(`Removed bubble with media: ${id}`);
    }
    return removed;
  }

  async function synthesizeMerge(content: string): Promise<string> {
    const taskId = generateId();
    const completion = await waitForAgentTask({
      eventBus,
      taskId,
      timeoutMs: MERGE_SYNTHESIS_TIMEOUT_MS,
      signal: lifetime.signal,
      dispatch: () =>
        lifetime.emit({
          id: generateId(),
          timestamp: Date.now(),
          source: 'knowledge-lifecycle',
          type: 'agent:task:request',
          payload: {
            taskId,
            prompt: [
              'Synthesize these knowledge sources into a coherent summary.',
              'Preserve key facts, deduplicate overlapping content, and organize logically.',
              'Return only the synthesized text.',
              '',
              content,
            ].join('\n'),
            skillName: 'knowledge',
            mcpServers: {},
            priority: 'normal',
          },
        }),
    });
    lifetime.assertActive();
    if (completion.error || !completion.result?.trim()) {
      throw new Error(`Knowledge merge synthesis failed: ${completion.error ?? 'empty result'}`);
    }
    return completion.result;
  }

  async function refreshMergedBubble(id: string): Promise<void> {
    try {
      await embeddingEngine.refreshBubble(id);
      await chunkingEngine.indexBubble(id);
    } catch (error) {
      throw new Error(
        `Knowledge merge committed as ${id}, but derived refresh failed; retry reindex: ${String(error)}`,
        { cause: error },
      );
    }
  }

  async function mergeBubbles(bubbleIds: string[]): Promise<string> {
    if (bubbleIds.length < 2) throw new Error('Merge requires at least two distinct sources');
    const snapshots = await readKnowledgeSnapshots(knowledgeStore, bubbleIds);
    const content = snapshots
      .map(({ bubble }) => `## ${bubble.title}\n\n${bubble.content}`)
      .join('\n\n---\n\n');
    const synthesized = await synthesizeMerge(content);
    const merged = await knowledgeStore.mergeOwned({
      sources: mergeSources(snapshots),
      title: `Merged: ${snapshots.map(({ bubble }) => bubble.title).join(' + ')}`,
      content: synthesized,
      signal: lifetime.signal,
    });
    await refreshMergedBubble(merged.id);
    lifetime.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'knowledge-lifecycle',
      type: 'knowledge:bubble:created',
      payload: { bubbleId: merged.id, title: merged.title, filePath: merged.filePath },
    });
    return merged.id;
  }

  async function upgradePermanence(id: string, newLevel: Permanence): Promise<boolean> {
    const result = await neo4j.run(
      `MATCH (b:Bubble {id: $id}) SET b.permanence = $permanence RETURN b.id AS id`,
      { id, permanence: newLevel },
    );
    const success = result.records.length > 0;
    if (success) {
      log.info(`Upgraded permanence for bubble ${id} to ${newLevel}`);
    }
    return success;
  }

  return {
    detectStaleBubbles: (days) => lifetime.run(() => detectStaleBubbles(days)),
    snoozeBubble: (id, days) => lifetime.run(() => snoozeBubble(id, days)),
    removeBubbleWithMedia: (id) => lifetime.run(() => removeBubbleWithMedia(id)),
    mergeBubbles: (ids) => lifetime.run(() => mergeBubbles(ids)),
    upgradePermanence: (id, level) => lifetime.run(() => upgradePermanence(id, level)),
    stop: lifetime.stop,
  };
}
