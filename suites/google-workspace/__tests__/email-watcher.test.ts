import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:stream';
import { Readable } from 'node:stream';

// vi.hoisted for mock setup before vi.mock hoisting
const { mockSpawn, mockGenerateId } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockGenerateId: vi.fn(() => 'test-id-123'),
}));

// Mock child_process.spawn — correct for streaming NDJSON from child process
vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

vi.mock('@raven/shared', () => ({
  generateId: mockGenerateId,
  SOURCE_GWS_GMAIL: 'gws-gmail',
}));

function createMockChild(): any {
  const cp = new EventEmitter();
  (cp as any).stdout = new Readable({ read() {} });
  (cp as any).stderr = new Readable({ read() {} });
  (cp as any).kill = vi.fn();
  (cp as any).pid = 12345;
  return cp;
}

describe('GWS Email Watcher Service', () => {
  let mockEventBus: { emit: ReturnType<typeof vi.fn> };
  let mockLogger: Record<string, ReturnType<typeof vi.fn>>;
  let mockChild: any;
  let service: any;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    mockEventBus = { emit: vi.fn() };
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    process.env.GWS_PRIMARY_CREDENTIALS_FILE = '/path/to/creds.json';
    process.env.GWS_GCP_PROJECT_ID = 'my-gcp-project';

    // Fresh module for each test to reset module-level state
    vi.resetModules();
    const mod = await import('../services/email-watcher.ts');
    service = mod.default;
  });

  afterEach(async () => {
    await service.stop();
    vi.useRealTimers();
    delete process.env.GWS_PRIMARY_CREDENTIALS_FILE;
    delete process.env.GWS_GCP_PROJECT_ID;
  });

  it('spawns gws gmail +watch with correct args', async () => {
    await service.start({
      eventBus: mockEventBus,
      logger: mockLogger,
      config: {},
      db: {} as any,
      projectRoot: '/tmp',
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      'gws',
      ['gmail', '+watch', '--project', 'my-gcp-project', '--label-ids', 'INBOX', '--msg-format', 'metadata', '--format', 'json'],
      expect.objectContaining({
        env: expect.objectContaining({
          GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE: '/path/to/creds.json',
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  });

  it('parses NDJSON lines and emits email:new events', async () => {
    await service.start({
      eventBus: mockEventBus,
      logger: mockLogger,
      config: {},
      db: {} as any,
      projectRoot: '/tmp',
    });

    const emailData = {
      from: 'alice@example.com',
      subject: 'Hello',
      snippet: 'Preview text',
      messageId: 'msg-123',
      date: '2026-03-19T10:00:00Z',
    };

    mockChild.stdout.push(JSON.stringify(emailData) + '\n');
    await vi.advanceTimersByTimeAsync(0);

    expect(mockEventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'test-id-123',
        source: 'gws-gmail',
        type: 'email:new',
        payload: expect.objectContaining({
          from: 'alice@example.com',
          subject: 'Hello',
          snippet: 'Preview text',
          messageId: 'msg-123',
        }),
      }),
    );
  });

  it('handles multiple NDJSON lines in one chunk', async () => {
    await service.start({
      eventBus: mockEventBus,
      logger: mockLogger,
      config: {},
      db: {} as any,
      projectRoot: '/tmp',
    });

    const line1 = JSON.stringify({ from: 'a@test.com', subject: 'First', id: '1' });
    const line2 = JSON.stringify({ from: 'b@test.com', subject: 'Second', id: '2' });
    mockChild.stdout.push(line1 + '\n' + line2 + '\n');
    await vi.advanceTimersByTimeAsync(0);

    expect(mockEventBus.emit).toHaveBeenCalledTimes(2);
  });

  it('reconnects after child process exits', async () => {
    await service.start({
      eventBus: mockEventBus,
      logger: mockLogger,
      config: {},
      db: {} as any,
      projectRoot: '/tmp',
    });

    expect(mockSpawn).toHaveBeenCalledTimes(1);

    mockChild.emit('exit', 1);
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    const newChild = createMockChild();
    mockSpawn.mockReturnValue(newChild);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('does not reconnect after stop()', async () => {
    await service.start({
      eventBus: mockEventBus,
      logger: mockLogger,
      config: {},
      db: {} as any,
      projectRoot: '/tmp',
    });

    await service.stop();
    mockChild.emit('exit', 0);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('does not start without credentials', async () => {
    delete process.env.GWS_PRIMARY_CREDENTIALS_FILE;

    // Reimport to pick up env change at module init
    vi.resetModules();
    const mod = await import('../services/email-watcher.ts');
    service = mod.default;

    await service.start({
      eventBus: mockEventBus,
      logger: mockLogger,
      config: {},
      db: {} as any,
      projectRoot: '/tmp',
    });

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('GWS_PRIMARY_CREDENTIALS_FILE not set'),
    );
  });

  it('does not start without GCP project ID', async () => {
    delete process.env.GWS_GCP_PROJECT_ID;

    vi.resetModules();
    const mod = await import('../services/email-watcher.ts');
    service = mod.default;

    await service.start({
      eventBus: mockEventBus,
      logger: mockLogger,
      config: {},
      db: {} as any,
      projectRoot: '/tmp',
    });

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('GWS_GCP_PROJECT_ID not set'),
    );
  });

  it('warns on invalid NDJSON lines', async () => {
    await service.start({
      eventBus: mockEventBus,
      logger: mockLogger,
      config: {},
      db: {} as any,
      projectRoot: '/tmp',
    });

    mockChild.stdout.push('not valid json\n');
    await vi.advanceTimersByTimeAsync(0);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to parse NDJSON'),
    );
    expect(mockEventBus.emit).not.toHaveBeenCalled();
  });
});
