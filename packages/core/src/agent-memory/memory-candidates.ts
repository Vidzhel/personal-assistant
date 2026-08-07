import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import yaml from 'js-yaml';
const { load: yamlLoad, dump: yamlDump } = yaml;

import { z } from 'zod';
import { createLogger } from '@raven/shared';

import { resolveMemoryDir, validateAgentName } from './memory-store.ts';

const log = createLogger('memory-candidates');

/** Retrospectives may propose at most this many candidates per run — the
 * owner reviews via consolidation, so a flood of low-value proposals just
 * adds noise (and eats memory budget) rather than being caught upstream. */
export const MAX_CANDIDATES_PER_RETROSPECTIVE = 3;

const SLUG_MAX_LENGTH = 40;
/** Length of the "YYYY-MM-DD" prefix of an ISO-8601 timestamp string. */
const ISO_DATE_LENGTH = 10;

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
  /** Filename only (relative to the candidates dir), e.g. "2026-08-07-database-config.md". */
  filename: string;
  frontmatter: CandidateFrontmatter;
  /** Markdown body — everything after the frontmatter fence. */
  body: string;
}

/** What the retrospective agent is asked to propose: a durable memory —
 * owner preference, correction, or standing fact — not a session summary. */
export const MemoryCandidateProposalSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
});

export type MemoryCandidateProposal = z.infer<typeof MemoryCandidateProposalSchema>;

/** Defensively extract 0-MAX_CANDIDATES_PER_RETROSPECTIVE valid proposals
 * from whatever the retrospective agent returned. Never throws: a
 * non-array, or any individual malformed entry, is dropped and logged
 * rather than failing the whole retrospective. */
export function parseMemoryCandidateProposals(raw: unknown): MemoryCandidateProposal[] {
  if (!Array.isArray(raw)) return [];

  const proposals: MemoryCandidateProposal[] = [];
  for (const item of raw.slice(0, MAX_CANDIDATES_PER_RETROSPECTIVE)) {
    const parsed = MemoryCandidateProposalSchema.safeParse(item);
    if (parsed.success) {
      proposals.push(parsed.data);
    } else {
      log.warn(`Dropping malformed memory candidate proposal: ${parsed.error.message}`);
    }
  }
  return proposals;
}

function candidatesDir(projectsDir: string, agentName: string): string {
  return join(resolveMemoryDir(projectsDir, agentName), 'candidates');
}

function archiveDir(projectsDir: string, agentName: string): string {
  return join(candidatesDir(projectsDir, agentName), 'archive');
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

/** Write one reviewable candidate memory file. Never throws — logs and
 * returns undefined on failure so a bad candidate never takes down the
 * retrospective/system job that produced it. */
export async function writeMemoryCandidate(
  deps: { projectsDir: string },
  agentName: string,
  input: WriteCandidateInput,
): Promise<string | undefined> {
  try {
    validateAgentName(agentName);
    const dir = candidatesDir(deps.projectsDir, agentName);
    const now = new Date();
    const filename = `${now.toISOString().slice(0, ISO_DATE_LENGTH)}-${slugify(input.title)}.md`;

    const frontmatter: CandidateFrontmatter = {
      source: input.source,
      ...(input.sessionId !== undefined && { sessionId: input.sessionId }),
      provenance: input.source === 'session-retrospective' ? 'interactive' : 'system',
      createdAt: now.toISOString(),
      status: 'pending',
    };

    const content = `---\n${yamlDump(frontmatter)}---\n\n# ${input.title}\n\n${input.content}\n`;

    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, filename), content, 'utf-8');
    log.info(`Wrote memory candidate: ${agentName}/candidates/${filename}`);
    return filename;
  } catch (err) {
    log.error(`Failed to write memory candidate for ${agentName}: ${err}`);
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

function parseCandidateFile(
  raw: string,
  filename: string,
): { frontmatter: CandidateFrontmatter; body: string } | undefined {
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
    const frontmatter: CandidateFrontmatter = {
      source: parsed.source,
      ...(typeof parsed.sessionId === 'string' && { sessionId: parsed.sessionId }),
      provenance: parsed.provenance,
      createdAt: parsed.createdAt,
      status: 'pending',
    };
    return { frontmatter, body: match[2].trim() };
  } catch (err) {
    log.warn(`Failed to parse frontmatter for candidate ${filename}: ${err}`);
    return undefined;
  }
}

/** List pending candidates for an agent. Never throws: a missing directory
 * returns [], and an individual malformed file is dropped (logged), not
 * fatal to the rest of the listing. */
export async function listPendingCandidates(
  projectsDir: string,
  agentName: string,
): Promise<PendingCandidate[]> {
  validateAgentName(agentName);
  const dir = candidatesDir(projectsDir, agentName);

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates: PendingCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    try {
      const raw = await readFile(join(dir, entry.name), 'utf-8');
      const parsed = parseCandidateFile(raw, entry.name);
      if (parsed) candidates.push({ filename: entry.name, ...parsed });
    } catch (err) {
      log.warn(`Failed to read candidate ${entry.name} for ${agentName}: ${err}`);
    }
  }
  return candidates;
}

/** Move a consumed candidate into candidates/archive/ so it's never picked
 * up again but stays around for owner review. Never throws. */
export async function archiveCandidate(
  projectsDir: string,
  agentName: string,
  filename: string,
): Promise<void> {
  validateAgentName(agentName);
  const dir = candidatesDir(projectsDir, agentName);
  const dest = archiveDir(projectsDir, agentName);
  try {
    await mkdir(dest, { recursive: true });
    await rename(join(dir, filename), join(dest, filename));
    log.info(`Archived memory candidate: ${agentName}/candidates/${filename}`);
  } catch (err) {
    log.warn(`Failed to archive candidate ${filename} for ${agentName}: ${err}`);
  }
}
