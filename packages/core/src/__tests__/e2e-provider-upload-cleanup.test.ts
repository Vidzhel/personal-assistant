import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UploadFileResponse } from '@google/generative-ai/server';
import { closeDatabase, createDbInterface, initDatabase } from '../db/database.ts';
import {
  createGeminiUploadCleanup,
  type GeminiCleanupReport,
} from '../services/gemini-transcription/upload-cleanup.ts';
import { createRaven, type RavenInstance } from '../raven.ts';
import { buildTestConfig, createRavenTestFixture } from './fixtures/raven-fixture.ts';

const provider = vi.hoisted(() => ({ remove: vi.fn() }));
vi.mock('@google/generative-ai/server', () => ({
  GoogleAIFileManager: class {
    private readonly signal?: AbortSignal;
    constructor(_key: string, options?: { signal?: AbortSignal }) {
      this.signal = options?.signal;
    }
    deleteFile(name: string): Promise<void> {
      return provider.remove(name, this.signal) as Promise<void>;
    }
  },
}));

describe('e2e: provider upload recovery and shutdown', () => {
  let root: string | undefined;
  let raven: RavenInstance | undefined;
  let releaseDelete: (() => void) | undefined;

  afterEach(async () => {
    releaseDelete?.();
    await raven?.stop();
    raven = undefined;
    closeDatabase();
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
    vi.unstubAllEnvs();
  });

  async function report(): Promise<GeminiCleanupReport> {
    const response = await fetch(`http://127.0.0.1:${String(raven!.port)}/api/provider-uploads`);
    expect(response.status).toBe(200);
    return (await response.json()) as GeminiCleanupReport;
  }

  it('reports unknown uploads, aborts local cleanup before database close and retries the exact file on restart', async () => {
    vi.stubEnv('GOOGLE_API_KEY', 'fake-provider-cleanup-test-key');
    root = mkdtempSync(join(tmpdir(), 'raven-e2e-provider-cleanup-'));
    const paths = createRavenTestFixture(root);
    mkdirSync(dirname(paths.dbPath), { recursive: true });
    initDatabase(paths.dbPath);
    const previous = createGeminiUploadCleanup({ db: createDbInterface() });
    const unknownId = previous.begin({
      correlationId: 'interrupted-upload',
      projectId: 'meta',
      sourceFilePath: join(root, 'unknown.ogg'),
    });
    const knownId = previous.begin({
      correlationId: 'interrupted-inference',
      projectId: 'meta',
      sourceFilePath: join(root, 'known.ogg'),
    });
    await previous.observeUpload(
      knownId,
      Promise.resolve({
        file: {
          name: 'files/raven-known-upload',
          uri: 'https://example.invalid/raven-known-upload',
          mimeType: 'audio/ogg',
          state: 'ACTIVE',
        },
      } as UploadFileResponse),
    );
    // Simulate process interruption with active durable rows, no pending local
    // callbacks or cleanup attempts. The next composition owns recovery.
    closeDatabase();

    const heldDeletion = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    provider.remove.mockReset().mockReturnValue(heldDeletion);
    const backend = vi.fn(async () => {
      throw new Error('Provider cleanup must not dispatch a model');
    });
    const boot = async (): Promise<void> => {
      raven = await createRaven(buildTestConfig(), {
        ...paths,
        skipSuites: true,
        apiHost: '127.0.0.1',
        agentBackend: backend,
      });
      await raven.start();
    };
    await boot();
    await vi.waitFor(() => expect(provider.remove).toHaveBeenCalledTimes(1));
    const signal = provider.remove.mock.calls[0][1] as AbortSignal;
    expect(signal.aborted).toBe(false);
    expect(provider.remove.mock.calls[0][0]).toBe('files/raven-known-upload');
    const before = await report();
    expect(before.counts).toMatchObject({ unknown: 1, pending_delete: 1, deleted: 0 });
    expect(before.unresolved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: unknownId, correlationId: 'interrupted-upload' }),
        expect.objectContaining({ id: knownId, remoteFileName: 'files/raven-known-upload' }),
      ]),
    );

    await raven!.stop();
    raven = undefined;
    expect(signal.aborted).toBe(true);
    // The provider ignores abort and completes only after the old database
    // handle is closed. It must not acknowledge deletion through that handle.
    releaseDelete!();
    await new Promise<void>((resolve) => setImmediate(resolve));

    provider.remove.mockResolvedValue(undefined);
    await boot();
    await vi.waitFor(async () => {
      expect((await report()).counts).toMatchObject({ unknown: 1, pending_delete: 0, deleted: 1 });
    });
    expect(provider.remove).toHaveBeenCalledTimes(2);
    expect(provider.remove.mock.calls.map(([name]) => name)).toEqual([
      'files/raven-known-upload',
      'files/raven-known-upload',
    ]);
    expect(backend).not.toHaveBeenCalled();
  }, 15_000);
});
