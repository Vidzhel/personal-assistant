import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  mkdirSync,
  mkdtempSync,
  copyFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { registerProjectFileRoutes } from '../api/routes/project-files.ts';
import {
  closeOpenedFile,
  contentDisposition,
  createReadStreamFromFd,
  openRelativeFile,
  openRelativeFileFromDirectory,
  readOpenedText,
} from '../project-manager/project-files-access.ts';
import type { ProjectWorkspaceStore } from '../project-manager/project-workspace.ts';
import { createProjectWorkspaceStore } from '../project-manager/project-workspace.ts';
import { ProjectRegistry } from '../project-registry/project-registry.ts';

const HEAD_REPETITIONS = 12;
const FD_HEADROOM = 4;
const FD_WAIT_ATTEMPTS = 20;

function openFdCount(): number {
  return readdirSync('/proc/self/fd').length;
}

async function waitForFdHeadroom(maximum: number): Promise<boolean> {
  for (let attempt = 0; attempt < FD_WAIT_ATTEMPTS; attempt += 1) {
    if (openFdCount() <= maximum) return true;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return openFdCount() <= maximum;
}

async function createFixture(root: string): Promise<{
  store: ProjectWorkspaceStore;
  homes: Record<string, string>;
}> {
  const projectsDir = join(root, 'projects');
  const homes: Record<string, string> = {};
  for (const id of ['alpha', 'beta']) {
    const home = join(projectsDir, id);
    homes[id] = home;
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'context.md'), `# ${id}\n`);
  }
  const projectRegistry = new ProjectRegistry();
  await projectRegistry.load(projectsDir);
  return {
    homes,
    store: createProjectWorkspaceStore({ projectsDir, projectRegistry, projectRoot: root }),
  };
}

describe('project file API', () => {
  let root: string;
  let home: string;
  let store: ProjectWorkspaceStore;
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'raven-project-files-'));
    const fixture = await createFixture(root);
    store = fixture.store;
    home = fixture.homes.alpha;
    mkdirSync(join(home, 'nested'), { recursive: true });
    writeFileSync(join(home, 'notes.md'), '# notes');
    writeFileSync(join(home, 'page.html'), '<h1>safe</h1>');
    writeFileSync(join(home, 'nested', 'item.txt'), 'item');
    app = Fastify({ logger: false });
    registerProjectFileRoutes(app, store);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('lists and serves only through the current grant revision', async () => {
    const listing = await app.inject({ method: 'GET', url: '/api/projects/alpha/files' });
    expect(listing.statusCode).toBe(200);
    const body = listing.json();
    expect(body.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'notes.md', preview: 'text' }),
        expect.objectContaining({ path: 'nested', type: 'directory' }),
      ]),
    );
    const content = await app.inject({
      method: 'GET',
      url: `/api/projects/alpha/files/content?path=notes.md&revision=${body.revision}`,
    });
    expect(content.statusCode).toBe(200);
    expect(content.body).toBe('# notes');

    const stale = await app.inject({
      method: 'GET',
      url: `/api/projects/alpha/files/content?path=notes.md&revision=stale`,
    });
    expect(stale.statusCode).toBe(409);
  });

  it('applies preview safety and rejects traversal or absent sources', async () => {
    const info = await app.inject({
      method: 'GET',
      url: '/api/projects/alpha/files/info?path=page.html',
    });
    expect(info.statusCode).toBe(200);
    const listing = await app.inject({ method: 'GET', url: '/api/projects/alpha/files' });
    const html = await app.inject({
      method: 'GET',
      url: `/api/projects/alpha/files/content?path=page.html&revision=${listing.json().revision}`,
    });
    expect(html.statusCode).toBe(200);
    expect(html.headers['content-security-policy']).toContain('sandbox');
    expect(html.body).toContain('<h1>safe</h1>');

    const traversal = await app.inject({
      method: 'GET',
      url: '/api/projects/alpha/files?path=../secret',
    });
    expect(traversal.statusCode).toBe(400);
    const foreign = await app.inject({
      method: 'GET',
      url: '/api/projects/alpha/files?sourceId=missing',
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('keeps project homes and attached folder grants isolated', async () => {
    const attached = join(root, 'attached-alpha');
    const betaAttached = join(root, 'attached-beta');
    mkdirSync(attached);
    mkdirSync(betaAttached);
    writeFileSync(join(attached, 'alpha.txt'), 'alpha repository');
    writeFileSync(join(betaAttached, 'beta.txt'), 'beta repository');
    const alphaSource = await store.createDataSource('alpha', {
      uri: attached,
      label: 'Alpha repository',
      sourceType: 'folder',
    });
    const betaSource = await store.createDataSource('beta', {
      uri: betaAttached,
      label: 'Beta repository',
      sourceType: 'folder',
    });
    const alpha = await app.inject({
      method: 'GET',
      url: `/api/projects/alpha/files?sourceId=${alphaSource.id}`,
    });
    expect(alpha.statusCode).toBe(200);
    expect(alpha.json().entries).toEqual([expect.objectContaining({ path: 'alpha.txt' })]);
    const foreign = await app.inject({
      method: 'GET',
      url: `/api/projects/beta/files?sourceId=${alphaSource.id}`,
    });
    expect(foreign.statusCode).toBe(404);
    const beta = await app.inject({
      method: 'GET',
      url: `/api/projects/beta/files?sourceId=${betaSource.id}`,
    });
    expect(beta.statusCode).toBe(200);
    expect(beta.json().entries).toEqual([expect.objectContaining({ path: 'beta.txt' })]);
  });

  it('rejects stale context identity, source URI, and replaced root grants', async () => {
    writeFileSync(join(home, 'context.md'), '---\nravenProject:\n  id: other\n---\n# alpha\n');
    const identity = await app.inject({ method: 'GET', url: '/api/projects/alpha/files' });
    expect(identity.statusCode).toBe(409);
    expect(identity.json().error).toMatch(/identity|project context/i);
    writeFileSync(join(home, 'context.md'), '# alpha\n');

    const attached = join(root, 'attached');
    const replacement = join(root, 'attached-replacement');
    mkdirSync(attached);
    mkdirSync(replacement);
    const source = await store.createDataSource('alpha', {
      uri: attached,
      label: 'Attached',
      sourceType: 'folder',
    });
    const old = await app.inject({
      method: 'GET',
      url: `/api/projects/alpha/files?sourceId=${source.id}`,
    });
    await store.updateDataSource('alpha', source.id, { uri: replacement });
    const changed = await app.inject({
      method: 'GET',
      url: `/api/projects/alpha/files?sourceId=${source.id}&revision=${old.json().revision}`,
    });
    expect(changed.statusCode).toBe(409);

    const homeListing = await app.inject({ method: 'GET', url: '/api/projects/alpha/files' });
    const moved = join(root, 'moved-alpha');
    renameSync(home, moved);
    mkdirSync(home);
    copyFileSync(join(moved, 'context.md'), join(home, 'context.md'));
    copyFileSync(join(moved, 'project.yaml'), join(home, 'project.yaml'));
    const fresh = await app.inject({ method: 'GET', url: '/api/projects/alpha/files' });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json().revision).not.toBe(homeListing.json().revision);
    const replaced = await app.inject({
      method: 'GET',
      url: `/api/projects/alpha/files?revision=${homeListing.json().revision}`,
    });
    expect(replaced.statusCode).toBe(409);
  });

  it('rejects symlink components, FIFOs, and bounded oversized content', async () => {
    mkdirSync(join(home, 'real'));
    writeFileSync(join(home, 'real', 'secret.txt'), 'secret');
    symlinkSync(join(home, 'real'), join(home, 'linked-directory'));
    const linked = await app.inject({
      method: 'GET',
      url: '/api/projects/alpha/files?path=linked-directory/secret.txt',
    });
    expect(linked.statusCode).toBe(409);
    const fifo = join(home, 'pipe');
    execFileSync('mkfifo', [fifo]);
    const fifoResponse = await app.inject({
      method: 'GET',
      url: '/api/projects/alpha/files/info?path=pipe',
    });
    expect(fifoResponse.statusCode).toBe(400);

    writeFileSync(join(home, 'large.md'), Buffer.alloc(1_048_577));
    const listing = await app.inject({ method: 'GET', url: '/api/projects/alpha/files' });
    const textResponse = await app.inject({
      method: 'GET',
      url: `/api/projects/alpha/files/content?path=large.md&revision=${listing.json().revision}`,
    });
    expect(textResponse.statusCode).toBe(413);
    writeFileSync(join(home, 'large.bin'), '');
    truncateSync(join(home, 'large.bin'), 536_870_913);
    const download = await app.inject({
      method: 'GET',
      url: `/api/projects/alpha/files/content?path=large.bin&revision=${listing.json().revision}&download=1`,
    });
    expect(download.statusCode).toBe(413);
    writeFileSync(join(home, 'large.pdf'), '');
    truncateSync(join(home, 'large.pdf'), 33_554_433);
    const pdfUrl = `/api/projects/alpha/files/content?path=large.pdf&revision=${listing.json().revision}`;
    expect((await app.inject({ method: 'GET', url: pdfUrl })).statusCode).toBe(413);
    expect((await app.inject({ method: 'HEAD', url: `${pdfUrl}&download=1` })).statusCode).toBe(
      200,
    );
  });

  it('supports revision-checked HEAD preflight without exposing a body', async () => {
    writeFileSync(join(home, 'image.png'), Buffer.from([137, 80, 78, 71]));
    const listing = await app.inject({ method: 'GET', url: '/api/projects/alpha/files' });
    const url = `/api/projects/alpha/files/content?path=image.png&revision=${listing.json().revision}`;
    const before = openFdCount();
    let response;
    for (let request = 0; request < HEAD_REPETITIONS; request += 1) {
      response = await app.inject({ method: 'HEAD', url });
      expect(response.statusCode).toBe(200);
    }
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-length']).toBe('4');
    expect(response.body).toBe('');
    expect(await waitForFdHeadroom(before + FD_HEADROOM)).toBe(true);
  });

  it('does not expose symlinked files and bounds visited directory entries', async () => {
    symlinkSync(join(root, 'outside.md'), join(home, 'linked.md'));
    for (let index = 0; index < 501; index += 1) {
      symlinkSync(join(root, 'missing'), join(home, `link-${index}.md`));
    }
    const response = await app.inject({ method: 'GET', url: '/api/projects/alpha/files' });
    expect(response.statusCode).toBe(200);
    expect(response.json().truncated).toBe(true);
    expect(response.json().entries).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'linked.md' })]),
    );
  });

  it('keeps a held directory descriptor on the original root after replacement', () => {
    const held = openRelativeFile(home, '');
    const moved = join(root, 'moved-home');
    try {
      renameSync(home, moved);
      mkdirSync(home);
      writeFileSync(join(home, 'notes.md'), 'replacement');
      const original = openRelativeFileFromDirectory(held.fd, home, 'notes.md');
      try {
        expect(readOpenedText(original)).toBe('# notes');
      } finally {
        closeOpenedFile(original);
      }
    } finally {
      closeOpenedFile(held);
    }
  });

  it('rejects in-place changes after opening a text descriptor', () => {
    const opened = openRelativeFile(home, 'notes.md');
    try {
      writeFileSync(join(home, 'notes.md'), '# edits');
      expect(() => readOpenedText(opened)).toThrow(/changed while reading/i);
    } finally {
      closeOpenedFile(opened);
    }
  });

  it('bounds nonzero streams and closes zero-byte descriptors', async () => {
    writeFileSync(join(home, 'stream.txt'), 'before');
    const opened = openRelativeFile(home, 'stream.txt');
    const stream = createReadStreamFromFd(opened.fd, opened.stats.size);
    renameSync(join(home, 'stream.txt'), join(root, 'renamed-stream.txt'));
    writeFileSync(join(root, 'renamed-stream.txt'), 'before-with-growth');
    writeFileSync(join(home, 'stream.txt'), 'after-and-more');
    let content = '';
    for await (const chunk of stream) content += String(chunk);
    expect(content).toBe('before');

    writeFileSync(join(home, 'empty.bin'), '');
    const empty = openRelativeFile(home, 'empty.bin');
    const emptyStream = createReadStreamFromFd(empty.fd, empty.stats.size);
    const emptyDone = new Promise<void>((resolve, reject) => {
      emptyStream.once('end', resolve);
      emptyStream.once('error', reject);
    });
    emptyStream.resume();
    expect(() => readSync(empty.fd, Buffer.alloc(1), 0, 1, 0)).toThrow();
    await emptyDone;
  });

  it('uses an ASCII fallback and encoded UTF-8 filename parameter', () => {
    const disposition = contentDisposition('звіти #1.md', true);
    expect(disposition).toMatch(/^attachment; filename="[\x20-\x7e]+";/);
    expect(disposition).toContain("filename*=UTF-8''%D0%B7");
    expect(disposition).toContain('%23');
  });

  it('reports unavailable project file access explicitly', async () => {
    const unavailable = Fastify({ logger: false });
    registerProjectFileRoutes(unavailable);
    await unavailable.ready();
    const response = await unavailable.inject({
      method: 'GET',
      url: '/api/projects/alpha/files',
    });
    await unavailable.close();
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toMatch(/unavailable/i);
  });
});
