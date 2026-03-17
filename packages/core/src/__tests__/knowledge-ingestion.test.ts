import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, getDb, createDbInterface } from '../db/database.ts';
import { createKnowledgeStore } from '../knowledge-engine/knowledge-store.ts';
import type { KnowledgeStore } from '../knowledge-engine/knowledge-store.ts';
import { createIngestionProcessor } from '../knowledge-engine/ingestion.ts';
import type { IngestionProcessor } from '../knowledge-engine/ingestion.ts';
import { EventBus } from '../event-bus/event-bus.ts';
import type { RavenEvent, AgentTaskRequestEvent } from '@raven/shared';
import {
  detectFileType,
  extractFromFile,
  extractFromUrl,
  copyToMediaDir,
} from '../knowledge-engine/content-extractor.ts';

// ─── Content Extractor Tests ──────────────────────────────────────

describe('content-extractor', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'extractor-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('detectFileType', () => {
    it('returns pdf for .pdf files', () => {
      expect(detectFileType('report.pdf')).toBe('pdf');
    });

    it('returns text for known text extensions', () => {
      expect(detectFileType('notes.txt')).toBe('text');
      expect(detectFileType('readme.md')).toBe('text');
      expect(detectFileType('page.html')).toBe('text');
      expect(detectFileType('data.csv')).toBe('text');
      expect(detectFileType('config.json')).toBe('text');
      expect(detectFileType('data.xml')).toBe('text');
      expect(detectFileType('app.ts')).toBe('text');
      expect(detectFileType('script.js')).toBe('text');
      expect(detectFileType('config.yaml')).toBe('text');
    });

    it('returns unsupported for binary types', () => {
      expect(detectFileType('archive.zip')).toBe('unsupported');
      expect(detectFileType('image.png')).toBe('unsupported');
      expect(detectFileType('video.mp4')).toBe('unsupported');
      expect(detectFileType('app.exe')).toBe('unsupported');
    });
  });

  describe('extractFromFile', () => {
    it('reads text files directly', async () => {
      const filePath = join(tmpDir, 'test.txt');
      writeFileSync(filePath, 'Hello world', 'utf-8');
      const content = await extractFromFile(filePath);
      expect(content).toBe('Hello world');
    });

    it('reads markdown files', async () => {
      const filePath = join(tmpDir, 'test.md');
      writeFileSync(filePath, '# Title\n\nSome content', 'utf-8');
      const content = await extractFromFile(filePath);
      expect(content).toBe('# Title\n\nSome content');
    });

    it('strips HTML tags from .html files', async () => {
      const filePath = join(tmpDir, 'page.html');
      writeFileSync(filePath, '<html><body><p>Hello</p></body></html>', 'utf-8');
      const content = await extractFromFile(filePath);
      expect(content).not.toContain('<');
      expect(content).toContain('Hello');
    });

    it('strips script and style tags from HTML', async () => {
      const filePath = join(tmpDir, 'page.htm');
      writeFileSync(
        filePath,
        '<html><script>alert(1)</script><style>body{}</style><p>Content</p></html>',
        'utf-8',
      );
      const content = await extractFromFile(filePath);
      expect(content).not.toContain('alert');
      expect(content).not.toContain('body{}');
      expect(content).toContain('Content');
    });

    it('reads CSV files as raw text', async () => {
      const filePath = join(tmpDir, 'data.csv');
      writeFileSync(filePath, 'name,value\nfoo,1\nbar,2', 'utf-8');
      const content = await extractFromFile(filePath);
      expect(content).toContain('name,value');
    });

    it('reads JSON files as raw text', async () => {
      const filePath = join(tmpDir, 'config.json');
      writeFileSync(filePath, '{"key": "value"}', 'utf-8');
      const content = await extractFromFile(filePath);
      expect(content).toContain('"key"');
    });

    it('throws for unsupported file types', async () => {
      const filePath = join(tmpDir, 'archive.zip');
      writeFileSync(filePath, 'binary data');
      await expect(extractFromFile(filePath)).rejects.toThrow('Unsupported file type: .zip');
    });

    it('throws for non-existent files', async () => {
      await expect(extractFromFile(join(tmpDir, 'nope.txt'))).rejects.toThrow('File not found');
    });

    it('rejects unsupported .png file type (binary check)', async () => {
      const filePath = join(tmpDir, 'image.png');
      writeFileSync(filePath, 'PNG header');
      await expect(extractFromFile(filePath)).rejects.toThrow('Unsupported file type: .png');
    });
  });

  describe('extractFromUrl', () => {
    it('fetches plain text content', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('Plain text content', {
          headers: { 'content-type': 'text/plain' },
        }),
      );
      const content = await extractFromUrl('https://example.com/data.txt');
      expect(content).toBe('Plain text content');
      vi.restoreAllMocks();
    });

    it('strips HTML from fetched web pages', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('<html><body><p>Extracted</p></body></html>', {
          headers: { 'content-type': 'text/html' },
        }),
      );
      const content = await extractFromUrl('https://example.com');
      expect(content).not.toContain('<');
      expect(content).toContain('Extracted');
      vi.restoreAllMocks();
    });

    it('throws for unreachable URLs', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network error'));
      await expect(extractFromUrl('https://unreachable.example')).rejects.toThrow('network error');
      vi.restoreAllMocks();
    });

    it('throws for failed HTTP responses', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('', { status: 404, statusText: 'Not Found' }),
      );
      await expect(extractFromUrl('https://example.com/404')).rejects.toThrow('URL fetch failed');
      vi.restoreAllMocks();
    });
  });

  describe('copyToMediaDir', () => {
    it('copies file to media directory', () => {
      const mediaDir = join(tmpDir, 'data', 'media');
      mkdirSync(mediaDir, { recursive: true });
      const sourceFile = join(tmpDir, 'source.pdf');
      writeFileSync(sourceFile, 'pdf content');

      const relPath = copyToMediaDir({ sourcePath: sourceFile, mediaDir });
      expect(relPath).toContain('source.pdf');
      expect(existsSync(join(mediaDir, 'source.pdf'))).toBe(true);
    });

    it('skips copy when file is already in media dir', () => {
      const mediaDir = join(tmpDir, 'data', 'media');
      mkdirSync(mediaDir, { recursive: true });
      const sourceFile = join(mediaDir, 'existing.pdf');
      writeFileSync(sourceFile, 'already here');

      const relPath = copyToMediaDir({ sourcePath: sourceFile, mediaDir });
      expect(relPath).toContain('existing.pdf');
    });

    it('handles filename collision with timestamp prefix', () => {
      const mediaDir = join(tmpDir, 'data', 'media');
      mkdirSync(mediaDir, { recursive: true });
      writeFileSync(join(mediaDir, 'report.pdf'), 'existing');
      const sourceFile = join(tmpDir, 'report.pdf');
      writeFileSync(sourceFile, 'new content');

      const relPath = copyToMediaDir({ sourcePath: sourceFile, mediaDir });
      expect(relPath).not.toBe('data/media/report.pdf');
      expect(relPath).toContain('report.pdf');
    });
  });
});

// ─── Ingestion Processor Tests ────────────────────────────────────

describe('IngestionProcessor', () => {
  let tmpDir: string;
  let knowledgeDir: string;
  let mediaDir: string;
  let store: KnowledgeStore;
  let eventBus: EventBus;
  let processor: IngestionProcessor;

  function mockExecutionLogger(): any {
    return {
      logTaskStart: vi.fn(),
      logTaskEnd: vi.fn(),
      getTaskStatus: vi.fn(),
    };
  }

  function simulateAgentCompletion(bus: EventBus, taskId: string, result: object): void {
    bus.emit({
      id: 'test-completion',
      timestamp: Date.now(),
      source: 'test',
      type: 'agent:task:complete',
      payload: {
        taskId,
        result: JSON.stringify(result),
        durationMs: 100,
        success: true,
      },
    } as RavenEvent);
  }

  function simulateAgentFailure(bus: EventBus, taskId: string): void {
    bus.emit({
      id: 'test-failure',
      timestamp: Date.now(),
      source: 'test',
      type: 'agent:task:complete',
      payload: {
        taskId,
        result: '',
        durationMs: 100,
        success: false,
        errors: ['Agent failed'],
      },
    } as RavenEvent);
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ingestion-'));
    knowledgeDir = join(tmpDir, 'data', 'knowledge');
    mediaDir = join(tmpDir, 'data', 'media');
    mkdirSync(knowledgeDir, { recursive: true });
    mkdirSync(mediaDir, { recursive: true });
    initDatabase(join(tmpDir, 'test.db'));
    store = createKnowledgeStore({ db: createDbInterface(), knowledgeDir });
    eventBus = new EventBus();
    processor = createIngestionProcessor({
      knowledgeStore: store,
      eventBus,
      executionLogger: mockExecutionLogger(),
      mediaDir,
    });
  });

  afterEach(() => {
    try {
      getDb().close();
    } catch {
      /* */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('text ingestion', () => {
    it('creates bubble with provided title after agent analysis', async () => {
      let capturedTaskId = '';
      eventBus.on('agent:task:request', (event: RavenEvent) => {
        capturedTaskId = (event as AgentTaskRequestEvent).payload.taskId;
        setTimeout(() => {
          simulateAgentCompletion(eventBus, capturedTaskId, {
            title: 'My Note Title',
            tags: ['note', 'personal'],
            summary: 'A personal note.',
          });
        }, 10);
      });

      const { taskId } = await processor.ingest({
        type: 'text',
        content: 'This is my personal note about something important.',
        title: 'My Note Title',
      });

      expect(taskId).toBeDefined();

      // Wait for async completion
      await new Promise((r) => setTimeout(r, 50));

      const bubbles = store.list({ limit: 10, offset: 0 });
      expect(bubbles).toHaveLength(1);
      expect(bubbles[0].title).toBe('My Note Title');
      expect(bubbles[0].source).toBe('manual');
    });

    it('generates title via AI when not provided', async () => {
      eventBus.on('agent:task:request', (event: RavenEvent) => {
        const taskId = (event as AgentTaskRequestEvent).payload.taskId;
        setTimeout(() => {
          simulateAgentCompletion(eventBus, taskId, {
            title: 'AI Generated Title',
            tags: ['auto'],
            summary: 'Summary.',
          });
        }, 10);
      });

      await processor.ingest({
        type: 'text',
        content: 'Some content that needs a title.',
      });

      await new Promise((r) => setTimeout(r, 50));

      const bubbles = store.list({ limit: 10, offset: 0 });
      expect(bubbles).toHaveLength(1);
      expect(bubbles[0].title).toBe('AI Generated Title');
    });
  });

  describe('voice-memo ingestion', () => {
    it('creates bubble with voice-memo source', async () => {
      eventBus.on('agent:task:request', (event: RavenEvent) => {
        const taskId = (event as AgentTaskRequestEvent).payload.taskId;
        setTimeout(() => {
          simulateAgentCompletion(eventBus, taskId, {
            title: 'Voice Memo',
            tags: ['voice', 'memo'],
            summary: 'Voice note.',
          });
        }, 10);
      });

      await processor.ingest({
        type: 'voice-memo',
        content: 'Transcribed voice memo content here.',
      });

      await new Promise((r) => setTimeout(r, 50));

      const bubbles = store.list({ limit: 10, offset: 0 });
      expect(bubbles).toHaveLength(1);
      expect(bubbles[0].source).toBe('voice-memo');
    });
  });

  describe('file ingestion', () => {
    it('ingests text file and stores source reference', async () => {
      const testFile = join(tmpDir, 'notes.txt');
      writeFileSync(testFile, 'File content for ingestion');

      eventBus.on('agent:task:request', (event: RavenEvent) => {
        const payload = (event as AgentTaskRequestEvent).payload;
        expect(payload.prompt).toContain('File content for ingestion');
        setTimeout(() => {
          simulateAgentCompletion(eventBus, payload.taskId, {
            title: 'Notes File',
            tags: ['notes'],
            summary: 'Notes content.',
          });
        }, 10);
      });

      await processor.ingest({
        type: 'file',
        filePath: testFile,
      });

      await new Promise((r) => setTimeout(r, 50));

      const bubbles = store.list({ limit: 10, offset: 0 });
      expect(bubbles).toHaveLength(1);
      expect(bubbles[0].source).toBe('file:txt');
      expect(bubbles[0].sourceFile).toBeTruthy();
    });

    it('emits failed event for unsupported file type', async () => {
      const testFile = join(tmpDir, 'binary.zip');
      writeFileSync(testFile, 'binary data');

      const failedEvents: any[] = [];
      eventBus.on('knowledge:ingest:failed', (event: RavenEvent) => {
        failedEvents.push(event);
      });

      await processor.ingest({
        type: 'file',
        filePath: testFile,
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(failedEvents).toHaveLength(1);
      expect(failedEvents[0].payload.error).toContain('Unsupported file type');
      expect(store.list({ limit: 10, offset: 0 })).toHaveLength(0);
    });
  });

  describe('URL ingestion', () => {
    it('fetches URL content and creates bubble with sourceUrl', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('Web page content', {
          headers: { 'content-type': 'text/plain' },
        }),
      );

      eventBus.on('agent:task:request', (event: RavenEvent) => {
        const payload = (event as AgentTaskRequestEvent).payload;
        setTimeout(() => {
          simulateAgentCompletion(eventBus, payload.taskId, {
            title: 'Web Article',
            tags: ['web'],
            summary: 'Web article summary.',
          });
        }, 10);
      });

      const completeEvents: any[] = [];
      eventBus.on('knowledge:ingest:complete', (event: RavenEvent) => {
        completeEvents.push(event);
      });

      await processor.ingest({
        type: 'url',
        url: 'https://example.com/article',
      });

      await new Promise((r) => setTimeout(r, 50));

      const bubbles = store.list({ limit: 10, offset: 0 });
      expect(bubbles).toHaveLength(1);
      expect(bubbles[0].source).toBe('url');
      expect(completeEvents).toHaveLength(1);
      expect(completeEvents[0].payload.sourceUrl).toBe('https://example.com/article');

      vi.restoreAllMocks();
    });
  });

  describe('agent output parsing', () => {
    it('handles clean JSON output', async () => {
      eventBus.on('agent:task:request', (event: RavenEvent) => {
        const taskId = (event as AgentTaskRequestEvent).payload.taskId;
        setTimeout(() => {
          eventBus.emit({
            id: 'test-done',
            timestamp: Date.now(),
            source: 'test',
            type: 'agent:task:complete',
            payload: {
              taskId,
              result: '{"title": "Clean JSON", "tags": ["test"], "summary": "Clean output."}',
              durationMs: 100,
              success: true,
            },
          } as RavenEvent);
        }, 10);
      });

      await processor.ingest({ type: 'text', content: 'test' });
      await new Promise((r) => setTimeout(r, 50));

      const bubbles = store.list({ limit: 10, offset: 0 });
      expect(bubbles).toHaveLength(1);
      expect(bubbles[0].title).toBe('Clean JSON');
    });

    it('handles JSON in markdown code fences', async () => {
      eventBus.on('agent:task:request', (event: RavenEvent) => {
        const taskId = (event as AgentTaskRequestEvent).payload.taskId;
        setTimeout(() => {
          eventBus.emit({
            id: 'test-done',
            timestamp: Date.now(),
            source: 'test',
            type: 'agent:task:complete',
            payload: {
              taskId,
              result:
                'Here is the result:\n```json\n{"title": "Fenced JSON", "tags": ["fenced"], "summary": "In fences."}\n```',
              durationMs: 100,
              success: true,
            },
          } as RavenEvent);
        }, 10);
      });

      await processor.ingest({ type: 'text', content: 'test' });
      await new Promise((r) => setTimeout(r, 50));

      const bubbles = store.list({ limit: 10, offset: 0 });
      expect(bubbles).toHaveLength(1);
      expect(bubbles[0].title).toBe('Fenced JSON');
    });

    it('handles JSON mixed with explanation text', async () => {
      eventBus.on('agent:task:request', (event: RavenEvent) => {
        const taskId = (event as AgentTaskRequestEvent).payload.taskId;
        setTimeout(() => {
          eventBus.emit({
            id: 'test-done',
            timestamp: Date.now(),
            source: 'test',
            type: 'agent:task:complete',
            payload: {
              taskId,
              result:
                'I analyzed the content. {"title": "Mixed Output", "tags": ["mixed"], "summary": "Mixed with text."} Hope that helps!',
              durationMs: 100,
              success: true,
            },
          } as RavenEvent);
        }, 10);
      });

      await processor.ingest({ type: 'text', content: 'test' });
      await new Promise((r) => setTimeout(r, 50));

      const bubbles = store.list({ limit: 10, offset: 0 });
      expect(bubbles).toHaveLength(1);
      expect(bubbles[0].title).toBe('Mixed Output');
    });
  });

  describe('agent failure handling', () => {
    it('emits failed event when agent task fails', async () => {
      eventBus.on('agent:task:request', (event: RavenEvent) => {
        const taskId = (event as AgentTaskRequestEvent).payload.taskId;
        setTimeout(() => simulateAgentFailure(eventBus, taskId), 10);
      });

      const failedEvents: any[] = [];
      eventBus.on('knowledge:ingest:failed', (event: RavenEvent) => {
        failedEvents.push(event);
      });

      await processor.ingest({ type: 'text', content: 'test' });
      await new Promise((r) => setTimeout(r, 50));

      expect(failedEvents).toHaveLength(1);
      expect(failedEvents[0].payload.error).toContain('Agent failed');
      expect(store.list({ limit: 10, offset: 0 })).toHaveLength(0);
    });
  });

  describe('hint tags', () => {
    it('includes hint tags in the agent prompt', async () => {
      let capturedPrompt = '';
      eventBus.on('agent:task:request', (event: RavenEvent) => {
        const payload = (event as AgentTaskRequestEvent).payload;
        capturedPrompt = payload.prompt;
        setTimeout(() => {
          simulateAgentCompletion(eventBus, payload.taskId, {
            title: 'Tagged',
            tags: ['hint1', 'hint2', 'auto-tag'],
            summary: 'With tags.',
          });
        }, 10);
      });

      await processor.ingest({
        type: 'text',
        content: 'Content with hints',
        tags: ['hint1', 'hint2'],
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(capturedPrompt).toContain('hint1');
      expect(capturedPrompt).toContain('hint2');
    });
  });

  describe('content truncation', () => {
    it('truncates very long content in the prompt', async () => {
      let capturedPrompt = '';
      eventBus.on('agent:task:request', (event: RavenEvent) => {
        const payload = (event as AgentTaskRequestEvent).payload;
        capturedPrompt = payload.prompt;
        setTimeout(() => {
          simulateAgentCompletion(eventBus, payload.taskId, {
            title: 'Long Content',
            tags: ['long'],
            summary: 'Truncated.',
          });
        }, 10);
      });

      const longContent = 'x'.repeat(50_000);
      await processor.ingest({ type: 'text', content: longContent });

      await new Promise((r) => setTimeout(r, 50));

      // Prompt should not contain all 50k characters
      expect(capturedPrompt.length).toBeLessThan(35_000);

      // But the bubble should have the full content
      const bubbles = store.list({ limit: 10, offset: 0 });
      expect(bubbles).toHaveLength(1);
      const full = store.getById(bubbles[0].id);
      expect(full!.content.length).toBe(50_000);
    });
  });

  describe('event-driven ingestion', () => {
    it('processes knowledge:ingest:request events', async () => {
      processor.start();

      eventBus.on('agent:task:request', (event: RavenEvent) => {
        const taskId = (event as AgentTaskRequestEvent).payload.taskId;
        setTimeout(() => {
          simulateAgentCompletion(eventBus, taskId, {
            title: 'Event Driven',
            tags: ['event'],
            summary: 'Via event bus.',
          });
        }, 10);
      });

      eventBus.emit({
        id: 'test-ingest-request',
        timestamp: Date.now(),
        source: 'test',
        type: 'knowledge:ingest:request',
        payload: {
          taskId: 'test-task-id',
          type: 'text',
          content: 'Content via event',
        },
      } as RavenEvent);

      await new Promise((r) => setTimeout(r, 100));

      const bubbles = store.list({ limit: 10, offset: 0 });
      expect(bubbles).toHaveLength(1);
      expect(bubbles[0].title).toBe('Event Driven');
    });
  });

  describe('sourceFile reference stored in bubble', () => {
    it('stores sourceFile in bubble for file ingestion', async () => {
      const testFile = join(tmpDir, 'doc.md');
      writeFileSync(testFile, '# Document content');

      eventBus.on('agent:task:request', (event: RavenEvent) => {
        const taskId = (event as AgentTaskRequestEvent).payload.taskId;
        setTimeout(() => {
          simulateAgentCompletion(eventBus, taskId, {
            title: 'Document',
            tags: ['doc'],
            summary: 'A document.',
          });
        }, 10);
      });

      await processor.ingest({ type: 'file', filePath: testFile });
      await new Promise((r) => setTimeout(r, 50));

      const bubbles = store.list({ limit: 10, offset: 0 });
      expect(bubbles).toHaveLength(1);
      const full = store.getById(bubbles[0].id);
      expect(full!.sourceFile).toBeTruthy();
      expect(full!.sourceFile).toContain('doc.md');
    });

    it('stores sourceUrl in bubble for URL ingestion', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('URL content', { headers: { 'content-type': 'text/plain' } }),
      );

      eventBus.on('agent:task:request', (event: RavenEvent) => {
        const taskId = (event as AgentTaskRequestEvent).payload.taskId;
        setTimeout(() => {
          simulateAgentCompletion(eventBus, taskId, {
            title: 'URL Source',
            tags: ['url'],
            summary: 'From URL.',
          });
        }, 10);
      });

      await processor.ingest({ type: 'url', url: 'https://example.com/page' });
      await new Promise((r) => setTimeout(r, 50));

      const bubbles = store.list({ limit: 10, offset: 0 });
      expect(bubbles).toHaveLength(1);
      const full = store.getById(bubbles[0].id);
      expect(full!.sourceUrl).toBe('https://example.com/page');
      expect(full!.sourceFile).toBeNull();

      vi.restoreAllMocks();
    });
  });
});

// ─── API Route Tests ──────────────────────────────────────────────

describe('Knowledge Ingestion API', () => {
  let tmpDir: string;
  let knowledgeDir: string;
  let mediaDir: string;
  let store: KnowledgeStore;
  let eventBus: EventBus;
  let processor: IngestionProcessor;
  let app: any;

  function mockExecutionLogger(): any {
    return {
      logTaskStart: vi.fn(),
      logTaskEnd: vi.fn(),
      getTaskStatus: vi.fn(),
    };
  }

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'api-ingest-'));
    knowledgeDir = join(tmpDir, 'data', 'knowledge');
    mediaDir = join(tmpDir, 'data', 'media');
    mkdirSync(knowledgeDir, { recursive: true });
    mkdirSync(mediaDir, { recursive: true });
    initDatabase(join(tmpDir, 'test.db'));
    store = createKnowledgeStore({ db: createDbInterface(), knowledgeDir });
    eventBus = new EventBus();
    processor = createIngestionProcessor({
      knowledgeStore: store,
      eventBus,
      executionLogger: mockExecutionLogger(),
      mediaDir,
    });

    const Fastify = (await import('fastify')).default;
    app = Fastify({ logger: false });
    const { registerKnowledgeRoutes } = await import('../api/routes/knowledge.ts');
    registerKnowledgeRoutes(app, {
      eventBus,
      knowledgeStore: store,
      ingestionProcessor: processor,
      executionLogger: mockExecutionLogger(),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    try {
      getDb().close();
    } catch {
      /* */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns 202 with taskId for valid text ingestion', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/knowledge/ingest',
      payload: { type: 'text', content: 'Test content' },
    });
    expect(response.statusCode).toBe(202);
    const body = JSON.parse(response.payload);
    expect(body.taskId).toBeDefined();
  });

  it('returns 202 for valid file path ingestion', async () => {
    const testFile = join(tmpDir, 'test.txt');
    writeFileSync(testFile, 'file content');
    const response = await app.inject({
      method: 'POST',
      url: '/api/knowledge/ingest',
      payload: { type: 'file', filePath: testFile },
    });
    expect(response.statusCode).toBe(202);
  });

  it('returns 202 for valid URL ingestion', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('url content', { headers: { 'content-type': 'text/plain' } }),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/knowledge/ingest',
      payload: { type: 'url', url: 'https://example.com' },
    });
    expect(response.statusCode).toBe(202);
    vi.restoreAllMocks();
  });

  it('returns 400 for missing content on text type', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/knowledge/ingest',
      payload: { type: 'text' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 400 for missing filePath on file type', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/knowledge/ingest',
      payload: { type: 'file' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 400 for missing url on url type', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/knowledge/ingest',
      payload: { type: 'url' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 400 for invalid type', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/knowledge/ingest',
      payload: { type: 'invalid', content: 'test' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 400 for invalid URL format', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/knowledge/ingest',
      payload: { type: 'url', url: 'not-a-url' },
    });
    expect(response.statusCode).toBe(400);
  });
});
