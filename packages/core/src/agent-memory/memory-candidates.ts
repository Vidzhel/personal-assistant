import { mkdir, open, readdir, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { lstatSync, renameSync } from 'node:fs';

import yaml from 'js-yaml';
const { load: yamlLoad, dump: yamlDump } = yaml;
import { z } from 'zod';
import { createLogger } from '@raven/shared';

import { readProjectTextFile } from '../project-manager/project-file-read.ts';
import { ProjectMutationError } from '../project-manager/project-mutation.ts';
import type { MemoryStore } from './memory-store.ts';
import { resolveMemoryPath } from './memory-store.ts';

const log = createLogger('memory-candidates');

export const MAX_CANDIDATES_PER_RETROSPECTIVE = 3;
const SLUG_MAX_LENGTH = 40;
const BYTES_PER_KILOBYTE = 1024;
const MAX_CANDIDATE_KILOBYTES = 64;
const MAX_CANDIDATE_BYTES = MAX_CANDIDATE_KILOBYTES * BYTES_PER_KILOBYTE;
const PRIVATE_FILE_MODE = 0o600;
const DATE_PREFIX_LENGTH = 10;
const MAX_PENDING_CANDIDATES = 100;

export type CandidateSource = 'session-retrospective' | 'system-retrospective';
export type CandidateProvenance = 'interactive' | 'system';

export interface CandidateFrontmatter {
  source: CandidateSource;
  sessionId?: string;
  provenance: CandidateProvenance;
  createdAt: string;
  status: 'pending';
}

export interface PendingCandidate {
  filename: string;
  revision: string;
  frontmatter: CandidateFrontmatter;
  body: string;
}

export const MemoryCandidateProposalSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
});

export type MemoryCandidateProposal = z.infer<typeof MemoryCandidateProposalSchema>;

export function parseMemoryCandidateProposals(raw: unknown): MemoryCandidateProposal[] {
  if (!Array.isArray(raw)) return [];
  const proposals: MemoryCandidateProposal[] = [];
  for (const item of raw.slice(0, MAX_CANDIDATES_PER_RETROSPECTIVE)) {
    const parsed = MemoryCandidateProposalSchema.safeParse(item);
    if (parsed.success) proposals.push(parsed.data);
    else log.warn(`Dropping malformed memory candidate proposal: ${parsed.error.message}`);
  }
  return proposals;
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (slug || 'candidate').slice(0, SLUG_MAX_LENGTH);
}

export interface WriteCandidateInput {
  title: string;
  content: string;
  source: CandidateSource;
  sessionId?: string;
}

function candidateBody(input: WriteCandidateInput, now: string): string {
  const frontmatter: CandidateFrontmatter = {
    source: input.source,
    ...(input.sessionId !== undefined && { sessionId: input.sessionId }),
    provenance: input.source === 'session-retrospective' ? 'interactive' : 'system',
    createdAt: now,
    status: 'pending',
  };
  return `---\n${yamlDump(frontmatter)}---\n\n# ${input.title}\n\n${input.content}\n`;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx', PRIVATE_FILE_MODE);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    renameSync(temp, path);
    const directory = await open(dirname(path), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

async function flushDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function candidatePaths(directory: string, filename: string): { source: string; archive: string } {
  const source = resolveMemoryPath(directory, `candidates/${filename}`, true);
  const archive = resolveMemoryPath(directory, `candidates/archive/${filename}`, true);
  return { source, archive };
}

function internalDirectory(directory: string, relPath: string): string {
  return dirname(resolveMemoryPath(directory, `${relPath}/placeholder.md`, true));
}

export async function writeMemoryCandidate(
  deps: { memoryStore: MemoryStore; signal?: AbortSignal },
  projectId: string,
  input: WriteCandidateInput,
): Promise<string | undefined> {
  try {
    deps.signal?.throwIfAborted();
    const now = new Date().toISOString();
    const filename = `${now.slice(0, DATE_PREFIX_LENGTH)}-${slugify(input.title)}-${randomUUID()}.md`;
    const body = candidateBody(input, now);
    if (Buffer.byteLength(body, 'utf8') > MAX_CANDIDATE_BYTES) {
      throw new Error('memory candidate exceeds size limit');
    }
    await deps.memoryStore.withDirectory(projectId, async (directory) => {
      const path = resolveMemoryPath(directory, `candidates/${filename}`, true);
      await mkdir(internalDirectory(directory, 'candidates'), { recursive: true });
      deps.signal?.throwIfAborted();
      await atomicWrite(path, body);
    });
    deps.signal?.throwIfAborted();
    log.info(`Wrote memory candidate: ${projectId}/candidates/${filename}`);
    return filename;
  } catch (err) {
    deps.signal?.throwIfAborted();
    log.error(`Failed to write memory candidate for ${projectId}: ${err}`);
    return undefined;
  }
}

interface RawFrontmatter {
  source?: unknown;
  sessionId?: unknown;
  provenance?: unknown;
  createdAt?: unknown;
  status?: unknown;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

function parseCandidateFile(raw: string, filename: string): PendingCandidate | undefined {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) {
    log.warn(`Candidate ${filename} has no YAML frontmatter — skipping`);
    return undefined;
  }
  try {
    const parsed = yamlLoad(match[1]) as RawFrontmatter;
    if (
      (parsed.source !== 'session-retrospective' && parsed.source !== 'system-retrospective') ||
      (parsed.provenance !== 'interactive' && parsed.provenance !== 'system') ||
      typeof parsed.createdAt !== 'string' ||
      parsed.status !== 'pending'
    ) {
      log.warn(`Candidate ${filename} has malformed frontmatter — skipping`);
      return undefined;
    }
    return {
      filename,
      revision: createHash('sha256').update(Buffer.from(raw, 'utf8')).digest('hex'),
      frontmatter: {
        source: parsed.source,
        ...(typeof parsed.sessionId === 'string' && { sessionId: parsed.sessionId }),
        provenance: parsed.provenance,
        createdAt: parsed.createdAt,
        status: 'pending',
      },
      body: match[2].trim(),
    };
  } catch (err) {
    log.warn(`Failed to parse frontmatter for candidate ${filename}: ${err}`);
    return undefined;
  }
}

async function readCandidates(directory: string): Promise<PendingCandidate[]> {
  const dir = internalDirectory(directory, 'candidates');
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const candidates: PendingCandidate[] = [];
  const candidateEntries = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, MAX_PENDING_CANDIDATES);
  for (const entry of candidateEntries) {
    try {
      const raw = readProjectTextFile(
        resolveMemoryPath(dir, entry.name, true),
        MAX_CANDIDATE_BYTES,
      );
      const parsed = raw === undefined ? undefined : parseCandidateFile(raw, entry.name);
      if (parsed) candidates.push(parsed);
    } catch (err) {
      if (err instanceof ProjectMutationError) throw err;
      log.warn(`Failed to read candidate ${entry.name}: ${err}`);
    }
  }
  return candidates;
}

export async function listPendingCandidates(
  memoryStore: MemoryStore,
  projectId: string,
): Promise<PendingCandidate[]> {
  return memoryStore.withDirectory(projectId, readCandidates);
}

export async function archiveCandidate(
  memoryStore: MemoryStore,
  projectId: string,
  candidate: Pick<PendingCandidate, 'filename' | 'revision'>,
): Promise<boolean> {
  const filename = candidate.filename;
  const expectedRevision = candidate.revision;
  if (filename.includes('/') || filename.includes('\\') || filename.startsWith('.')) return false;
  try {
    return await memoryStore.withDirectory(projectId, async (directory) => {
      const { source, archive } = candidatePaths(directory, filename);
      const sourceText = readProjectTextFile(source, MAX_CANDIDATE_BYTES);
      if (sourceText === undefined) return false;
      const revision = createHash('sha256').update(Buffer.from(sourceText, 'utf8')).digest('hex');
      if (revision !== expectedRevision) return false;
      await mkdir(internalDirectory(directory, 'candidates/archive'), { recursive: true });
      try {
        lstatSync(archive);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const currentText = readProjectTextFile(source, MAX_CANDIDATE_BYTES);
      if (currentText === undefined) return false;
      const currentRevision = createHash('sha256')
        .update(Buffer.from(currentText, 'utf8'))
        .digest('hex');
      if (currentRevision !== expectedRevision) return false;
      renameSync(source, archive);
      await flushDirectory(dirname(source));
      await flushDirectory(dirname(archive));
      log.info(`Archived memory candidate: ${projectId}/candidates/${filename}`);
      return true;
    });
  } catch (err) {
    log.warn(`Failed to archive candidate ${filename} for ${projectId}: ${err}`);
    return false;
  }
}
