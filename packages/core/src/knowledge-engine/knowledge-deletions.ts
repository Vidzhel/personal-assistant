import { lstatSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import {
  atomicWriteKnowledgeText,
  deleteBubbleFile,
  resolveKnowledgePath,
} from './knowledge-file.ts';

const PENDING_DIRECTORY = '.raven-pending-deletions';
const PendingKnowledgeDeletionSchema = z
  .object({
    id: z.string().min(1),
    filePath: z.string().min(1),
    fileHash: z.string().regex(/^[0-9a-f]{64}$/),
    mergeTargetId: z.string().min(1).optional(),
    mergeTargetFilePath: z.string().min(1).optional(),
    mergeTargetFileHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    mergeSourceIds: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict()
  .superRefine((record, context) => {
    const mergeFields = [
      record.mergeTargetId,
      record.mergeTargetFilePath,
      record.mergeTargetFileHash,
      record.mergeSourceIds,
    ];
    const hasMerge = mergeFields.some((field) => field !== undefined);
    if (hasMerge && mergeFields.some((field) => field === undefined)) {
      context.addIssue({ code: 'custom', message: 'Merge deletion metadata must be complete' });
    }
    if (record.mergeSourceIds && !record.mergeSourceIds.includes(record.id)) {
      context.addIssue({ code: 'custom', message: 'Merge source IDs must include the record ID' });
    }
  });

export type PendingKnowledgeDeletion = z.infer<typeof PendingKnowledgeDeletionSchema>;

function pendingDirectory(knowledgeDir: string): string {
  return resolveKnowledgePath(knowledgeDir, PENDING_DIRECTORY);
}

function pendingPath(knowledgeDir: string, id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error(`Unsafe knowledge identity: ${id}`);
  return resolveKnowledgePath(knowledgeDir, `${PENDING_DIRECTORY}/${id}.yaml`);
}

function parsePending(knowledgeDir: string, path: string, bytes: string): PendingKnowledgeDeletion {
  const record = PendingKnowledgeDeletionSchema.parse(parse(bytes));
  if (record.id !== path.slice(path.lastIndexOf('/') + 1, -'.yaml'.length)) {
    throw new Error(`Pending deletion filename does not match identity: ${path}`);
  }
  resolveKnowledgePath(knowledgeDir, record.filePath);
  if (record.mergeTargetFilePath) resolveKnowledgePath(knowledgeDir, record.mergeTargetFilePath);
  return record;
}

export function writePendingKnowledgeDeletion(
  knowledgeDir: string,
  record: PendingKnowledgeDeletion,
): void {
  const validated = PendingKnowledgeDeletionSchema.parse(record);
  const path = pendingPath(knowledgeDir, validated.id);
  resolveKnowledgePath(knowledgeDir, validated.filePath);
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Pending deletion must be a regular file: ${path}`);
    }
    const existing = parsePending(knowledgeDir, path, readFileSync(path, 'utf8'));
    if (JSON.stringify(existing) === JSON.stringify(validated)) {
      return;
    }
    throw new Error(`Pending deletion already exists with different content: ${validated.id}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  atomicWriteKnowledgeText(
    knowledgeDir,
    `${PENDING_DIRECTORY}/${validated.id}.yaml`,
    stringify(validated),
  );
}

export function readPendingKnowledgeDeletions(knowledgeDir: string): PendingKnowledgeDeletion[] {
  const directory = pendingDirectory(knowledgeDir);
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.name.endsWith('.yaml'))
    .map((entry) => {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new Error(`Pending deletion must be a regular file: ${path}`);
      }
      return parsePending(knowledgeDir, path, readFileSync(path, 'utf8'));
    });
}

export function removePendingKnowledgeDeletion(knowledgeDir: string, id: string): void {
  const path = pendingPath(knowledgeDir, id);
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Pending deletion must be a regular file: ${path}`);
    }
    deleteBubbleFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
