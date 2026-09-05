import { existsSync, readFileSync } from 'node:fs';
import type { ManagedTransaction } from 'neo4j-driver';
import type { BubbleFrontmatter } from './knowledge-file.ts';
import {
  deleteOwnedBubbleFile,
  readOwnedBubbleFile,
  resolveKnowledgePath,
  serializeMarkdownFile,
  sha256,
  writeOwnedBubbleFile,
} from './knowledge-file.ts';
import {
  readPendingKnowledgeDeletions,
  removePendingKnowledgeDeletion,
  type PendingKnowledgeDeletion,
  writePendingKnowledgeDeletion,
} from './knowledge-deletions.ts';
import { knowledgeRevision } from './knowledge-revision.ts';
import type { Neo4jClient } from './neo4j-client.ts';

const MERGE_PREVIEW_LENGTH = 200;

export interface MergeSourceSnapshot {
  id: string;
  filePath: string;
  fileHash: string;
  title: string;
  tags: string[];
  source: string | null;
  sourceFile: string | null;
  sourceUrl: string | null;
  createdAt: string;
  meta: BubbleFrontmatter;
  node: Record<string, unknown>;
}

export interface MergeGraphPlan {
  targetId: string;
  anchorId: string;
  sourceIds: string[];
  filePath: string;
  title: string;
  tags: string[];
  contentPreview: string;
  source: string | null;
  sourceFile: string | null;
  sourceUrl: string | null;
  createdAt: string;
  updatedAt: string;
  sourceRevision: string;
  lastAccessedAt: string | null;
  permanence: string;
}

export interface PreparedMerge {
  snapshots: MergeSourceSnapshot[];
  targetMeta: BubbleFrontmatter;
  targetHash: string;
  targetPath: string;
  targetId: string;
  content: string;
  plan: MergeGraphPlan;
  intents: PendingKnowledgeDeletion[];
}

export class MergeMutationError extends Error {
  readonly targetId: string;
  readonly cause: unknown;

  constructor(targetId: string, cause: unknown, phase = 'graph transaction') {
    super(
      `Knowledge merge ${phase} failed for ${targetId}; inspect pending merge evidence and recover explicitly: ${String(cause)}`,
    );
    this.name = 'MergeMutationError';
    this.targetId = targetId;
    this.cause = cause;
  }
}

interface ReadMergeSourceDeps {
  neo4j: Neo4jClient;
  knowledgeDir: string;
  assertActive: (signal?: AbortSignal) => void;
}

function firstString(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string') return value;
  }
  return null;
}

export async function readMergeSources(
  deps: ReadMergeSourceDeps,
  sources: Array<{ id: string; revision: string }>,
  signal?: AbortSignal,
): Promise<MergeSourceSnapshot[]> {
  deps.assertActive(signal);
  const ids = sources.map((source) => source.id);
  if (ids.length < 2 || new Set(ids).size !== ids.length) {
    throw new Error('Knowledge merge requires at least two distinct source IDs');
  }
  const pending = readPendingKnowledgeDeletions(deps.knowledgeDir);
  const blocked = new Set(
    pending.flatMap((record) => [
      record.id,
      ...(record.mergeSourceIds ?? []),
      ...(record.mergeTargetId ? [record.mergeTargetId] : []),
    ]),
  );
  const blockedId = ids.find((id) => blocked.has(id));
  if (blockedId) throw new Error(`Knowledge merge source has a pending deletion: ${blockedId}`);
  const rows = await deps.neo4j.query<{ node: Record<string, unknown> }>(
    `MATCH (b:Bubble) WHERE b.id IN $ids RETURN b {.*} AS node`,
    { ids },
  );
  const byId = new Map(rows.map((row) => [String(row.node.id), row.node]));
  const snapshots = sources.map((source) => readOneMergeSource(deps.knowledgeDir, source, byId));
  deps.assertActive(signal);
  await assertMergeProjectScope(deps.neo4j, ids);
  deps.assertActive(signal);
  return snapshots;
}

function readOneMergeSource(
  knowledgeDir: string,
  source: { id: string; revision: string },
  byId: Map<string, Record<string, unknown>>,
): MergeSourceSnapshot {
  const node = byId.get(source.id);
  if (!node) throw new Error(`Knowledge merge source not found: ${source.id}`);
  const filePath = String(node.filePath ?? '');
  const file = readOwnedBubbleFile(knowledgeDir, filePath, source.id);
  const title = firstString([file.parsed.meta.title, node.title, source.id]) ?? source.id;
  const tags = [...new Set(file.parsed.meta.tags ?? [])].sort();
  const actual = knowledgeRevision({ title, content: file.parsed.content, tags });
  if (actual !== source.revision)
    throw new Error(`Knowledge source changed during merge: ${source.id}`);
  return {
    id: source.id,
    filePath,
    fileHash: file.hash,
    title,
    tags,
    source: firstString([file.parsed.meta.source, node.source]),
    sourceFile: firstString([file.parsed.meta.source_file, node.sourceFile]),
    sourceUrl: firstString([file.parsed.meta.source_url, node.sourceUrl]),
    createdAt:
      firstString([file.parsed.meta.created_at, node.createdAt, new Date().toISOString()]) ??
      new Date().toISOString(),
    meta: file.parsed.meta,
    node,
  };
}

async function assertMergeProjectScope(neo4j: Neo4jClient, ids: string[]): Promise<void> {
  const rows = await neo4j.query<{ bubbleId: string; projectId: string }>(
    `MATCH (b:Bubble)-[:BELONGS_TO_PROJECT]->(p:Project)
     WHERE b.id IN $ids RETURN b.id AS bubbleId, p.id AS projectId`,
    { ids },
  );
  const projects = new Map<string, string[]>();
  for (const row of rows) {
    const values = projects.get(row.bubbleId) ?? [];
    if (!values.includes(row.projectId)) values.push(row.projectId);
    projects.set(row.bubbleId, values);
  }
  const expected = [...(projects.get(ids[0]) ?? [])].sort().join('\0');
  if (ids.some((id) => [...(projects.get(id) ?? [])].sort().join('\0') !== expected)) {
    throw new Error(`Knowledge merge sources cross project scope: ${ids.join(', ')}`);
  }
}

export function prepareMerge(input: {
  snapshots: MergeSourceSnapshot[];
  title: string;
  content: string;
  targetId: string;
  targetPath: string;
  now: string;
}): PreparedMerge {
  const { snapshots, title, content, targetId, targetPath, now } = input;
  const anchor = snapshots[0];
  const tags = [...new Set(snapshots.flatMap((snapshot) => snapshot.tags))].sort();
  const targetMeta = buildTargetMeta({ anchor, targetId, title, tags, now });
  const targetHash = sha256(serializeMarkdownFile(targetMeta, content));
  const sourceIds = snapshots.map((snapshot) => snapshot.id);
  const plan = buildMergePlan({
    anchor,
    targetId,
    targetPath,
    title,
    tags,
    content,
    sourceIds,
    snapshots,
    now,
  });
  return {
    snapshots,
    targetMeta,
    targetHash,
    targetPath,
    targetId,
    content,
    plan,
    intents: snapshots.map((snapshot) => ({
      id: snapshot.id,
      filePath: snapshot.filePath,
      fileHash: snapshot.fileHash,
      mergeTargetId: targetId,
      mergeTargetFilePath: targetPath,
      mergeTargetFileHash: targetHash,
      mergeSourceIds: sourceIds,
    })),
  };
}

function buildTargetMeta(input: {
  anchor: MergeSourceSnapshot;
  targetId: string;
  title: string;
  tags: string[];
  now: string;
}): BubbleFrontmatter {
  return {
    ...input.anchor.meta,
    id: input.targetId,
    title: input.title,
    tags: input.tags,
    source: input.anchor.source,
    source_file: input.anchor.sourceFile,
    source_url: input.anchor.sourceUrl,
    created_at: input.anchor.createdAt,
    updated_at: input.now,
  };
}

function buildMergePlan(input: {
  anchor: MergeSourceSnapshot;
  targetId: string;
  targetPath: string;
  title: string;
  tags: string[];
  content: string;
  sourceIds: string[];
  snapshots: MergeSourceSnapshot[];
  now: string;
}): MergeGraphPlan {
  return {
    targetId: input.targetId,
    anchorId: input.anchor.id,
    sourceIds: input.sourceIds,
    filePath: input.targetPath,
    title: input.title,
    tags: input.tags,
    contentPreview: input.content.slice(0, MERGE_PREVIEW_LENGTH),
    source: input.anchor.source,
    sourceFile: input.anchor.sourceFile,
    sourceUrl: input.anchor.sourceUrl,
    createdAt: input.anchor.createdAt,
    updatedAt: input.now,
    sourceRevision: knowledgeRevision({
      title: input.title,
      content: input.content,
      tags: input.tags,
    }),
    lastAccessedAt: (input.anchor.node.lastAccessedAt as string | null) ?? input.now,
    permanence: strongestPermanence(input.snapshots),
  };
}

function strongestPermanence(snapshots: MergeSourceSnapshot[]): string {
  const levels = ['temporary', 'normal', 'robust'];
  return snapshots.reduce((strongest, snapshot) => {
    const current = String(snapshot.node.permanence ?? 'normal');
    return levels.indexOf(current) > levels.indexOf(strongest) ? current : strongest;
  }, 'temporary');
}

export function writeMergeFiles(knowledgeDir: string, prepared: PreparedMerge): void {
  for (const intent of prepared.intents) writePendingKnowledgeDeletion(knowledgeDir, intent);
  writeOwnedBubbleFile({
    knowledgeDir,
    fileName: prepared.targetPath,
    meta: prepared.targetMeta,
    content: prepared.content,
    expectedHash: null,
  });
}

export function assertMergeSourcesUnchanged(input: {
  knowledgeDir: string;
  snapshots: MergeSourceSnapshot[];
  assertActive: (signal?: AbortSignal) => void;
  signal?: AbortSignal;
}): void {
  input.assertActive(input.signal);
  for (const snapshot of input.snapshots) {
    const current = readOwnedBubbleFile(input.knowledgeDir, snapshot.filePath, snapshot.id);
    if (current.hash !== snapshot.fileHash) {
      throw new Error(`Knowledge source changed before merge: ${snapshot.id}`);
    }
  }
}

export function cleanupMergeSources(input: {
  knowledgeDir: string;
  snapshots: MergeSourceSnapshot[];
  assertActive: (signal?: AbortSignal) => void;
  signal?: AbortSignal;
}): void {
  for (const snapshot of input.snapshots) {
    if (existsSync(resolveKnowledgePath(input.knowledgeDir, snapshot.filePath))) {
      const current = readOwnedBubbleFile(input.knowledgeDir, snapshot.filePath, snapshot.id);
      if (current.hash !== snapshot.fileHash) {
        throw new Error(`Knowledge source changed before merge cleanup: ${snapshot.id}`);
      }
    }
  }
  for (const snapshot of input.snapshots) {
    input.assertActive(input.signal);
    if (existsSync(resolveKnowledgePath(input.knowledgeDir, snapshot.filePath))) {
      deleteOwnedBubbleFile(input.knowledgeDir, snapshot.filePath, snapshot.fileHash);
    }
  }
  for (const snapshot of input.snapshots) {
    removePendingKnowledgeDeletion(input.knowledgeDir, snapshot.id);
  }
}

export interface MergeRecoveryRecords {
  sourceIds: string[];
  targetPath: string;
  targetHash: string;
  records: PendingKnowledgeDeletion[];
}

export function validateRecoveryRecords(
  targetId: string,
  records: PendingKnowledgeDeletion[],
): MergeRecoveryRecords {
  const first = records[0];
  const sourceIds = first?.mergeSourceIds ?? [];
  if (!first?.mergeTargetFilePath || !first.mergeTargetFileHash || sourceIds.length === 0) {
    throw new Error(`Pending merge metadata is incomplete for ${targetId}`);
  }
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new Error(`Pending merge IDs conflict for ${targetId}`);
  }
  assertRecoveryRecordIds(targetId, records, sourceIds);
  assertRecoveryRecordTarget(targetId, records, first);
  return {
    sourceIds,
    targetPath: first.mergeTargetFilePath,
    targetHash: first.mergeTargetFileHash,
    records,
  };
}

function assertRecoveryRecordIds(
  targetId: string,
  records: PendingKnowledgeDeletion[],
  sourceIds: string[],
): void {
  const sourceSet = sourceIds.join('\0');
  if (
    records.some(
      (record) =>
        record.mergeTargetId !== targetId ||
        !sourceIds.includes(record.id) ||
        record.mergeSourceIds?.join('\0') !== sourceSet,
    )
  ) {
    throw new Error(`Pending merge source metadata is conflicting for ${targetId}`);
  }
}

function assertRecoveryRecordTarget(
  targetId: string,
  records: PendingKnowledgeDeletion[],
  first: PendingKnowledgeDeletion,
): void {
  if (
    records.some(
      (record) =>
        record.mergeTargetFilePath !== first.mergeTargetFilePath ||
        record.mergeTargetFileHash !== first.mergeTargetFileHash,
    )
  ) {
    throw new Error(`Pending merge target is conflicting for ${targetId}`);
  }
}

export async function readMergeState(
  tx: ManagedTransaction,
  targetId: string,
  sourceIds: string[],
): Promise<{ targetPresent: boolean; allSourcesPresent: boolean; allSourcesAbsent: boolean }> {
  const result = await tx.run(
    `OPTIONAL MATCH (target:Bubble {id: $targetId})
     WITH count(target) > 0 AS targetPresent
     OPTIONAL MATCH (source:Bubble) WHERE source.id IN $sourceIds
     RETURN targetPresent, count(source) = size($sourceIds) AS allSourcesPresent,
            count(source) = 0 AS allSourcesAbsent`,
    { targetId, sourceIds },
  );
  const record = result.records[0];
  return {
    targetPresent: record?.get('targetPresent') === true,
    allSourcesPresent: record?.get('allSourcesPresent') === true,
    allSourcesAbsent: record?.get('allSourcesAbsent') === true,
  };
}

export function cleanupRecoveredSources(input: {
  knowledgeDir: string;
  records: PendingKnowledgeDeletion[];
  assertActive: () => void;
}): void {
  for (const record of input.records) {
    input.assertActive();
    if (!existsSync(resolveKnowledgePath(input.knowledgeDir, record.filePath))) continue;
    const current = readOwnedBubbleFile(input.knowledgeDir, record.filePath, record.id);
    if (current.hash !== record.fileHash) {
      throw new Error(`Knowledge source changed during merge recovery: ${record.id}`);
    }
  }
  for (const record of input.records) {
    input.assertActive();
    if (existsSync(resolveKnowledgePath(input.knowledgeDir, record.filePath))) {
      deleteOwnedBubbleFile(input.knowledgeDir, record.filePath, record.fileHash);
    }
  }
  for (const record of input.records) {
    input.assertActive();
    removePendingKnowledgeDeletion(input.knowledgeDir, record.id);
  }
}

export function rollbackMergeFiles(input: {
  knowledgeDir: string;
  targetPath: string;
  targetId: string;
  targetHash: string;
  records: PendingKnowledgeDeletion[];
  assertActive: () => void;
}): void {
  input.assertActive();
  const path = resolveKnowledgePath(input.knowledgeDir, input.targetPath);
  if (existsSync(path)) {
    const current = readFileSync(path, 'utf8');
    if (sha256(current) !== input.targetHash) {
      throw new Error(`Merged target file changed during rollback: ${input.targetId}`);
    }
    deleteOwnedBubbleFile(input.knowledgeDir, input.targetPath, input.targetHash);
  }
  for (const record of input.records) {
    input.assertActive();
    removePendingKnowledgeDeletion(input.knowledgeDir, record.id);
  }
}

export function assertRecoverySourcesUnchanged(
  knowledgeDir: string,
  records: PendingKnowledgeDeletion[],
): void {
  for (const record of records) {
    const path = resolveKnowledgePath(knowledgeDir, record.filePath);
    if (!existsSync(path))
      throw new Error(`Knowledge source is missing during recovery: ${record.id}`);
    const current = readOwnedBubbleFile(knowledgeDir, record.filePath, record.id);
    if (current.hash !== record.fileHash) {
      throw new Error(`Knowledge source changed during recovery: ${record.id}`);
    }
  }
}

async function copyLinks(
  tx: ManagedTransaction,
  plan: MergeGraphPlan,
  guard: () => void,
): Promise<void> {
  guard();
  await tx.run(
    `MATCH (source:Bubble)-[r:LINKS_TO]->(old:Bubble)
     WHERE old.id IN $sourceIds AND NOT source.id IN $sourceIds AND source.id <> $targetId
     MATCH (target:Bubble {id: $targetId}) CREATE (source)-[copy:LINKS_TO]->(target)
     SET copy = properties(r) DELETE r`,
    plan,
  );
  guard();
  await tx.run(
    `MATCH (old:Bubble)-[r:LINKS_TO]->(destination:Bubble)
     WHERE old.id IN $sourceIds AND NOT destination.id IN $sourceIds AND destination.id <> $targetId
     MATCH (target:Bubble {id: $targetId}) CREATE (target)-[copy:LINKS_TO]->(destination)
     SET copy = properties(r) DELETE r`,
    plan,
  );
}

async function copyMemberships(
  tx: ManagedTransaction,
  plan: MergeGraphPlan,
  guard: () => void,
): Promise<void> {
  for (const type of ['BELONGS_TO_PROJECT', 'IN_DOMAIN', 'IN_CLUSTER']) {
    guard();
    await tx.run(
      `MATCH (old:Bubble)-[r:${type}]->(group)
       WHERE old.id IN $sourceIds MATCH (target:Bubble {id: $targetId})
       WHERE NOT EXISTS {
         MATCH (target)-[existing:${type}]->(group)
         WHERE properties(existing) = properties(r)
       }
       CREATE (target)-[copy:${type}]->(group) SET copy = properties(r)`,
      plan,
    );
  }
}

async function copyTags(
  tx: ManagedTransaction,
  plan: MergeGraphPlan,
  guard: () => void,
): Promise<void> {
  guard();
  await tx.run(
    `MATCH (old:Bubble)-[r:HAS_TAG]->(tag:Tag)
     WHERE old.id IN $sourceIds AND tag.name IN $tags
     MATCH (target:Bubble {id: $targetId})
     WHERE NOT EXISTS {
       MATCH (target)-[existing:HAS_TAG]->(tag)
       WHERE properties(existing) = properties(r)
     }
     CREATE (target)-[copy:HAS_TAG]->(tag) SET copy = properties(r)`,
    plan,
  );
  guard();
  await tx.run(
    `UNWIND $tags AS tag MERGE (t:Tag {name: tag})
     WITH t MATCH (target:Bubble {id: $targetId}) MERGE (target)-[:HAS_TAG]->(t)`,
    plan,
  );
}

/** Transfer graph-owned durable state and remove source nodes atomically. */
export async function mergeGraph(
  tx: ManagedTransaction,
  plan: MergeGraphPlan,
  guard: () => void = () => undefined,
): Promise<void> {
  guard();
  const sources = await tx.run(
    `MATCH (source:Bubble) WHERE source.id IN $sourceIds
     RETURN count(source) = size($sourceIds) AS allSourcesPresent`,
    plan,
  );
  if (sources.records[0]?.get('allSourcesPresent') !== true) {
    throw new Error('Knowledge merge source graph identity changed before transaction');
  }
  guard();
  await tx.run(
    `MATCH (anchor:Bubble {id: $anchorId}) CREATE (target:Bubble)
     SET target = anchor {.*, id: $targetId, title: $title,
         filePath: $filePath, contentPreview: $contentPreview,
         source: $source, sourceFile: $sourceFile, sourceUrl: $sourceUrl,
         createdAt: $createdAt, updatedAt: $updatedAt,
         sourceRevision: $sourceRevision, lastAccessedAt: $lastAccessedAt,
         permanence: $permanence}
     REMOVE target.embedding, target.embeddingRevision, target.chunkRevision`,
    plan,
  );
  await copyTags(tx, plan, guard);
  await copyLinks(tx, plan, guard);
  await copyMemberships(tx, plan, guard);
  guard();
  await tx.run(
    `UNWIND $sourceIds AS sourceId MATCH (old:Bubble {id: sourceId})-[:HAS_CHUNK]->(chunk:Chunk)
     DETACH DELETE chunk`,
    plan,
  );
  guard();
  await tx.run(`MATCH (old:Bubble) WHERE old.id IN $sourceIds DETACH DELETE old`, plan);
}
