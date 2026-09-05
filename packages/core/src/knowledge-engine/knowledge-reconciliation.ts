import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import type { Neo4jClient } from './neo4j-client.ts';
import {
  BubbleFrontmatterSchema,
  parseMarkdownFile,
  resolveKnowledgePath,
} from './knowledge-file.ts';
import { readPendingKnowledgeDeletions } from './knowledge-deletions.ts';
import { knowledgeRevision } from './knowledge-revision.ts';
import { chunkContent } from './chunking.ts';

const MetadataSchema = BubbleFrontmatterSchema.extend({ id: z.string().min(1).optional() });
const PREVIEW_LENGTH = 200;

export type KnowledgeReconciliationIssueCode =
  | 'file-only'
  | 'graph-only'
  | 'missing-identity'
  | 'malformed-file'
  | 'duplicate-identity'
  | 'unsafe-path'
  | 'path-mismatch'
  | 'metadata-mismatch'
  | 'stale-derived-index'
  | 'pending-deletion'
  | 'graph-read-failed';

export interface KnowledgeReconciliationIssue {
  code: KnowledgeReconciliationIssueCode;
  message: string;
  repair: string;
  id?: string;
  filePath?: string;
  graphFilePath?: string | null;
}

export interface KnowledgeReconciliationReport {
  knowledgeDir: string;
  filesScanned: number;
  graphNodesScanned: number;
  issues: KnowledgeReconciliationIssue[];
}

interface FileRecord {
  filePath: string;
  id?: string;
  title: string;
  tags: string[];
  source: string | null;
  sourceFile: string | null;
  sourceUrl: string | null;
  content: string;
  createdAt?: string;
  updatedAt?: string;
}

interface GraphRecord {
  id?: string;
  filePath?: string | null;
  title?: string | null;
  tags?: string[] | null;
  source?: string | null;
  sourceFile?: string | null;
  sourceUrl?: string | null;
  contentPreview?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  sourceRevision?: string | null;
  embeddingRevision?: string | null;
  chunkRevision?: string | null;
  embeddingCount?: number;
  chunkCount?: number;
}

function issue(
  details: Pick<KnowledgeReconciliationIssue, 'code' | 'message' | 'repair'> &
    Partial<KnowledgeReconciliationIssue>,
): KnowledgeReconciliationIssue {
  return details;
}

function rootIssue(knowledgeDir: string): KnowledgeReconciliationIssue | undefined {
  try {
    const rootStat = lstatSync(knowledgeDir);
    if (
      rootStat.isSymbolicLink() ||
      !rootStat.isDirectory() ||
      realpathSync(knowledgeDir) !== resolve(knowledgeDir)
    ) {
      return issue({
        code: 'unsafe-path',
        message: `Knowledge directory is not a real directory: ${knowledgeDir}`,
        repair: 'Replace the knowledge root with a regular directory before reconciling files.',
      });
    }
  } catch (error) {
    return issue({
      code: 'unsafe-path',
      message: `Knowledge directory cannot be inspected: ${knowledgeDir} (${String(error)})`,
      repair: 'Restore the directory as a real readable directory, then run reconciliation again.',
    });
  }
  return undefined;
}

function readFileEntry(
  knowledgeDir: string,
  entry: { name: string; isSymbolicLink: () => boolean; isFile: () => boolean },
): { file?: FileRecord; issue?: KnowledgeReconciliationIssue } {
  const filePath = join(knowledgeDir, entry.name);
  if (entry.isSymbolicLink()) {
    return {
      issue: issue({
        code: 'unsafe-path',
        message: `Knowledge file is a symlink: ${entry.name}`,
        repair: 'Replace the symlink with a regular Markdown file inside the knowledge directory.',
        filePath: entry.name,
      }),
    };
  }
  try {
    const stat = lstatSync(filePath);
    if (!stat.isFile() || !entry.isFile()) {
      return {
        issue: issue({
          code: 'unsafe-path',
          message: `Knowledge path is not a regular file: ${entry.name}`,
          repair: 'Move non-file entries out of the knowledge directory.',
          filePath: entry.name,
        }),
      };
    }
    return {
      file: parseFileRecord(
        entry.name,
        readFileSync(resolveKnowledgePath(knowledgeDir, entry.name), 'utf8'),
      ),
    };
  } catch (error) {
    return {
      issue: issue({
        code: 'malformed-file',
        message: `Knowledge file cannot be parsed: ${entry.name} (${String(error)})`,
        repair: 'Correct the Markdown frontmatter and rerun reconciliation.',
        filePath: entry.name,
      }),
    };
  }
}

function parseFileRecord(name: string, raw: string): FileRecord {
  const parsed = parseMarkdownFile(raw);
  const metadata = MetadataSchema.parse(parsed.meta);
  const title = metadata.title ?? basename(name, '.md');
  const tags = [...new Set(metadata.tags ?? [])].sort();
  return {
    filePath: name,
    id: metadata.id,
    title,
    tags,
    source: metadata.source ?? null,
    sourceFile: metadata.source_file ?? null,
    sourceUrl: metadata.source_url ?? null,
    content: parsed.content,
    createdAt: metadata.created_at,
    updatedAt: metadata.updated_at,
  };
}

function readFiles(knowledgeDir: string): {
  files: FileRecord[];
  issues: KnowledgeReconciliationIssue[];
  entries: number;
} {
  const files: FileRecord[] = [];
  const issues: KnowledgeReconciliationIssue[] = [];
  const rootError = rootIssue(knowledgeDir);
  if (rootError) return { files, issues: [rootError], entries: 0 };
  let entries;
  try {
    entries = readdirSync(knowledgeDir, { withFileTypes: true });
  } catch (error) {
    issues.push(
      issue({
        code: 'unsafe-path',
        message: `Knowledge directory cannot be read: ${knowledgeDir} (${String(error)})`,
        repair:
          'Restore the directory as a real readable directory, then run reconciliation again.',
      }),
    );
    return { files, issues, entries: 0 };
  }

  for (const entry of entries.filter((candidate) => candidate.name.endsWith('.md'))) {
    const result = readFileEntry(knowledgeDir, entry);
    if (result.file) {
      files.push(result.file);
      if (!result.file.id) {
        issues.push(
          issue({
            code: 'missing-identity',
            message: `Knowledge file has no durable identity: ${entry.name}`,
            repair: 'Assign an id in the Markdown frontmatter before choosing a graph repair.',
            filePath: entry.name,
          }),
        );
      }
    }
    if (result.issue) issues.push(result.issue);
  }
  return { files, issues, entries: entries.length };
}

function duplicateIssues(files: FileRecord[]): KnowledgeReconciliationIssue[] {
  const byId = new Map<string, string[]>();
  for (const file of files) {
    if (!file.id) continue;
    const paths = byId.get(file.id) ?? [];
    paths.push(file.filePath);
    byId.set(file.id, paths);
  }
  return [...byId].flatMap(([id, paths]) =>
    paths.length < 2
      ? []
      : [
          issue({
            code: 'duplicate-identity',
            message: `Knowledge identity ${id} appears in ${paths.join(' and ')}`,
            repair:
              'Choose one authoritative file for the identity and move or reassign the duplicate before indexing.',
            id,
            filePath: paths[0],
          }),
        ],
  );
}

function graphRecord(row: GraphRecord & { node?: GraphRecord }): GraphRecord {
  return row.node ?? row;
}

function nodePathIssue(
  node: GraphRecord,
  file: FileRecord,
): KnowledgeReconciliationIssue | undefined {
  return node.filePath === file.filePath
    ? undefined
    : issue({
        code: 'path-mismatch',
        message: `Bubble ${node.id} points to ${node.filePath ?? 'no file path'}, but its file is ${file.filePath}.`,
        repair:
          'Confirm the Markdown file, then run explicit file-to-graph repair to update the path.',
        id: node.id,
        filePath: file.filePath,
        graphFilePath: node.filePath,
      });
}

function valuesMatch(actual: unknown, expected: unknown): boolean {
  if (actual === undefined) return true;
  if (Array.isArray(actual) && Array.isArray(expected)) {
    const normalize = (value: unknown[]): unknown[] => [...new Set(value)].sort();
    return JSON.stringify(normalize(actual)) === JSON.stringify(normalize(expected));
  }
  return actual === expected;
}

function nodeMetadataIssue(
  node: GraphRecord,
  file: FileRecord,
): KnowledgeReconciliationIssue | undefined {
  const expectedPreview = file.content.slice(0, PREVIEW_LENGTH);
  const metadataMatches = [
    [node.title, file.title],
    [node.tags, file.tags],
    [node.source, file.source],
    [node.sourceFile, file.sourceFile],
    [node.sourceUrl, file.sourceUrl],
    [node.contentPreview, expectedPreview],
    [node.createdAt, file.createdAt ?? node.createdAt],
    [node.updatedAt, file.updatedAt ?? node.updatedAt],
  ].every(([actual, expected]) => valuesMatch(actual, expected));
  return metadataMatches
    ? undefined
    : issue({
        code: 'metadata-mismatch',
        message: `Graph Bubble ${node.id} metadata does not match its Markdown source.`,
        repair:
          'Review the Markdown frontmatter and content, then run explicit file-to-graph repair to refresh file-owned metadata.',
        id: node.id,
        filePath: file.filePath,
        graphFilePath: node.filePath,
      });
}

function nodeRevisionIssue(
  node: GraphRecord,
  file: FileRecord,
): KnowledgeReconciliationIssue | undefined {
  const source = knowledgeRevision({ title: file.title, content: file.content, tags: file.tags });
  return node.sourceRevision === source &&
    node.embeddingRevision === source &&
    node.chunkRevision === source &&
    node.embeddingCount !== 0 &&
    (node.chunkCount === undefined || node.chunkCount === chunkContent(file.content).length)
    ? undefined
    : issue({
        code: 'stale-derived-index',
        message: `Bubble ${node.id} has stale or missing source, embedding, or chunk revisions.`,
        repair:
          'Refresh the Bubble source first, then regenerate embeddings and chunks; retain usable old derived data until each replacement succeeds.',
        id: node.id,
        filePath: file.filePath,
      });
}

function graphNodeIssues(
  node: GraphRecord,
  filesById: Map<string, FileRecord>,
  graphIds: Set<string>,
): KnowledgeReconciliationIssue[] {
  const issues: KnowledgeReconciliationIssue[] = [];
  if (!node.id) {
    return [
      issue({
        code: 'missing-identity',
        message: 'Graph Bubble has no durable identity.',
        repair: 'Repair the graph identity explicitly before choosing a file-to-graph repair.',
        graphFilePath: node.filePath,
      }),
    ];
  }
  if (graphIds.has(node.id)) {
    issues.push(
      issue({
        code: 'duplicate-identity',
        message: `Graph contains duplicate Bubble identity ${node.id}.`,
        repair: 'Repair the graph uniqueness violation before indexing files.',
        id: node.id,
        graphFilePath: node.filePath,
      }),
    );
  }
  graphIds.add(node.id);
  const file = filesById.get(node.id);
  if (!file) {
    return [
      ...issues,
      issue({
        code: 'graph-only',
        message: `Graph Bubble ${node.id} has no matching Markdown identity.`,
        repair: 'Review the graph-only record and choose an explicit retention or deletion repair.',
        id: node.id,
        graphFilePath: node.filePath,
      }),
    ];
  }
  const pathIssue = nodePathIssue(node, file);
  if (pathIssue) issues.push(pathIssue);
  const metadataIssue = nodeMetadataIssue(node, file);
  if (metadataIssue) issues.push(metadataIssue);
  const revisionIssue = nodeRevisionIssue(node, file);
  if (revisionIssue) issues.push(revisionIssue);
  return issues;
}

function unsafeGraphPathIssue(node: GraphRecord): KnowledgeReconciliationIssue | undefined {
  const path = node.filePath;
  if (!path || (!isAbsolute(path) && !path.includes('\\') && !path.split('/').includes('..'))) {
    return undefined;
  }
  return issue({
    code: 'unsafe-path',
    message: `Graph Bubble ${node.id ?? 'without identity'} has unsafe file path ${path}.`,
    repair: 'Repair the graph path to a relative regular Markdown filename before indexing files.',
    id: node.id,
    graphFilePath: path,
  });
}

function graphPathIssue(
  node: GraphRecord,
  filesByPath: Map<string, FileRecord>,
): KnowledgeReconciliationIssue[] {
  const unsafeIssue = unsafeGraphPathIssue(node);
  if (unsafeIssue) return [unsafeIssue];
  const file = node.filePath ? filesByPath.get(node.filePath) : undefined;
  return file && file.id !== node.id
    ? [
        issue({
          code: 'path-mismatch',
          message: `Graph Bubble ${node.id} claims file path ${node.filePath}, whose frontmatter belongs to another identity.`,
          repair:
            'Do not rebind the graph node automatically; resolve the two identities explicitly.',
          id: node.id ?? undefined,
          filePath: node.filePath ?? undefined,
          graphFilePath: node.filePath,
        }),
      ]
    : [];
}

function graphPathIssues(
  graph: GraphRecord[],
  filesByPath: Map<string, FileRecord>,
): KnowledgeReconciliationIssue[] {
  return graph.flatMap((node) => graphPathIssue(node, filesByPath));
}

function graphIssues(files: FileRecord[], graph: GraphRecord[]): KnowledgeReconciliationIssue[] {
  const filesById = new Map(files.flatMap((file) => (file.id ? [[file.id, file]] : [])));
  const filesByPath = new Map(files.map((file) => [file.filePath, file]));
  const graphIds = new Set<string>();
  const issues = graph.flatMap((node) => graphNodeIssues(node, filesById, graphIds));

  for (const file of files) {
    if (file.id && !graphIds.has(file.id)) {
      issues.push(
        issue({
          code: 'file-only',
          message: `Markdown file ${file.filePath} has no matching graph Bubble.`,
          repair: 'Run explicit file-to-graph reindex after reviewing the file identity.',
          id: file.id,
          filePath: file.filePath,
        }),
      );
    }
  }
  return [...issues, ...graphPathIssues(graph, filesByPath)];
}

function pendingIssues(knowledgeDir: string): KnowledgeReconciliationIssue[] {
  try {
    const issues = readPendingKnowledgeDeletions(knowledgeDir).flatMap((record) => {
      const ids = record.mergeTargetId
        ? [...new Set([...(record.mergeSourceIds ?? [record.id]), record.mergeTargetId])]
        : [record.id];
      return ids.map((id) =>
        issue({
          code: 'pending-deletion',
          message: record.mergeTargetId
            ? `Knowledge identity ${id} is protected by pending merge deletion for ${record.filePath} (target ${record.mergeTargetId}).`
            : `Knowledge identity ${record.id} has a pending deletion for ${record.filePath}.`,
          repair: record.mergeTargetId
            ? `Recover merge target ${record.mergeTargetId} before clearing this intent; do not reindex any declared merge source while it exists.`
            : 'Finish or cancel the recorded deletion before reconciling this identity; do not reindex it while the intent exists.',
          id,
          filePath:
            id === record.mergeTargetId
              ? record.mergeTargetFilePath
              : id === record.id
                ? record.filePath
                : undefined,
        }),
      );
    });
    return [...new Map(issues.map((item) => [item.id, item])).values()];
  } catch (error) {
    return [
      issue({
        code: 'pending-deletion',
        message: `Pending knowledge deletion records are invalid: ${String(error)}`,
        repair:
          'Repair or quarantine the malformed pending deletion record before indexing any knowledge files.',
      }),
    ];
  }
}

/** Read-only comparison of Markdown knowledge files and Bubble graph records. */
export async function reconcileKnowledgeFiles(deps: {
  neo4j: Neo4jClient;
  knowledgeDir: string;
}): Promise<KnowledgeReconciliationReport> {
  const { files, issues, entries } = readFiles(deps.knowledgeDir);
  issues.push(...duplicateIssues(files));
  issues.push(...pendingIssues(deps.knowledgeDir));
  let graph: GraphRecord[] = [];
  try {
    graph = await deps.neo4j.query<GraphRecord>(
      `MATCH (b:Bubble)
       OPTIONAL MATCH (b)-[:HAS_TAG]->(t:Tag)
       WITH b, collect(DISTINCT t.name) AS tags
       RETURN b.id AS id, b.filePath AS filePath,
              b.title AS title, tags,
              b.source AS source, b.sourceFile AS sourceFile, b.sourceUrl AS sourceUrl,
              b.contentPreview AS contentPreview,
              b.createdAt AS createdAt, b.updatedAt AS updatedAt,
              b.sourceRevision AS sourceRevision,
              b.embeddingRevision AS embeddingRevision,
              b.chunkRevision AS chunkRevision,
              size(coalesce(b.embedding, [])) AS embeddingCount,
              size([(b)-[:HAS_CHUNK]->() | 1]) AS chunkCount`,
    );
    graph = graph.map((row) => graphRecord(row as GraphRecord & { node?: GraphRecord }));
    issues.push(...graphIssues(files, graph));
  } catch (error) {
    issues.push(
      issue({
        code: 'graph-read-failed',
        message: `Graph Bubble records could not be read: ${String(error)}`,
        repair:
          'Restore graph connectivity and rerun the read-only reconciliation before choosing repairs.',
      }),
    );
  }
  return {
    knowledgeDir: deps.knowledgeDir,
    filesScanned: entries,
    graphNodesScanned: graph.length,
    issues,
  };
}
