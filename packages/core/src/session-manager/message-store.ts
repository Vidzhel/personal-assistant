import { appendFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger, generateId } from '@raven/shared';

const log = createLogger('message-store');

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant' | 'action' | 'thinking';
  content: string;
  timestamp: number;
  taskId?: string;
  toolName?: string;
  toolSummary?: string;
}

export interface MessageStoreOptions {
  basePath: string;
}

export interface MessageStore {
  appendMessage: (sessionId: string, message: Omit<StoredMessage, 'id' | 'timestamp'>) => void;
  getMessages: (sessionId: string, opts?: { limit?: number; offset?: number }) => StoredMessage[];
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
  ): void {
    const full: StoredMessage = {
      id: generateId(),
      timestamp: Date.now(),
      ...message,
    };
    try {
      appendFileSync(getTranscriptPath(sessionId), JSON.stringify(full) + '\n');
    } catch (err) {
      log.error(`Failed to append message for session ${sessionId}: ${err}`);
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

  return { appendMessage, getMessages };
}
