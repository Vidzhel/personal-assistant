import { unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createLogger, generateId, type Permanence, type RavenEvent } from '@raven/shared';
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
  mergeBubbles: (bubbleIds: string[]) => Promise<string | undefined>;
  upgradePermanence: (id: string, newLevel: Permanence) => Promise<boolean>;
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
  const { neo4j, knowledgeStore, eventBus, embeddingEngine, chunkingEngine } = deps;
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

  // eslint-disable-next-line max-lines-per-function -- merge flow with LLM synthesis, link re-pointing, cleanup
  async function mergeBubbles(bubbleIds: string[]): Promise<string | undefined> {
    // Load all bubbles to merge
    const bubbles = [];
    for (const bid of bubbleIds) {
      const bubble = await knowledgeStore.getById(bid);
      if (bubble) bubbles.push(bubble);
    }

    if (bubbles.length < 2) {
      log.warn(`Merge requires at least 2 valid bubbles, got ${bubbles.length}`);
      return undefined;
    }

    // Synthesize merged content via agent task event
    const combinedContent = bubbles.map((b) => `## ${b.title}\n\n${b.content}`).join('\n\n---\n\n');

    const mergedTitle = `Merged: ${bubbles.map((b) => b.title).join(' + ')}`;

    // Collect all tags and domains from source bubbles
    const allTags = [...new Set(bubbles.flatMap((b) => b.tags))];

    // Synthesize merged content via LLM agent task
    let synthesizedContent = combinedContent;
    try {
      const synthesisTaskId = generateId();
      const synthesisPromise = new Promise<string>((resolve) => {
        const handler = (event: RavenEvent): void => {
          if (
            event.type === 'agent:task:complete' &&
            'payload' in event &&
            (event as { payload: { taskId: string } }).payload.taskId === synthesisTaskId
          ) {
            eventBus.off('agent:task:complete', handler);
            const result = (event as { payload: { result: string; success: boolean } }).payload;
            resolve(result.success ? result.result : combinedContent);
          }
        };
        eventBus.on('agent:task:complete', handler);
        // Timeout: fall back to concatenated content after 30s
        setTimeout(() => {
          eventBus.off('agent:task:complete', handler);
          resolve(combinedContent);
        }, MERGE_SYNTHESIS_TIMEOUT_MS);
      });

      eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: 'knowledge-lifecycle',
        type: 'agent:task:request',
        payload: {
          taskId: synthesisTaskId,
          prompt: [
            'Synthesize the following knowledge bubbles into a single coherent summary.',
            'Preserve all key facts, deduplicate overlapping content, and organize logically.',
            'Return ONLY the synthesized text, no preamble.',
            '',
            combinedContent,
          ].join('\n'),
          skillName: 'knowledge',
          mcpServers: {},
          priority: 'normal',
        },
      } as RavenEvent);

      synthesizedContent = await synthesisPromise;
    } catch (err) {
      log.warn(`LLM synthesis failed, using concatenated content: ${err}`);
    }

    // Create the merged bubble
    const merged = await knowledgeStore.insert({
      title: mergedTitle,
      content: synthesizedContent,
      tags: allTags,
      permanence: 'normal',
    });

    // Re-point incoming links from old bubbles to the merged bubble
    await neo4j.run(
      `UNWIND $oldIds AS oldId
       MATCH (source:Bubble)-[r:LINKS_TO]->(old:Bubble {id: oldId})
       WHERE NOT source.id IN $oldIds AND source.id <> $mergedId
       MATCH (merged:Bubble {id: $mergedId})
       CREATE (source)-[:LINKS_TO {
         id: r.id + '-repointed',
         relationshipType: r.relationshipType,
         confidence: r.confidence,
         autoSuggested: r.autoSuggested,
         status: r.status,
         createdAt: r.createdAt
       }]->(merged)
       DELETE r`,
      { oldIds: bubbleIds, mergedId: merged.id },
    );

    // Re-point outgoing links from old bubbles to originate from the merged bubble
    await neo4j.run(
      `UNWIND $oldIds AS oldId
       MATCH (old:Bubble {id: oldId})-[r:LINKS_TO]->(target:Bubble)
       WHERE NOT target.id IN $oldIds AND target.id <> $mergedId
       MATCH (merged:Bubble {id: $mergedId})
       CREATE (merged)-[:LINKS_TO {
         id: r.id + '-repointed',
         relationshipType: r.relationshipType,
         confidence: r.confidence,
         autoSuggested: r.autoSuggested,
         status: r.status,
         createdAt: r.createdAt
       }]->(target)
       DELETE r`,
      { oldIds: bubbleIds, mergedId: merged.id },
    );

    // Remove old bubbles (DETACH DELETE cleans up any remaining relationships)
    for (const bubble of bubbles) {
      await knowledgeStore.remove(bubble.id);
    }

    // Generate embedding and chunks for the merged bubble
    try {
      await embeddingEngine.generateAndStore(merged.id, combinedContent);
    } catch (err) {
      log.warn(`Failed to generate embedding for merged bubble ${merged.id}: ${err}`);
    }
    try {
      await chunkingEngine.indexBubble(merged.id);
    } catch (err) {
      log.warn(`Failed to index chunks for merged bubble ${merged.id}: ${err}`);
    }

    log.info(`Merged ${bubbles.length} bubbles into ${merged.id}: ${mergedTitle}`);

    eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'knowledge-lifecycle',
      type: 'knowledge:bubble:created',
      payload: {
        bubbleId: merged.id,
        title: mergedTitle,
        filePath: merged.filePath,
      },
    } as RavenEvent);

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
    detectStaleBubbles,
    snoozeBubble,
    removeBubbleWithMedia,
    mergeBubbles,
    upgradePermanence,
  };
}
