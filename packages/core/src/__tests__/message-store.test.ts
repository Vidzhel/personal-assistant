import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMessageStore, type MessageStore } from '../session-manager/message-store.ts';

describe('MessageStore', () => {
  let tmpDir: string;
  let store: MessageStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-msg-'));
    store = createMessageStore({ basePath: tmpDir });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appendMessage creates dir and JSONL file', () => {
    store.appendMessage('sess-1', { role: 'user', content: 'hello' });
    const msgs = store.getMessages('sess-1');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toBe('hello');
    expect(msgs[0].id).toBeDefined();
    expect(msgs[0].timestamp).toBeGreaterThan(0);
  });

  it('getMessages reads back in correct order', () => {
    store.appendMessage('sess-2', { role: 'user', content: 'msg1' });
    store.appendMessage('sess-2', { role: 'assistant', content: 'msg2' });
    store.appendMessage('sess-2', { role: 'action', content: 'msg3', toolName: 'Read' });
    const msgs = store.getMessages('sess-2');
    expect(msgs).toHaveLength(3);
    expect(msgs[0].content).toBe('msg1');
    expect(msgs[1].content).toBe('msg2');
    expect(msgs[2].content).toBe('msg3');
    expect(msgs[2].toolName).toBe('Read');
  });

  it('pagination with limit and offset', () => {
    for (let i = 0; i < 10; i++) {
      store.appendMessage('sess-3', { role: 'user', content: `msg-${i}` });
    }
    const page1 = store.getMessages('sess-3', { limit: 3, offset: 0 });
    expect(page1).toHaveLength(3);
    expect(page1[0].content).toBe('msg-0');

    const page2 = store.getMessages('sess-3', { limit: 3, offset: 3 });
    expect(page2).toHaveLength(3);
    expect(page2[0].content).toBe('msg-3');

    const lastPage = store.getMessages('sess-3', { limit: 5, offset: 8 });
    expect(lastPage).toHaveLength(2);
  });

  it('empty/missing session returns empty array', () => {
    expect(store.getMessages('nonexistent')).toEqual([]);
  });
});
