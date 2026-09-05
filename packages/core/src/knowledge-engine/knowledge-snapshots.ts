import type { KnowledgeBubble } from '@raven/shared';
import type { KnowledgeStore } from './knowledge-store.ts';
import { knowledgeRevision } from './knowledge-revision.ts';

export interface KnowledgeSnapshot {
  bubble: KnowledgeBubble;
  revision: string;
}

/** Read canonical text without turning a maintenance preflight into an access. */
export async function readKnowledgeSnapshots(
  store: KnowledgeStore,
  ids: string[],
): Promise<KnowledgeSnapshot[]> {
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate knowledge source IDs');
  const snapshots: KnowledgeSnapshot[] = [];
  for (const id of ids) {
    const bubble = await store.getById(id, { trackAccess: false });
    if (!bubble) throw new Error(`Knowledge source is missing: ${id}`);
    snapshots.push({ bubble, revision: knowledgeRevision(bubble) });
  }
  return snapshots;
}

export function mergeSources(
  snapshots: KnowledgeSnapshot[],
): Array<{ id: string; revision: string }> {
  return snapshots.map(({ bubble, revision }) => ({ id: bubble.id, revision }));
}
