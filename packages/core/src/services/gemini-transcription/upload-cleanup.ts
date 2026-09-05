import { generateId, createLogger, type DatabaseInterface } from '@raven/shared';
import {
  GoogleAIFileManager,
  type SingleRequestOptions,
  type UploadFileResponse,
} from '@google/generative-ai/server';

const DEFAULT_TIMEOUT_MS = 10_000;
const RETRY_LIMIT = 25;
const REPORT_LIMIT = 100;
const NOT_FOUND = 404;
const REMOTE_NAME = /^(?:files\/)?[A-Za-z0-9_-]+$/;
const log = createLogger('gemini-upload-cleanup');

export type GeminiUploadStatus = 'uploading' | 'active' | 'pending_delete' | 'unknown' | 'deleted';
export interface GeminiUploadBeginInput {
  correlationId: string;
  projectId?: string;
  sourceFilePath: string;
}
export interface GeminiCleanupUnresolved {
  id: string;
  status: Exclude<GeminiUploadStatus, 'deleted'>;
  correlationId: string;
  projectId?: string;
  sourceFilePath: string;
  remoteFileName?: string;
  attemptCount: number;
  lastError?: string;
}
export interface GeminiCleanupCounts {
  uploading: number;
  active: number;
  pending_delete: number;
  unknown: number;
  deleted: number;
}
export interface GeminiCleanupReport {
  counts: GeminiCleanupCounts;
  unresolved: GeminiCleanupUnresolved[];
  truncated: boolean;
}
export interface GeminiUploadCleanup {
  begin(input: GeminiUploadBeginInput): string;
  observeUpload(id: string, promise: Promise<UploadFileResponse>): Promise<UploadFileResponse>;
  finish(id: string): void;
  recoverInterrupted(): void;
  retryPending(): Promise<GeminiCleanupReport>;
  getReport(): GeminiCleanupReport;
  stop(): Promise<void>;
}
interface UploadRow {
  id: string;
  correlation_id: string;
  project_id: string | null;
  source_file_path: string;
  remote_name: string | null;
  status: GeminiUploadStatus;
  attempt_count: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}
interface CleanupOptions {
  db: DatabaseInterface;
  deleteFile?: (name: string, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
}
interface StatusUpdate {
  status: GeminiUploadStatus;
  remoteName: string | null;
  lastError: string | null;
  attemptCount?: number;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return (error as { status?: unknown }).status === NOT_FOUND;
}
function remoteNameFrom(result: UploadFileResponse): string | undefined {
  const name = result?.file?.name;
  return typeof name === 'string' && REMOTE_NAME.test(name) ? name : undefined;
}
async function deleteWithGoogle(name: string, signal: AbortSignal): Promise<void> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('Remote deletion is unavailable: GOOGLE_API_KEY is not set');
  const options: SingleRequestOptions = { signal };
  const manager = new GoogleAIFileManager(apiKey, options);
  await manager.deleteFile(name);
}

class GeminiUploadCleanupImpl implements GeminiUploadCleanup {
  private readonly options: CleanupOptions;
  private stopped = false;
  private stopPromise: Promise<void> | undefined;
  private stoppedReport: GeminiCleanupReport | undefined;
  private stopError: Error | undefined;
  private readonly attempts = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly removeFile: (name: string, signal: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(options: CleanupOptions) {
    this.options = options;
    this.removeFile = options.deleteFile ?? deleteWithGoogle;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }
  private read(id: string): UploadRow | undefined {
    return this.options.db.get<UploadRow>('SELECT * FROM gemini_uploads WHERE id = ?', id);
  }
  private writeStatus(id: string, update: StatusUpdate): void {
    this.options.db.run(
      `UPDATE gemini_uploads SET status = ?, remote_name = ?, last_error = ?, attempt_count = COALESCE(?, attempt_count), updated_at = ? WHERE id = ?`,
      update.status,
      update.remoteName,
      update.lastError,
      update.attemptCount ?? null,
      this.now(),
      id,
    );
  }
  begin(input: GeminiUploadBeginInput): string {
    if (this.stopped) throw new Error('Gemini upload cleanup is stopped');
    if (!input.correlationId || !input.sourceFilePath)
      throw new Error('Gemini upload correlationId and sourceFilePath are required');
    const id = generateId();
    const timestamp = this.now();
    this.options.db.run(
      `INSERT INTO gemini_uploads (id, correlation_id, project_id, source_file_path, status, attempt_count, created_at, updated_at) VALUES (?, ?, ?, ?, 'uploading', 0, ?, ?)`,
      id,
      input.correlationId,
      input.projectId ?? null,
      input.sourceFilePath,
      timestamp,
      timestamp,
    );
    return id;
  }
  observeUpload(id: string, promise: Promise<UploadFileResponse>): Promise<UploadFileResponse> {
    const observed = promise.then(
      (result) => this.captureUpload(id, result),
      (error) => this.captureUploadFailure(id, error),
    );
    void observed.catch(() => undefined);
    return observed;
  }
  private captureUpload(id: string, result: UploadFileResponse): UploadFileResponse {
    if (this.stopped) return result;
    const row = this.read(id);
    if (!row) throw new Error(`Unknown Gemini upload record: ${id}`);
    if (row.status === 'deleted' || row.status === 'pending_delete') return result;
    const name = remoteNameFrom(result);
    if (!name) {
      this.writeStatus(id, {
        status: 'unknown',
        remoteName: null,
        lastError: 'Provider returned no valid file name',
      });
      throw new Error('Provider returned no valid file name');
    }
    this.writeStatus(
      id,
      row.status === 'unknown'
        ? { status: 'pending_delete', remoteName: name, lastError: null }
        : { status: 'active', remoteName: name, lastError: null },
    );
    if (row.status === 'unknown') void this.startDelete(id).catch(() => undefined);
    return result;
  }
  private captureUploadFailure(id: string, error: unknown): never {
    if (!this.stopped) {
      const row = this.read(id);
      if (row?.status === 'uploading')
        this.writeStatus(id, { status: 'unknown', remoteName: null, lastError: errorText(error) });
    }
    throw error;
  }
  finish(id: string): void {
    if (this.stopped) return;
    const row = this.read(id);
    if (!row || row.status === 'deleted') return;
    const name = row.remote_name;
    if (name && REMOTE_NAME.test(name)) {
      this.writeStatus(id, {
        status: 'pending_delete',
        remoteName: name,
        lastError: row.last_error,
      });
      void this.startDelete(id).catch((error) =>
        log.warn(`Unable to start Gemini upload deletion: ${errorText(error)}`),
      );
    } else {
      this.writeStatus(id, {
        status: 'unknown',
        remoteName: null,
        lastError: row.last_error ?? 'Provider file name was not captured',
      });
    }
  }
  recoverInterrupted(): void {
    if (this.stopped) return;
    const rows = this.options.db.all<UploadRow>(
      `SELECT * FROM gemini_uploads WHERE status IN ('uploading', 'active') ORDER BY created_at ASC`,
    );
    for (const row of rows) {
      const known = row.status === 'active' && row.remote_name && REMOTE_NAME.test(row.remote_name);
      this.writeStatus(
        row.id,
        known
          ? {
              status: 'pending_delete',
              remoteName: row.remote_name,
              lastError: 'Recovered interrupted upload',
            }
          : {
              status: 'unknown',
              remoteName: null,
              lastError: 'Upload outcome was interrupted before a valid file name was recorded',
            },
      );
    }
  }
  private startDelete(id: string): Promise<void> {
    const existing = this.attempts.get(id);
    if (existing) return existing;
    const work = this.deleteOne(id);
    this.attempts.set(id, work);
    void work
      .finally(() => {
        if (this.attempts.get(id) === work) this.attempts.delete(id);
      })
      .catch(() => undefined);
    return work;
  }
  private async deleteOne(id: string): Promise<void> {
    const row = this.read(id);
    if (!row || row.status !== 'pending_delete' || !row.remote_name || this.stopped) return;
    this.writeStatus(id, {
      status: 'pending_delete',
      remoteName: row.remote_name,
      lastError: row.last_error,
      attemptCount: row.attempt_count + 1,
    });
    const controller = new AbortController();
    this.controllers.set(id, controller);
    try {
      if (this.stopped) return;
      await this.awaitDelete(row.remote_name, controller);
      if (!this.stopped && !controller.signal.aborted)
        this.writeStatus(id, { status: 'deleted', remoteName: row.remote_name, lastError: null });
    } catch (error) {
      if (!this.stopped) this.recordDeleteFailure(id, row.remote_name, error);
    } finally {
      this.controllers.delete(id);
    }
  }
  private async awaitDelete(name: string, controller: AbortController): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let abort!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      abort = resolve;
      controller.signal.addEventListener('abort', abort, { once: true });
    });
    const provider = Promise.resolve().then(() => {
      if (this.stopped || controller.signal.aborted) throw new Error('Cleanup stopped');
      return this.removeFile(name, controller.signal);
    });
    void provider.catch(() => undefined);
    try {
      await Promise.race([
        provider,
        cancelled,
        new Promise<void>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(new Error('Remote deletion timed out'));
          }, this.timeoutMs);
        }),
      ]);
      if (timedOut || this.stopped || controller.signal.aborted)
        throw new Error(timedOut ? 'Remote deletion timed out' : 'Cleanup stopped');
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', abort);
    }
  }
  private recordDeleteFailure(id: string, name: string, error: unknown): void {
    this.writeStatus(id, {
      status: isNotFound(error) ? 'deleted' : 'pending_delete',
      remoteName: name,
      lastError: isNotFound(error) ? null : errorText(error),
    });
  }
  async retryPending(): Promise<GeminiCleanupReport> {
    if (this.stopped) return this.stoppedReport ?? this.getReport();
    const rows = this.options.db.all<UploadRow>(
      `SELECT * FROM gemini_uploads WHERE status = 'pending_delete' ORDER BY attempt_count ASC, updated_at ASC, id ASC LIMIT ?`,
      RETRY_LIMIT,
    );
    await Promise.allSettled(rows.map((row) => this.startDelete(row.id)));
    return this.getReport();
  }
  getReport(): GeminiCleanupReport {
    if (this.stopError) throw this.stopError;
    if (this.stoppedReport) return this.stoppedReport;
    const rows = this.options.db.all<{ status: GeminiUploadStatus; count: number }>(
      'SELECT status, COUNT(*) AS count FROM gemini_uploads GROUP BY status',
    );
    const counts: GeminiCleanupCounts = {
      uploading: 0,
      active: 0,
      pending_delete: 0,
      unknown: 0,
      deleted: 0,
    };
    for (const row of rows) counts[row.status] = row.count;
    const unresolved = this.options.db.all<UploadRow>(
      `SELECT * FROM gemini_uploads WHERE status IN ('pending_delete', 'unknown') ORDER BY created_at ASC LIMIT ?`,
      REPORT_LIMIT + 1,
    );
    return {
      counts,
      unresolved: unresolved.slice(0, REPORT_LIMIT).map((row) => ({
        id: row.id,
        status: row.status as GeminiCleanupUnresolved['status'],
        correlationId: row.correlation_id,
        ...(row.project_id !== null && { projectId: row.project_id }),
        sourceFilePath: row.source_file_path,
        ...(row.remote_name !== null && { remoteFileName: row.remote_name }),
        attemptCount: row.attempt_count,
        ...(row.last_error !== null && { lastError: row.last_error }),
      })),
      truncated: unresolved.length > REPORT_LIMIT,
    };
  }
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    try {
      const rows = this.options.db.all<UploadRow>(
        `SELECT * FROM gemini_uploads WHERE status IN ('uploading', 'active')`,
      );
      for (const row of rows) {
        const known =
          row.status === 'active' && row.remote_name && REMOTE_NAME.test(row.remote_name);
        this.writeStatus(
          row.id,
          known
            ? {
                status: 'pending_delete',
                remoteName: row.remote_name,
                lastError: 'Cleanup stopped before remote deletion completed',
              }
            : {
                status: 'unknown',
                remoteName: row.remote_name,
                lastError: 'Cleanup stopped before provider upload outcome was known',
              },
        );
      }
      this.stoppedReport = this.getReport();
    } catch (error) {
      this.stopError = error instanceof Error ? error : new Error(errorText(error));
    }
    for (const controller of this.controllers.values()) controller.abort();
    this.stopPromise = Promise.allSettled([...this.attempts.values()]).then(() => {
      if (this.stopError) throw this.stopError;
    });
    return this.stopPromise;
  }
}

export function createGeminiUploadCleanup(options: CleanupOptions): GeminiUploadCleanup {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0)
    throw new Error('Gemini upload cleanup timeout must be a positive safe integer');
  return new GeminiUploadCleanupImpl(options);
}
