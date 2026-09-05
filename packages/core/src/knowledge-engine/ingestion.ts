import { waitForAgentTask } from './task-completion.ts';
import { createProcessorLifecycle } from './processor-lifecycle.ts';
import { extname } from 'node:path';
import {
  generateId,
  createLogger,
  type IngestKnowledge,
  type RavenEvent,
  type KnowledgeIngestRequestEvent,
} from '@raven/shared';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { KnowledgeStore } from './knowledge-store.ts';
import { extractFromFile, extractFromUrl, copyToMediaDir } from './content-extractor.ts';

const log = createLogger('ingestion');

const MAX_CONTENT_FOR_PROMPT = 30_000;
const INGESTION_TIMEOUT_MS = 120_000;

export interface IngestionDeps {
  knowledgeStore: KnowledgeStore;
  eventBus: EventBus;
  mediaDir: string;
}

export interface IngestionResult {
  taskId: string;
  bubbleId: string;
  title: string;
  filePath: string;
  sourceFilePath?: string;
  sourceUrl?: string;
}

export interface IngestionOptions {
  taskId?: string;
}

export interface IngestionProcessor {
  ingest: (input: IngestKnowledge, options?: IngestionOptions) => Promise<IngestionResult>;
  start: () => void;
  stop: () => Promise<void>;
}

function deriveSource(input: IngestKnowledge): string {
  if (input.source) return input.source;
  switch (input.type) {
    case 'text':
      return 'manual';
    case 'voice-memo':
      return 'voice-memo';
    case 'url':
      return 'url';
    case 'file': {
      const ext = extname(input.filePath ?? '')
        .toLowerCase()
        .replace('.', '');
      return `file:${ext || 'unknown'}`;
    }
  }
}

function buildIngestionPrompt(params: {
  content: string;
  title?: string;
  tags?: string[];
  source: string;
  sourceFile?: string;
  sourceUrl?: string;
}): string {
  const { content, title, tags, source, sourceFile, sourceUrl } = params;
  const titleInstruction = title
    ? `Use exactly this title: "${title}"`
    : 'Generate a clear title from the content.';
  const tagInstruction = tags?.length
    ? `Include these hint tags: ${JSON.stringify(tags)}. Add more relevant ones.`
    : 'Generate from content themes.';
  const sourceInfo = [
    source,
    sourceFile ? `(file: ${sourceFile})` : '',
    sourceUrl ? `(url: ${sourceUrl})` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const truncated = content.slice(0, MAX_CONTENT_FOR_PROMPT);

  return [
    'You are a knowledge ingestion agent for a personal knowledge management system. Analyze the following content and return a JSON object.',
    '',
    'Requirements:',
    `1. "title": A concise, descriptive title (max 100 chars). ${titleInstruction}`,
    `2. "tags": An array of 3-8 relevant tags (lowercase, single words or short hyphenated phrases). ${tagInstruction}`,
    '3. "summary": A 1-3 sentence summary of the key information.',
    '',
    `Source: ${sourceInfo}`,
    '',
    'Content to analyze:',
    '---',
    truncated,
    '---',
    '',
    'Return ONLY a valid JSON object, no markdown fencing, no explanation. Example:',
    '{"title": "SQLite Backup Strategies", "tags": ["database", "sqlite", "backup", "ops"], "summary": "Overview of backup approaches for SQLite databases including WAL mode considerations."}',
  ].join('\n');
}

interface ParsedIngestionResult {
  title: string;
  tags: string[];
  summary: string;
}

function parseIngestionResult(agentOutput: string): ParsedIngestionResult {
  const trimmed = agentOutput.trim();

  // Try direct parse
  try {
    return validateParsed(JSON.parse(trimmed));
  } catch {
    // continue
  }

  // Try extracting from markdown code fences
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(trimmed);
  if (fenceMatch?.[1]) {
    try {
      return validateParsed(JSON.parse(fenceMatch[1]));
    } catch {
      // continue
    }
  }

  // Try finding first { to last }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return validateParsed(JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)));
  }

  throw new Error('Failed to parse agent output as JSON');
}

function validateParsed(data: unknown): ParsedIngestionResult {
  const obj = data as Record<string, unknown>;
  if (typeof obj.title !== 'string') throw new Error('Missing or invalid title in agent output');
  if (!Array.isArray(obj.tags)) throw new Error('Missing or invalid tags in agent output');
  return {
    title: obj.title.trim(),
    tags: obj.tags.map((t: unknown) => String(t).toLowerCase().trim()),
    summary: typeof obj.summary === 'string' ? obj.summary.trim() : '',
  };
}

interface ExtractedContent {
  content: string;
  sourceFile: string | null;
  sourceUrl: string | null;
}

interface IngestionRunDeps {
  input: IngestKnowledge;
  taskId: string;
  mediaDir: string;
  signal: AbortSignal;
  assertActive: () => void;
  emit: (event: RavenEvent) => void;
  eventBus: EventBus;
  knowledgeStore: KnowledgeStore;
}

function dispatchIngestionTask(params: {
  emit: (event: RavenEvent) => void;
  taskId: string;
  prompt: string;
}): void {
  params.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: 'ingestion',
    type: 'agent:task:request',
    payload: {
      taskId: params.taskId,
      prompt: params.prompt,
      skillName: 'knowledge-ingestion',
      mcpServers: {},
      priority: 'normal',
    },
  } as RavenEvent);
}

function buildIngestionResult(params: {
  taskId: string;
  bubble: Awaited<ReturnType<KnowledgeStore['insert']>>;
  extracted: ExtractedContent;
}): IngestionResult {
  const { taskId, bubble, extracted } = params;
  return {
    taskId,
    bubbleId: bubble.id,
    title: bubble.title,
    filePath: bubble.filePath,
    ...(extracted.sourceFile ? { sourceFilePath: extracted.sourceFile } : {}),
    ...(extracted.sourceUrl ? { sourceUrl: extracted.sourceUrl } : {}),
  };
}

async function executeIngestion(params: IngestionRunDeps): Promise<IngestionResult> {
  const { input, taskId, mediaDir, signal, assertActive, emit, eventBus, knowledgeStore } = params;
  const source = deriveSource(input);
  const extracted = await extractContent(input, mediaDir, signal);
  assertActive();
  const prompt = buildIngestionPrompt({
    content: extracted.content,
    title: input.title,
    tags: input.tags,
    source,
    sourceFile: extracted.sourceFile ?? undefined,
    sourceUrl: extracted.sourceUrl ?? undefined,
  });
  const completion = await waitForAgentTask({
    eventBus,
    taskId,
    timeoutMs: INGESTION_TIMEOUT_MS,
    signal,
    dispatch: () => dispatchIngestionTask({ emit, taskId, prompt }),
  });
  assertActive();
  if (completion.error) throw new Error(completion.error);
  const parsed = parseIngestionResult(completion.result ?? '');
  const bubble = await knowledgeStore.insert(
    {
      title: parsed.title,
      content: extracted.content,
      source,
      tags: parsed.tags,
      sourceFile: extracted.sourceFile,
      sourceUrl: extracted.sourceUrl,
      permanence: input.type === 'voice-memo' ? 'temporary' : undefined,
    },
    { signal },
  );
  assertActive();
  return buildIngestionResult({ taskId, bubble, extracted });
}

// Zod refine guarantees: text/voice-memo have content, file has filePath, url has url
function extractContent(
  input: IngestKnowledge,
  mediaDir: string,
  signal: AbortSignal,
): Promise<ExtractedContent> {
  const textContent = input.content ?? '';
  const filePath = input.filePath ?? '';
  const urlValue = input.url ?? '';

  switch (input.type) {
    case 'text':
    case 'voice-memo':
      return Promise.resolve({ content: textContent, sourceFile: null, sourceUrl: null });
    case 'file': {
      const sourceFile = copyToMediaDir({ sourcePath: filePath, mediaDir });
      return extractFromFile(filePath).then((content) => ({
        content,
        sourceFile,
        sourceUrl: null,
      }));
    }
    case 'url':
      return extractFromUrl(urlValue, signal).then((content) => ({
        content,
        sourceFile: null,
        sourceUrl: urlValue,
      }));
  }
}

// eslint-disable-next-line max-lines-per-function -- factory function for ingestion processor
export function createIngestionProcessor(deps: IngestionDeps): IngestionProcessor {
  const { eventBus, mediaDir } = deps;
  const lifetime = createProcessorLifecycle(eventBus, 'ingestion');
  const knowledgeStore = lifetime.guard(deps.knowledgeStore);
  const activeTaskIds = new Set<string>();
  let started = false;

  async function ingest(
    input: IngestKnowledge,
    options?: IngestionOptions,
  ): Promise<IngestionResult> {
    const taskId = options?.taskId ?? generateId();
    if (activeTaskIds.has(taskId)) {
      throw new Error(`Knowledge ingestion task is already active: ${taskId}`);
    }
    activeTaskIds.add(taskId);
    try {
      log.info(`Starting ingestion: type=${input.type}, taskId=${taskId}`);
      const result = await executeIngestion({
        input,
        taskId,
        mediaDir,
        signal: lifetime.signal,
        assertActive: lifetime.assertActive,
        emit: lifetime.emit,
        eventBus,
        knowledgeStore,
      });
      emitCompleteEvent(result);
      log.info(`Ingestion complete: ${result.bubbleId} (${result.title})`);
      return result;
    } catch (err) {
      if (!lifetime.signal.aborted) {
        const msg = err instanceof Error ? err.message : String(err);
        emitFailedEvent({ taskId, error: msg, type: input.type });
        log.error(`Ingestion failed for task ${taskId}: ${msg}`);
      }
      throw err;
    } finally {
      activeTaskIds.delete(taskId);
    }
  }

  function emitFailedEvent(params: {
    taskId: string;
    error: string;
    type: 'text' | 'file' | 'voice-memo' | 'url';
  }): void {
    lifetime.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'ingestion',
      type: 'knowledge:ingest:failed',
      payload: params,
    } as RavenEvent);
  }

  function emitCompleteEvent(params: {
    taskId: string;
    bubbleId: string;
    title: string;
    filePath: string;
    sourceFilePath?: string;
    sourceUrl?: string;
  }): void {
    lifetime.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'ingestion',
      type: 'knowledge:ingest:complete',
      payload: params,
    } as RavenEvent);
  }

  function start(): void {
    lifetime.assertActive();
    if (started) return;
    started = true;
    lifetime.listen('knowledge:ingest:request', async (event: RavenEvent) => {
      const payload = (event as KnowledgeIngestRequestEvent).payload;
      await ingest(
        {
          type: payload.type,
          content: payload.content,
          filePath: payload.filePath,
          url: payload.url,
          title: payload.title,
          source: payload.source,
          tags: payload.tags,
        },
        { taskId: payload.taskId },
      );
    });
    log.info('Ingestion processor started — listening for knowledge:ingest:request events');
  }

  return {
    ingest: (input, options) => lifetime.run(() => ingest(input, options)),
    start,
    stop: lifetime.stop,
  };
}
