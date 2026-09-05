import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseMemoryCandidateProposals,
  writeMemoryCandidate,
  listPendingCandidates,
  archiveCandidate,
  MAX_CANDIDATES_PER_RETROSPECTIVE,
} from '../agent-memory/memory-candidates.ts';

describe('parseMemoryCandidateProposals', () => {
  it('returns [] for non-array input', () => {
    expect(parseMemoryCandidateProposals(undefined)).toEqual([]);
    expect(parseMemoryCandidateProposals(null)).toEqual([]);
    expect(parseMemoryCandidateProposals('not an array')).toEqual([]);
    expect(parseMemoryCandidateProposals({ title: 'x', content: 'y' })).toEqual([]);
  });

  it('returns [] for an empty array', () => {
    expect(parseMemoryCandidateProposals([])).toEqual([]);
  });

  it('keeps valid proposals and drops malformed ones individually', () => {
    // All within the first MAX_CANDIDATES_PER_RETROSPECTIVE items, so the
    // cap (tested separately below) doesn't interact with this case.
    const result = parseMemoryCandidateProposals([
      { title: 'Good one', content: 'Durable fact.' },
      { title: '', content: 'Missing title fails min length' },
      { title: 'Second good one', content: 'Another durable fact.' },
    ]);

    expect(result).toEqual([
      { title: 'Good one', content: 'Durable fact.' },
      { title: 'Second good one', content: 'Another durable fact.' },
    ]);
  });

  it('drops non-object and missing-field entries', () => {
    const result = parseMemoryCandidateProposals([
      { title: 'No content' },
      { content: 'No title' },
      'not an object',
    ]);
    expect(result).toEqual([]);
  });

  it('caps at MAX_CANDIDATES_PER_RETROSPECTIVE raw items — a flood of proposals is bounded before validation ever runs', () => {
    const proposals = Array.from({ length: MAX_CANDIDATES_PER_RETROSPECTIVE + 5 }, (_, i) => ({
      title: `Candidate ${i}`,
      content: `Content ${i}`,
    }));

    const result = parseMemoryCandidateProposals(proposals);
    expect(result).toHaveLength(MAX_CANDIDATES_PER_RETROSPECTIVE);
    expect(result[0].title).toBe('Candidate 0');
  });
});

describe('candidate file lifecycle (write / list / archive)', () => {
  let tmpDir: string;
  let memoryDir: string;
  let memoryStore: {
    withDirectory: (
      projectId: string,
      operation: (dir: string) => Promise<unknown>,
    ) => Promise<unknown>;
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memory-candidates-'));
    memoryDir = join(tmpDir, 'memory');
    memoryStore = { withDirectory: (_projectId, operation) => operation(memoryDir) };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a candidate that lists back with correct frontmatter and body', async () => {
    const filename = await writeMemoryCandidate({ memoryStore: memoryStore as any }, 'project-1', {
      title: 'Favorite color',
      content: "The owner's favorite color is teal.",
      source: 'session-retrospective',
      sessionId: 'sess-1',
    });

    expect(filename).toBeDefined();
    expect(filename).toMatch(/^\d{4}-\d{2}-\d{2}-favorite-color-[0-9a-f-]+\.md$/);

    const pending = await listPendingCandidates(memoryStore as any, 'project-1');
    expect(pending).toHaveLength(1);
    expect(pending[0].filename).toBe(filename);
    expect(pending[0].frontmatter).toMatchObject({
      source: 'session-retrospective',
      sessionId: 'sess-1',
      provenance: 'interactive',
      status: 'pending',
    });
    expect(pending[0].body).toContain('# Favorite color');
    expect(pending[0].body).toContain("The owner's favorite color is teal.");
  });

  it('derives provenance from source for system-retrospective candidates', async () => {
    await writeMemoryCandidate({ memoryStore: memoryStore as any }, 'project-1', {
      title: 'System health',
      content: 'Everything is fine.',
      source: 'system-retrospective',
    });

    const pending = await listPendingCandidates(memoryStore as any, 'project-1');
    expect(pending[0].frontmatter.provenance).toBe('system');
    expect(pending[0].frontmatter.sessionId).toBeUndefined();
  });

  it('returns [] for an agent with no candidates dir yet', async () => {
    const pending = await listPendingCandidates(memoryStore as any, 'brand-new-project');
    expect(pending).toEqual([]);
  });

  it('archiveCandidate moves the file so it no longer lists as pending', async () => {
    const filename = (await writeMemoryCandidate({ memoryStore: memoryStore as any }, 'project-1', {
      title: 'To archive',
      content: 'Will be consumed.',
      source: 'session-retrospective',
    })) as string;

    const [candidate] = await listPendingCandidates(memoryStore as any, 'project-1');
    await archiveCandidate(memoryStore as any, 'project-1', candidate);

    const pending = await listPendingCandidates(memoryStore as any, 'project-1');
    expect(pending).toEqual([]);

    const archived = readdirSync(join(memoryDir, 'candidates', 'archive'));
    expect(archived).toContain(filename);
  });

  it('does not archive a candidate whose bytes changed after consolidation read', async () => {
    await writeMemoryCandidate({ memoryStore: memoryStore as any }, 'project-1', {
      title: 'CAS candidate',
      content: 'Original body.',
      source: 'session-retrospective',
    });
    const [candidate] = await listPendingCandidates(memoryStore as any, 'project-1');
    writeFileSync(join(memoryDir, 'candidates', candidate.filename), 'externally changed');

    expect(await archiveCandidate(memoryStore as any, 'project-1', candidate)).toBe(false);
    expect(readdirSync(join(memoryDir, 'candidates'))).toContain(candidate.filename);
  });

  it('drops a candidate file with no YAML frontmatter (logged, not thrown)', async () => {
    const dir = join(memoryDir, 'candidates');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-01-01-no-frontmatter.md'), '# Just a plain markdown file\n');

    const pending = await listPendingCandidates(memoryStore as any, 'project-1');
    expect(pending).toEqual([]);
  });

  it('drops a candidate file with malformed frontmatter fields', async () => {
    const dir = join(memoryDir, 'candidates');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '2026-01-01-bad.md'),
      '---\nsource: not-a-real-source\nprovenance: interactive\ncreatedAt: "2026-01-01"\nstatus: pending\n---\n\nbody\n',
    );

    const pending = await listPendingCandidates(memoryStore as any, 'project-1');
    expect(pending).toEqual([]);
  });
});
