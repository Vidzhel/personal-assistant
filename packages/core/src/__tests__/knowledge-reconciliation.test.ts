import { afterEach, describe, expect, it, vi } from 'vitest';
import { lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcileKnowledgeFiles } from '../knowledge-engine/knowledge-reconciliation.ts';
import { knowledgeRevision } from '../knowledge-engine/knowledge-revision.ts';
import { fakeGraph } from './fixtures/knowledge-fixture.ts';
import { sha256 } from '../knowledge-engine/knowledge-file.ts';
import { writePendingKnowledgeDeletion } from '../knowledge-engine/knowledge-deletions.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const knowledgeDir = mkdtempSync(join(tmpdir(), 'raven-reconcile-'));
  roots.push(knowledgeDir);
  const neo4j = fakeGraph();
  return { knowledgeDir, neo4j };
}

function writeBubble(knowledgeDir: string, name: string, frontmatter: string, body: string) {
  writeFileSync(join(knowledgeDir, name), `---\n${frontmatter}---\n${body}\n`);
}

describe('knowledge file reconciliation', () => {
  it('reports each disagreement without mutating graph or files', async () => {
    const { knowledgeDir, neo4j } = fixture();
    writeBubble(knowledgeDir, 'file-only.md', 'id: file-only\n', 'File only');
    writeBubble(knowledgeDir, 'duplicate-a.md', 'id: duplicate\n', 'A');
    writeBubble(knowledgeDir, 'duplicate-b.md', 'id: duplicate\n', 'B');
    writeBubble(knowledgeDir, 'missing.md', '', 'Missing identity');
    writeBubble(knowledgeDir, 'malformed.md', 'id: malformed\ntags: [unfinished\n', 'Bad');
    writeBubble(knowledgeDir, 'path.md', 'id: path\ntitle: Path\n', 'Path body');
    writeBubble(knowledgeDir, 'stale.md', 'id: stale\ntitle: Stale\ntags: [one]\n', 'Stale body');
    const staleRevision = knowledgeRevision({
      title: 'Stale',
      content: 'Stale body',
      tags: ['one'],
    });
    vi.mocked(neo4j.query).mockResolvedValue([
      { id: 'graph-only', filePath: 'removed.md' },
      { id: 'unsafe', filePath: '../outside.md' },
      {
        id: 'path',
        filePath: 'old-path.md',
        title: 'Corrupt title',
        sourceRevision: 'source',
        embeddingRevision: 'source',
        chunkRevision: 'source',
      },
      {
        id: 'stale',
        filePath: 'stale.md',
        sourceRevision: staleRevision,
        embeddingRevision: staleRevision,
        chunkRevision: staleRevision,
        embeddingCount: 0,
        chunkCount: 0,
      },
    ]);

    const before = lstatSync(join(knowledgeDir, 'path.md'));
    const report = await reconcileKnowledgeFiles({ neo4j, knowledgeDir });

    expect(report).toMatchObject({ knowledgeDir, filesScanned: 7, graphNodesScanned: 4 });
    expect(report.issues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        'file-only',
        'graph-only',
        'missing-identity',
        'malformed-file',
        'duplicate-identity',
        'path-mismatch',
        'metadata-mismatch',
        'unsafe-path',
        'stale-derived-index',
      ]),
    );
    for (const entry of report.issues) {
      expect(entry.message).toEqual(expect.any(String));
      expect(entry.repair).toEqual(expect.any(String));
    }
    expect(neo4j.run).not.toHaveBeenCalled();
    expect(neo4j.withTransaction).not.toHaveBeenCalled();
    expect(lstatSync(join(knowledgeDir, 'path.md')).mtimeMs).toBe(before.mtimeMs);
  });

  it('reports symlink knowledge paths and leaves the target untouched', async () => {
    const { knowledgeDir, neo4j } = fixture();
    const targetDir = mkdtempSync(join(tmpdir(), 'raven-reconcile-target-'));
    roots.push(targetDir);
    writeBubble(targetDir, 'target.md', 'id: target\n', 'Target');
    symlinkSync(join(targetDir, 'target.md'), join(knowledgeDir, 'linked.md'));

    const report = await reconcileKnowledgeFiles({ neo4j, knowledgeDir });

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'unsafe-path', filePath: 'linked.md' }),
      ]),
    );
    expect(neo4j.run).not.toHaveBeenCalled();
    expect(neo4j.withTransaction).not.toHaveBeenCalled();
  });

  it('fails closed with an actionable graph read issue', async () => {
    const { knowledgeDir, neo4j } = fixture();
    writeBubble(knowledgeDir, 'known.md', 'id: known\n', 'Known');
    vi.mocked(neo4j.query).mockRejectedValue(new Error('graph unavailable'));

    const report = await reconcileKnowledgeFiles({ neo4j, knowledgeDir });

    expect(report.graphNodesScanned).toBe(0);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'graph-read-failed',
          repair: expect.stringContaining('rerun'),
        }),
      ]),
    );
    expect(neo4j.run).not.toHaveBeenCalled();
    expect(neo4j.withTransaction).not.toHaveBeenCalled();
  });

  it('produces the same read-only report when repeated', async () => {
    const { knowledgeDir, neo4j } = fixture();
    writeBubble(knowledgeDir, 'same.md', 'id: same\n', 'Same');
    vi.mocked(neo4j.query).mockResolvedValue([{ id: 'orphan', filePath: 'orphan.md' }]);

    const first = await reconcileKnowledgeFiles({ neo4j, knowledgeDir });
    const second = await reconcileKnowledgeFiles({ neo4j, knowledgeDir });

    expect(second).toEqual(first);
    expect(neo4j.run).not.toHaveBeenCalled();
    expect(neo4j.withTransaction).not.toHaveBeenCalled();
  });

  it('reports a valid pending deletion without changing the intent', async () => {
    const { knowledgeDir, neo4j } = fixture();
    const raw = '---\nid: retiring\n---\nRetiring\n';
    writeBubble(knowledgeDir, 'retiring.md', 'id: retiring\n', 'Retiring');
    writePendingKnowledgeDeletion(knowledgeDir, {
      id: 'retiring',
      filePath: 'retiring.md',
      fileHash: sha256(raw),
    });

    const report = await reconcileKnowledgeFiles({ neo4j, knowledgeDir });

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'pending-deletion',
          id: 'retiring',
          filePath: 'retiring.md',
        }),
      ]),
    );
    expect(neo4j.run).not.toHaveBeenCalled();
    expect(neo4j.withTransaction).not.toHaveBeenCalled();
  });
});
