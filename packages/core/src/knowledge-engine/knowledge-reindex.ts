import { basename, dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { ManagedTransaction } from 'neo4j-driver';
import { z } from 'zod';
import { createLogger, generateId } from '@raven/shared';
import {
  listMarkdownFiles,
  parseMarkdownFile,
  resolveKnowledgePath,
  writeBubbleFile,
  BubbleFrontmatterSchema,
  type ParsedBubbleFile,
} from './knowledge-file.ts';
import { readPendingKnowledgeDeletions } from './knowledge-deletions.ts';
import type { Neo4jClient } from './neo4j-client.ts';
import { knowledgeRevision } from './knowledge-revision.ts';
import { chunkContent } from './chunking.ts';

const log = createLogger('knowledge-reindex');
const PREVIEW_LENGTH = 200;
const MetadataSchema = BubbleFrontmatterSchema.extend({ id: z.string().min(1).optional() });

interface ReindexFile {
  name: string;
  raw: string;
  parsed: ParsedBubbleFile;
  metadata: z.infer<typeof MetadataSchema>;
}

interface ExistingBubbleRevision {
  id: string;
  filePath?: string | null;
  title?: string | null;
  tags?: string[] | null;
  source?: string | null;
  sourceFile?: string | null;
  sourceUrl?: string | null;
  contentPreview?: string | null;
  sourceRevision?: string | null;
  embeddingRevision?: string | null;
  chunkRevision?: string | null;
  embeddingCount?: number;
  chunkCount?: number;
}

interface IndexFileDeps {
  neo4j: Neo4jClient;
  knowledgeDir: string;
  file: ReindexFile;
  existing?: ExistingBubbleRevision;
}

interface IndexedBubble {
  id: string;
  title: string;
  tags: string[];
  sourceRevision: string;
  filePath: string;
  contentPreview: string;
  source: string | null;
  sourceFile: string | null;
  sourceUrl: string | null;
  createdAt: string | Date | null | undefined;
  updatedAt: string | Date | null | undefined;
  expectedBytes: string;
  sourcePath: string;
  expectedChunkCount: number;
}

function readCandidates(knowledgeDir: string): { files: ReindexFile[]; errors: string[] } {
  const files: ReindexFile[] = [];
  const errors: string[] = [];
  const identities = new Map<string, string>();
  let names: string[];
  try {
    names = listMarkdownFiles(knowledgeDir);
  } catch (error) {
    return { files, errors: [`Knowledge directory cannot be indexed: ${String(error)}`] };
  }
  for (const name of names) {
    try {
      const raw = readFileSync(join(knowledgeDir, name), 'utf8');
      const parsed = parseMarkdownFile(raw);
      const metadata = MetadataSchema.parse(parsed.meta);
      const previous = metadata.id ? identities.get(metadata.id) : undefined;
      if (previous) {
        errors.push(`Duplicate knowledge identity ${metadata.id} in ${previous} and ${name}`);
      }
      if (metadata.id) identities.set(metadata.id, name);
      files.push({ name, raw, parsed, metadata });
    } catch (error) {
      errors.push(`${name}: ${String(error)}`);
    }
  }
  return { files, errors };
}

function assertSourceUnchanged(path: string, expectedBytes: string): void {
  const safePath = resolveKnowledgePath(dirname(path), basename(path));
  if (readFileSync(safePath, 'utf8') !== expectedBytes) {
    throw new Error('Knowledge file changed during indexing; retry with the current file');
  }
}

function differs<T>(actual: T | null | undefined, expected: T): boolean {
  if (actual === undefined) return false;
  if (Array.isArray(actual) && Array.isArray(expected)) {
    const normalize = (value: unknown[]): unknown[] => [...new Set(value)].sort();
    return JSON.stringify(normalize(actual)) !== JSON.stringify(normalize(expected));
  }
  return actual !== expected;
}

function metadataNeedsRefresh(existing: ExistingBubbleRevision, bubble: IndexedBubble): boolean {
  return [
    differs(existing.filePath, bubble.filePath),
    differs(existing.title, bubble.title),
    differs(existing.tags, bubble.tags),
    differs(existing.source, bubble.source),
    differs(existing.sourceFile, bubble.sourceFile),
    differs(existing.sourceUrl, bubble.sourceUrl),
    differs(existing.contentPreview, bubble.contentPreview),
  ].some(Boolean);
}

function derivedNeedsRefresh(existing: ExistingBubbleRevision, bubble: IndexedBubble): boolean {
  return [
    existing.sourceRevision !== bubble.sourceRevision,
    existing.embeddingRevision !== bubble.sourceRevision,
    existing.chunkRevision !== bubble.sourceRevision,
    existing.embeddingCount === 0,
    existing.chunkCount !== undefined && existing.chunkCount !== bubble.expectedChunkCount,
  ].some(Boolean);
}

function needsRefresh(
  existing: ExistingBubbleRevision | undefined,
  bubble: IndexedBubble,
): boolean {
  return (
    !existing || metadataNeedsRefresh(existing, bubble) || derivedNeedsRefresh(existing, bubble)
  );
}

async function writeTagRelationships(
  tx: ManagedTransaction,
  id: string,
  tags: string[],
): Promise<void> {
  await tx.run(
    `MATCH (b:Bubble {id: $id})-[r:HAS_TAG]->(t:Tag)
     WHERE NOT t.name IN $tags DELETE r`,
    { id, tags },
  );
  for (const tag of tags) {
    await tx.run(
      `MERGE (t:Tag {name: $tag}) WITH t
       MATCH (b:Bubble {id: $id}) MERGE (b)-[:HAS_TAG]->(t)`,
      { id, tag },
    );
  }
}

async function writeBubbleProperties(tx: ManagedTransaction, bubble: IndexedBubble): Promise<void> {
  const { id, title, filePath, contentPreview, source, sourceFile, sourceUrl, sourceRevision } =
    bubble;
  await tx.run(
    `MERGE (b:Bubble {id: $id})
     SET b.title = $title, b.filePath = $filePath, b.contentPreview = $contentPreview,
         b.source = $source, b.sourceFile = $sourceFile, b.sourceUrl = $sourceUrl,
         b.sourceRevision = $sourceRevision,
         b.createdAt = coalesce($createdAt, b.createdAt, $now),
         b.updatedAt = coalesce($updatedAt, b.updatedAt, $now),
         b.permanence = coalesce(b.permanence, 'normal'),
         b.lastAccessedAt = coalesce(b.lastAccessedAt, $updatedAt, $now)`,
    {
      id,
      title,
      filePath,
      contentPreview,
      source,
      sourceFile,
      sourceUrl,
      createdAt: bubble.createdAt ?? null,
      updatedAt: bubble.updatedAt ?? null,
      now: new Date().toISOString(),
      sourceRevision,
    },
  );
}

async function writeIndexedBubble(neo4j: Neo4jClient, bubble: IndexedBubble): Promise<void> {
  await neo4j.withTransaction(async (tx) => {
    assertSourceUnchanged(bubble.sourcePath, bubble.expectedBytes);
    await writeBubbleProperties(tx, bubble);
    await writeTagRelationships(tx, bubble.id, bubble.tags);
  });
}

async function indexFile(deps: IndexFileDeps): Promise<{ id: string; changed: boolean }> {
  const { file, knowledgeDir, existing } = deps;
  const { metadata, parsed, name } = file;
  const id = metadata.id ?? generateId();
  const title = metadata.title ?? basename(name, '.md');
  const tags = [...new Set(metadata.tags ?? [])].sort();
  const sourceRevision = knowledgeRevision({ title, content: parsed.content, tags });
  const sourcePath = resolveKnowledgePath(knowledgeDir, name);
  const bubble: IndexedBubble = {
    id,
    title,
    tags,
    sourceRevision,
    filePath: name,
    contentPreview: parsed.content.slice(0, PREVIEW_LENGTH),
    source: metadata.source ?? null,
    sourceFile: metadata.source_file ?? null,
    sourceUrl: metadata.source_url ?? null,
    createdAt: metadata.created_at,
    updatedAt: metadata.updated_at,
    expectedBytes: file.raw,
    sourcePath,
    expectedChunkCount: chunkContent(parsed.content).length,
  };
  const changed = needsRefresh(existing, bubble);
  let expectedBytes = file.raw;
  assertSourceUnchanged(sourcePath, expectedBytes);
  if (!metadata.id) {
    // Make the identity durable before a retry can create a second graph node.
    writeBubbleFile(sourcePath, { ...parsed.meta, id }, parsed.content);
    expectedBytes = readFileSync(sourcePath, 'utf8');
  }
  bubble.expectedBytes = expectedBytes;
  await writeIndexedBubble(deps.neo4j, bubble);
  return { id, changed };
}

async function indexOne(
  deps: IndexFileDeps & { signal?: AbortSignal },
): Promise<{ result?: { id: string; changed: boolean }; error?: string }> {
  try {
    deps.signal?.throwIfAborted();
    return { result: await indexFile(deps) };
  } catch (error) {
    return { error: `${deps.file.name}: ${String(error)}` };
  }
}

function pendingCandidates(
  knowledgeDir: string,
  files: ReindexFile[],
  errors: string[],
): ReindexFile[] {
  const pending = readPendingKnowledgeDeletions(knowledgeDir);
  const pendingIds = new Set(
    pending.flatMap((record) => [
      record.id,
      ...(record.mergeSourceIds ?? []),
      ...(record.mergeTargetId ? [record.mergeTargetId] : []),
    ]),
  );
  for (const file of files) {
    if (file.metadata.id && pendingIds.has(file.metadata.id)) {
      errors.push(
        `Pending deletion or merge protects knowledge identity ${file.metadata.id}; skipped ${file.name}`,
      );
    }
  }
  return files.filter((file) => !file.metadata.id || !pendingIds.has(file.metadata.id));
}

async function existingBubbles(neo4j: Neo4jClient): Promise<Map<string, ExistingBubbleRevision>> {
  const rows = await neo4j.query<ExistingBubbleRevision>(
    `MATCH (b:Bubble)
     OPTIONAL MATCH (b)-[:HAS_TAG]->(t:Tag)
     WITH b, collect(DISTINCT t.name) AS tags
     RETURN b.id AS id, b.filePath AS filePath, b.title AS title, tags,
            b.source AS source, b.sourceFile AS sourceFile, b.sourceUrl AS sourceUrl,
            b.contentPreview AS contentPreview,
            b.sourceRevision AS sourceRevision,
            b.embeddingRevision AS embeddingRevision,
            b.chunkRevision AS chunkRevision,
            size(coalesce(b.embedding, [])) AS embeddingCount,
            size([(b)-[:HAS_CHUNK]->() | 1]) AS chunkCount`,
  );
  return new Map(rows.filter((row) => row.id).map((row) => [row.id, row]));
}

async function readExistingBubbles(
  neo4j: Neo4jClient,
): Promise<{ existing?: Map<string, ExistingBubbleRevision>; error?: string }> {
  try {
    return { existing: await existingBubbles(neo4j) };
  } catch (error) {
    return { error: `Knowledge graph could not be read during reindex: ${String(error)}` };
  }
}

async function indexEligibleFiles(args: {
  deps: { neo4j: Neo4jClient; knowledgeDir: string; signal?: AbortSignal };
  files: ReindexFile[];
  errors: string[];
  existing: Map<string, ExistingBubbleRevision>;
}): Promise<{ indexed: number; changedIds: string[] }> {
  const { deps, files, errors, existing } = args;
  let indexed = 0;
  const changedIds: string[] = [];
  for (const file of files) {
    const { result, error } = await indexOne({
      neo4j: deps.neo4j,
      knowledgeDir: deps.knowledgeDir,
      file,
      existing: existing.get(file.metadata.id ?? ''),
      signal: deps.signal,
    });
    if (error) {
      errors.push(error);
      continue;
    }
    if (!result) continue;
    existing.set(result.id, { id: result.id });
    if (result.changed) changedIds.push(result.id);
    indexed++;
  }
  return { indexed, changedIds };
}

/** Routine indexing refreshes files without guessing ownership of unmatched graph records. */
export async function reindexKnowledgeFiles(deps: {
  neo4j: Neo4jClient;
  knowledgeDir: string;
  signal?: AbortSignal;
}): Promise<{ indexed: number; errors: string[]; changedIds: string[] }> {
  deps.signal?.throwIfAborted();
  const { files, errors } = readCandidates(deps.knowledgeDir);
  // An ambiguous/incomplete input batch must not partially overwrite the index.
  if (errors.length > 0) return { indexed: 0, errors, changedIds: [] };
  if (files.length === 0) return { indexed: 0, errors: [], changedIds: [] };
  let eligibleFiles: ReindexFile[];
  try {
    eligibleFiles = pendingCandidates(deps.knowledgeDir, files, errors);
  } catch (error) {
    return {
      indexed: 0,
      errors: [`Pending knowledge deletion records are invalid: ${String(error)}`],
      changedIds: [],
    };
  }
  if (eligibleFiles.length === 0) return { indexed: 0, errors, changedIds: [] };
  const graph = await readExistingBubbles(deps.neo4j);
  if (graph.error || !graph.existing) {
    return {
      indexed: 0,
      errors: [graph.error ?? 'Knowledge graph could not be read'],
      changedIds: [],
    };
  }
  const result = await indexEligibleFiles({
    deps,
    files: eligibleFiles,
    errors,
    existing: graph.existing,
  });
  log.info(
    `Knowledge file indexing complete: ${result.indexed} indexed, ${errors.length} errors; unmatched graph records retained`,
  );
  return { ...result, errors };
}
