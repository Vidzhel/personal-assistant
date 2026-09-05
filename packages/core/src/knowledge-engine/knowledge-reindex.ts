import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { createLogger, generateId } from '@raven/shared';
import {
  listMarkdownFiles,
  parseMarkdownFile,
  writeBubbleFile,
  type ParsedBubbleFile,
} from './knowledge-file.ts';
import type { Neo4jClient } from './neo4j-client.ts';

const log = createLogger('knowledge-reindex');
const PREVIEW_LENGTH = 200;
const TimestampSchema = z.union([z.string(), z.date().transform((date) => date.toISOString())]);
const MetadataSchema = z.object({
  id: z.string().min(1).optional(),
  title: z.string().nullish(),
  tags: z.array(z.string()).nullish(),
  source: z.string().nullable().optional(),
  source_file: z.string().nullable().optional(),
  source_url: z.string().nullable().optional(),
  created_at: TimestampSchema.nullish(),
  updated_at: TimestampSchema.nullish(),
});

interface ReindexFile {
  name: string;
  raw: string;
  parsed: ParsedBubbleFile;
  metadata: z.infer<typeof MetadataSchema>;
}

function readCandidates(knowledgeDir: string): { files: ReindexFile[]; errors: string[] } {
  const files: ReindexFile[] = [];
  const errors: string[] = [];
  const identities = new Map<string, string>();
  for (const name of listMarkdownFiles(knowledgeDir)) {
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

async function indexFile(
  neo4j: Neo4jClient,
  knowledgeDir: string,
  file: ReindexFile,
): Promise<void> {
  const { metadata, parsed, name } = file;
  const id = metadata.id ?? generateId();
  if (!metadata.id) {
    if (readFileSync(join(knowledgeDir, name), 'utf8') !== file.raw) {
      throw new Error('Knowledge file changed during indexing; retry with the current file');
    }
    // Make the identity durable before a retry can create a second graph node.
    writeBubbleFile(join(knowledgeDir, name), { ...parsed.meta, id }, parsed.content);
  }
  const tags = [...new Set(metadata.tags ?? [])];
  await neo4j.withTransaction(async (tx) => {
    await tx.run(
      `MERGE (b:Bubble {id: $id})
       SET b.title = $title, b.filePath = $filePath, b.contentPreview = $contentPreview,
           b.source = $source, b.sourceFile = $sourceFile, b.sourceUrl = $sourceUrl,
           b.createdAt = coalesce($createdAt, b.createdAt, $now),
           b.updatedAt = coalesce($updatedAt, b.updatedAt, $now),
           b.permanence = coalesce(b.permanence, 'normal'),
           b.lastAccessedAt = coalesce(b.lastAccessedAt, $updatedAt, $now)`,
      {
        id,
        title: metadata.title ?? name.replace(/\.md$/, ''),
        filePath: name,
        contentPreview: parsed.content.slice(0, PREVIEW_LENGTH),
        source: metadata.source ?? null,
        sourceFile: metadata.source_file ?? null,
        sourceUrl: metadata.source_url ?? null,
        createdAt: metadata.created_at ?? null,
        updatedAt: metadata.updated_at ?? null,
        now: new Date().toISOString(),
      },
    );
    // Files own tag assignments. Retain other relationships and properties,
    // including graph-only lifecycle data and annotations on retained tags.
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
  });
}

/** Routine indexing refreshes files without guessing ownership of unmatched graph records. */
export async function reindexKnowledgeFiles(deps: {
  neo4j: Neo4jClient;
  knowledgeDir: string;
  signal?: AbortSignal;
}): Promise<{ indexed: number; errors: string[] }> {
  deps.signal?.throwIfAborted();
  const { files, errors } = readCandidates(deps.knowledgeDir);
  // An ambiguous/incomplete input batch must not partially overwrite the index.
  if (errors.length > 0) return { indexed: 0, errors };
  let indexed = 0;
  for (const file of files) {
    try {
      deps.signal?.throwIfAborted();
      await indexFile(deps.neo4j, deps.knowledgeDir, file);
      indexed++;
    } catch (error) {
      errors.push(`${file.name}: ${String(error)}`);
    }
  }
  log.info(
    `Knowledge file indexing complete: ${indexed} indexed, ${errors.length} errors; unmatched graph records retained`,
  );
  return { indexed, errors };
}
