import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { UploadFileResponse } from '@google/generative-ai/server';
import type { DatabaseInterface } from '@raven/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGeminiUploadCleanup } from '../../../services/gemini-transcription/upload-cleanup.ts';

const migration = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../../migrations/001-initial-schema.sql',
);

function uploaded(name: string): UploadFileResponse {
  return {
    file: { name, uri: `https://example.invalid/${name}`, mimeType: 'audio/ogg', state: 'ACTIVE' },
  } as UploadFileResponse;
}

function database(): { db: Database.Database; api: DatabaseInterface; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), 'raven-upload-cleanup-'));
  const db = new Database(join(directory, 'raven.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.transaction(() => db.exec(readFileSync(migration, 'utf8')))();
  const api: DatabaseInterface = {
    run: (sql, ...params) => {
      db.prepare(sql).run(...params);
    },
    get: <T>(sql: string, ...params: unknown[]) => db.prepare(sql).get(...params) as T | undefined,
    all: <T>(sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as T[],
  };
  return { db, api, directory };
}

describe('Gemini upload cleanup coordinator', () => {
  const resources: Array<{ db: Database.Database; directory: string }> = [];
  afterEach(() => {
    for (const resource of resources.splice(0)) {
      if (resource.db.open) resource.db.close();
      rmSync(resource.directory, { recursive: true, force: true });
    }
  });

  it('persists upload ownership before dispatch and deletes the exact provider name after finish', async () => {
    const resource = database();
    resources.push(resource);
    const remove = vi
      .fn<(name: string, signal: AbortSignal) => Promise<void>>()
      .mockResolvedValue(undefined);
    const cleanup = createGeminiUploadCleanup({ db: resource.api, deleteFile: remove });
    const id = cleanup.begin({
      correlationId: 'voice-1',
      projectId: 'project-a',
      sourceFilePath: '/tmp/audio.ogg',
    });
    expect(resource.db.prepare('SELECT status FROM gemini_uploads WHERE id = ?').get(id)).toEqual({
      status: 'uploading',
    });
    await cleanup.observeUpload(id, Promise.resolve(uploaded('files/exact-name')));
    cleanup.finish(id);
    await vi.waitFor(() =>
      expect(remove).toHaveBeenCalledWith('files/exact-name', expect.any(AbortSignal)),
    );
    await vi.waitFor(() => expect(cleanup.getReport().counts.deleted).toBe(1));
    cleanup.finish(id);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(cleanup.getReport().unresolved).toEqual([]);
    await cleanup.stop();
  });

  it('records unknown and rejects invalid provider responses without inferring a remote file', async () => {
    const resource = database();
    resources.push(resource);
    const remove = vi.fn().mockResolvedValue(undefined);
    const cleanup = createGeminiUploadCleanup({ db: resource.api, deleteFile: remove });
    const id = cleanup.begin({ correlationId: 'bad-upload', sourceFilePath: '/tmp/audio.ogg' });
    await expect(
      cleanup.observeUpload(id, Promise.resolve({ file: {} } as UploadFileResponse)),
    ).rejects.toThrow('Provider returned no valid file name');
    expect(cleanup.getReport()).toMatchObject({ counts: { unknown: 1, pending_delete: 0 } });
    expect(remove).not.toHaveBeenCalled();
    await cleanup.stop();
  });

  it('recovers active and uploading rows, while retrying only known exact names', async () => {
    const first = database();
    resources.push(first);
    const remove = vi.fn().mockResolvedValue(undefined);
    const initial = createGeminiUploadCleanup({ db: first.api, deleteFile: remove });
    const unknown = initial.begin({ correlationId: 'unknown', sourceFilePath: '/tmp/u.ogg' });
    const known = initial.begin({ correlationId: 'known', sourceFilePath: '/tmp/k.ogg' });
    await initial.observeUpload(known, Promise.resolve(uploaded('files/known')));
    const second = createGeminiUploadCleanup({ db: first.api, deleteFile: remove });
    second.recoverInterrupted();
    expect(second.getReport().counts).toMatchObject({ unknown: 1, pending_delete: 1 });
    await second.retryPending();
    await vi.waitFor(() => expect(second.getReport().counts.deleted).toBe(1));
    expect(remove).toHaveBeenCalledWith('files/known', expect.any(AbortSignal));
    expect(second.getReport().unresolved.map((row) => row.id)).toEqual([unknown]);
    await second.stop();
  });

  it('shares a pending deletion attempt across duplicate retries and treats numeric 404 as deleted', async () => {
    const resource = database();
    resources.push(resource);
    let reject!: (reason: unknown) => void;
    const held = new Promise<void>((_, no) => {
      reject = no;
    });
    const remove = vi
      .fn<(name: string, signal: AbortSignal) => Promise<void>>()
      .mockReturnValueOnce(held)
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { status: 404 }));
    const cleanup = createGeminiUploadCleanup({ db: resource.api, deleteFile: remove });
    const id = cleanup.begin({ correlationId: 'retry', sourceFilePath: '/tmp/r.ogg' });
    await cleanup.observeUpload(id, Promise.resolve(uploaded('files/retry')));
    cleanup.finish(id);
    await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    const first = cleanup.retryPending();
    const second = cleanup.retryPending();
    expect(remove).toHaveBeenCalledTimes(1);
    reject(new Error('temporary provider failure'));
    await Promise.all([first, second]);
    expect(cleanup.getReport().counts.pending_delete).toBe(1);
    await cleanup.retryPending();
    await vi.waitFor(() => expect(cleanup.getReport().counts.deleted).toBe(1));
    expect(remove).toHaveBeenCalledTimes(2);
    await cleanup.stop();
  });

  it('does not touch a closed database from late upload or deletion callbacks after stop', async () => {
    const resource = database();
    resources.push(resource);
    let resolveUpload!: (value: UploadFileResponse) => void;
    let resolveDelete!: () => void;
    const upload = new Promise<UploadFileResponse>((resolve) => {
      resolveUpload = resolve;
    });
    const deletion = new Promise<void>((resolve) => {
      resolveDelete = resolve;
    });
    const remove = vi.fn().mockReturnValue(deletion);
    const cleanup = createGeminiUploadCleanup({ db: resource.api, deleteFile: remove });
    const uploadId = cleanup.begin({ correlationId: 'late-upload', sourceFilePath: '/tmp/u.ogg' });
    const observed = cleanup.observeUpload(uploadId, upload);
    const deleteId = cleanup.begin({ correlationId: 'late-delete', sourceFilePath: '/tmp/d.ogg' });
    await cleanup.observeUpload(deleteId, Promise.resolve(uploaded('files/late')));
    cleanup.finish(deleteId);
    await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    await cleanup.stop();
    const report = cleanup.getReport();
    resource.db.close();
    resolveUpload(uploaded('files/after-stop'));
    resolveDelete();
    await expect(observed).resolves.toEqual(uploaded('files/after-stop'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cleanup.getReport()).toEqual(report);
    await expect(cleanup.retryPending()).resolves.toEqual(report);
  });

  it('aborts and drains a deletion when stop persistence fails before propagating the failure', async () => {
    const resource = database();
    resources.push(resource);
    let failStopRead = false;
    let releaseDelete!: () => void;
    const deletion = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const remove = vi.fn().mockReturnValue(deletion);
    const failing: DatabaseInterface = {
      run: resource.api.run,
      get: resource.api.get,
      all: (sql, ...params) => {
        if (failStopRead && sql.includes("status IN ('uploading', 'active')"))
          throw new Error('stop read failed');
        return resource.api.all(sql, ...params);
      },
    };
    const cleanup = createGeminiUploadCleanup({ db: failing, deleteFile: remove });
    const id = cleanup.begin({ correlationId: 'stop-fault', sourceFilePath: '/tmp/stop.ogg' });
    await cleanup.observeUpload(id, Promise.resolve(uploaded('files/stop-fault')));
    cleanup.finish(id);
    await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    const signal = remove.mock.calls[0][1] as AbortSignal;
    failStopRead = true;
    await expect(cleanup.stop()).rejects.toThrow('stop read failed');
    expect(signal.aborted).toBe(true);
    resource.db.close();
    expect(() => cleanup.getReport()).toThrow('stop read failed');
    await expect(cleanup.retryPending()).rejects.toThrow('stop read failed');
    releaseDelete();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it('returns the persistence failure from the observed upload chain', async () => {
    const resource = database();
    resources.push(resource);
    const failing: DatabaseInterface = {
      ...resource.api,
      run: (sql, ...params) => {
        if (sql.startsWith('UPDATE gemini_uploads')) throw new Error('disk write failed');
        resource.api.run(sql, ...params);
      },
    };
    const cleanup = createGeminiUploadCleanup({ db: failing, deleteFile: vi.fn() });
    const id = cleanup.begin({ correlationId: 'fault', sourceFilePath: '/tmp/f.ogg' });
    await expect(
      cleanup.observeUpload(id, Promise.resolve(uploaded('files/fault'))),
    ).rejects.toThrow('disk write failed');
  });

  it('uses fair retry ordering so a record beyond the first batch is eventually attempted', async () => {
    const resource = database();
    resources.push(resource);
    const now = Date.now();
    for (let index = 0; index < 26; index += 1) {
      resource.db
        .prepare(
          `INSERT INTO gemini_uploads (id, correlation_id, source_file_path, remote_name, status, attempt_count, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending_delete', 0, ?, ?)`,
        )
        .run(
          `retry-${String(index).padStart(2, '0')}`,
          'batch',
          '/tmp/batch.ogg',
          `files/batch-${index}`,
          now,
          now + index,
        );
    }
    const remove = vi
      .fn<(name: string, signal: AbortSignal) => Promise<void>>()
      .mockRejectedValue(new Error('offline'));
    const cleanup = createGeminiUploadCleanup({ db: resource.api, deleteFile: remove });
    await cleanup.retryPending();
    expect(remove).toHaveBeenCalledTimes(25);
    remove.mockResolvedValue(undefined);
    await cleanup.retryPending();
    await vi.waitFor(() => expect(cleanup.getReport().counts.deleted).toBe(25));
    expect(remove.mock.calls.some(([name]) => name === 'files/batch-25')).toBe(true);
    await cleanup.stop();
  });

  it('retains timed-out deletion until a retry confirms removal and clears its timer', async () => {
    vi.useFakeTimers();
    const resource = database();
    resources.push(resource);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const remove = vi
      .fn<(name: string, signal: AbortSignal) => Promise<void>>()
      .mockReturnValueOnce(held)
      .mockResolvedValue(undefined);
    const cleanup = createGeminiUploadCleanup({
      db: resource.api,
      deleteFile: remove,
      timeoutMs: 20,
    });
    try {
      const id = cleanup.begin({ correlationId: 'timeout', sourceFilePath: '/tmp/timeout.ogg' });
      await cleanup.observeUpload(id, Promise.resolve(uploaded('files/timeout')));
      cleanup.finish(id);
      const pending = cleanup.retryPending();
      await vi.advanceTimersByTimeAsync(20);
      expect((await pending).counts.pending_delete).toBe(1);
      expect(remove.mock.calls[0][1].aborted).toBe(true);
      expect(cleanup.getReport().unresolved[0].lastError).toContain('timed out');
      expect(vi.getTimerCount()).toBe(0);
      release();
      await Promise.resolve();
      expect(cleanup.getReport().counts.deleted).toBe(0);
      expect((await cleanup.retryPending()).counts.deleted).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      release();
      await cleanup.stop();
      vi.useRealTimers();
    }
  });

  it('never starts remote deletion when stop wins before provider dispatch', async () => {
    const resource = database();
    resources.push(resource);
    const remove = vi.fn().mockResolvedValue(undefined);
    const cleanup = createGeminiUploadCleanup({ db: resource.api, deleteFile: remove });
    const id = cleanup.begin({ correlationId: 'queued-delete', sourceFilePath: '/tmp/queued.ogg' });
    await cleanup.observeUpload(id, Promise.resolve(uploaded('files/queued')));
    cleanup.finish(id);
    await cleanup.stop();
    expect(remove).not.toHaveBeenCalled();
    expect(cleanup.getReport().counts.pending_delete).toBe(1);
  });

  it.each([{ status: '404' }, { statusCode: 404 }])(
    'does not treat an unrecognized error as confirmed absence (%j)',
    async (error) => {
      const resource = database();
      resources.push(resource);
      const cleanup = createGeminiUploadCleanup({
        db: resource.api,
        deleteFile: vi.fn().mockRejectedValue(error),
      });
      const id = cleanup.begin({ correlationId: 'unconfirmed', sourceFilePath: '/tmp/error.ogg' });
      await cleanup.observeUpload(id, Promise.resolve(uploaded('files/unconfirmed')));
      cleanup.finish(id);
      expect((await cleanup.retryPending()).counts).toMatchObject({
        pending_delete: 1,
        deleted: 0,
      });
      await cleanup.stop();
    },
  );

  it('bounds unresolved diagnostics while preserving distinct attempts and projects for one correlation', async () => {
    const resource = database();
    resources.push(resource);
    const remove = vi.fn();
    const cleanup = createGeminiUploadCleanup({ db: resource.api, deleteFile: remove });
    const ids = new Set<string>();
    for (let index = 0; index < 105; index++) {
      const id = cleanup.begin({
        correlationId: 'shared-event',
        projectId: `project-${index}`,
        sourceFilePath: `/tmp/${index}.ogg`,
      });
      ids.add(id);
      cleanup.finish(id);
    }
    const report = cleanup.getReport();
    expect(ids.size).toBe(105);
    expect(report.counts.unknown).toBe(105);
    expect(report.unresolved).toHaveLength(100);
    expect(report.truncated).toBe(true);
    expect(new Set(report.unresolved.map((row) => row.projectId)).size).toBe(100);
    expect(report.unresolved.every((row) => row.correlationId === 'shared-event')).toBe(true);
    expect(remove).not.toHaveBeenCalled();
    await cleanup.stop();
  });
});
