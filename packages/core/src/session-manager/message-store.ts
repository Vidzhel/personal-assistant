import { appendFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger, generateId } from '@raven/shared';

const log = createLogger('message-store');

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant' | 'action' | 'thinking' | 'tool-result';
  content: string;
  timestamp: number;
  taskId?: string;
  toolName?: string;
  toolSummary?: string;
  agentName?: string; // e.g. 'ticktick-agent'. absent = orchestrator
}

export interface MessageStoreOptions {
  basePath: string;
}

export interface MessageStore {
  appendMessage: (
    sessionId: string,
    message: Omit<StoredMessage, 'id' | 'timestamp'>,
  ) => string | undefined;
  getMessages: (sessionId: string, opts?: { limit?: number; offset?: number }) => StoredMessage[];
  appendRawMessage: (sessionId: string, rawJson: string) => void;
  getRawMessages: (sessionId: string) => string[];
}

export function createMessageStore(options: MessageStoreOptions): MessageStore {
  const { basePath } = options;

  function getSessionDir(sessionId: string): string {
    const dir = join(basePath, sessionId);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  function getTranscriptPath(sessionId: string): string {
    return join(getSessionDir(sessionId), 'transcript.jsonl');
  }

  function appendMessage(
    sessionId: string,
    message: Omit<StoredMessage, 'id' | 'timestamp'>,
  ): string | undefined {
    const full: StoredMessage = {
      id: generateId(),
      timestamp: Date.now(),
      ...message,
    };
    try {
      appendFileSync(getTranscriptPath(sessionId), JSON.stringify(full) + '\n');
      return full.id;
    } catch (err) {
      log.error(`Failed to append message for session ${sessionId}: ${err}`);
      return undefined;
    }
  }

  function getMessages(
    sessionId: string,
    opts?: { limit?: number; offset?: number },
  ): StoredMessage[] {
    const path = getTranscriptPath(sessionId);
    if (!existsSync(path)) return [];

    try {
      const raw = readFileSync(path, 'utf-8');
      const lines = raw.split('\n').filter((l) => l.trim());
      const messages: StoredMessage[] = [];
      for (const line of lines) {
        try {
          messages.push(JSON.parse(line) as StoredMessage);
        } catch {
          // skip malformed lines
        }
      }

      const offset = opts?.offset ?? 0;
      const limit = opts?.limit ?? messages.length;
      return messages.slice(offset, offset + limit);
    } catch (err) {
      log.error(`Failed to read messages for session ${sessionId}: ${err}`);
      return [];
    }
  }

  function getRawOutputPath(sessionId: string): string {
    return join(getSessionDir(sessionId), 'raw-output.jsonl');
  }

  function appendRawMessage(sessionId: string, rawJson: string): void {
    try {
      appendFileSync(getRawOutputPath(sessionId), rawJson + '\n');
    } catch (err) {
      log.error(`Failed to append raw message for session ${sessionId}: ${err}`);
    }
  }

  function getRawMessages(sessionId: string): string[] {
    const path = getRawOutputPath(sessionId);
    if (!existsSync(path)) return [];

    try {
      const raw = readFileSync(path, 'utf-8');
      return raw.split('\n').filter((l) => l.trim());
    } catch (err) {
      log.error(`Failed to read raw messages for session ${sessionId}: ${err}`);
      return [];
    }
  }

  return { appendMessage, getMessages, appendRawMessage, getRawMessages };
}
