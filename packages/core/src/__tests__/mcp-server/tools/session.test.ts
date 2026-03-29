import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildSessionTools } from '../../../mcp-server/tools/session.ts';
import type { RavenMcpDeps } from '../../../mcp-server/types.ts';
import type { ScopeContext } from '../../../mcp-server/scope.ts';
import type { StoredMessage } from '../../../session-manager/message-store.ts';

function makeMessage(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: 'msg-1',
    role: 'assistant',
    content: 'hello',
    timestamp: 1000,
    ...overrides,
  };
}

describe('buildSessionTools', () => {
  let deps: RavenMcpDeps;
  let scope: ScopeContext;

  beforeEach(() => {
    deps = {
      eventBus: { emit: vi.fn() } as any,
      messageStore: {
        appendMessage: vi.fn().mockReturnValue('msg-id-123'),
        getMessages: vi.fn().mockReturnValue([]),
        appendRawMessage: vi.fn(),
        getRawMessages: vi.fn().mockReturnValue([]),
        archiveTranscript: vi.fn(),
        replaceTranscript: vi.fn(),
      },
    } as any;
    scope = { role: 'chat', sessionId: 'sess-abc' };
  });

  describe('send_message', () => {
    it('appends to store and emits event', async () => {
      const tools = buildSessionTools(deps, scope);
      const tool = tools.find((t) => t.name === 'send_message');
      expect(tool).toBeDefined();

      const result = await tool!.handler({ content: 'Hello world' }, {});

      expect(deps.messageStore!.appendMessage).toHaveBeenCalledWith('sess-abc', {
        role: 'assistant',
        content: 'Hello world',
      });
      expect(deps.eventBus.emit).toHaveBeenCalledOnce();
      const emittedEvent = (deps.eventBus.emit as any).mock.calls[0][0];
      expect(emittedEvent.type).toBe('agent:message');
      expect(emittedEvent.payload.content).toBe('Hello world');
      expect(emittedEvent.payload.sessionId).toBe('sess-abc');

      expect(result.isError).toBeFalsy();
      const text = JSON.parse(result.content[0].text);
      expect(text.messageId).toBe('msg-id-123');
    });

    it('returns error when no sessionId', async () => {
      const noSessionScope: ScopeContext = { role: 'task' };
      const tools = buildSessionTools(deps, noSessionScope);
      const tool = tools.find((t) => t.name === 'send_message');

      const result = await tool!.handler({ content: 'Hello' }, {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('sessionId');
      expect(deps.messageStore!.appendMessage).not.toHaveBeenCalled();
    });
  });

  describe('get_session_history', () => {
    it('returns messages from store', async () => {
      const messages: StoredMessage[] = [
        makeMessage({
          id: 'msg-1',
          role: 'user',
          content: 'hi',
          timestamp: 1000,
          agentName: undefined,
        }),
        makeMessage({
          id: 'msg-2',
          role: 'assistant',
          content: 'hello',
          timestamp: 2000,
          agentName: 'chat-agent',
        }),
      ];
      (deps.messageStore!.getMessages as any).mockReturnValue(messages);

      const tools = buildSessionTools(deps, scope);
      const tool = tools.find((t) => t.name === 'get_session_history');
      expect(tool).toBeDefined();

      const result = await tool!.handler({ limit: 20 }, {});

      expect(deps.messageStore!.getMessages).toHaveBeenCalledWith('sess-abc');
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.messages).toHaveLength(2);
      expect(parsed.messages[0].id).toBe('msg-1');
      expect(parsed.messages[1].agentName).toBe('chat-agent');
    });

    it('slices results to limit', async () => {
      const messages: StoredMessage[] = Array.from({ length: 30 }, (_, i) =>
        makeMessage({ id: `msg-${i}`, content: `msg ${i}`, timestamp: i }),
      );
      (deps.messageStore!.getMessages as any).mockReturnValue(messages);

      const tools = buildSessionTools(deps, scope);
      const tool = tools.find((t) => t.name === 'get_session_history');

      const result = await tool!.handler({ limit: 5 }, {});

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.messages).toHaveLength(5);
    });

    it('returns error when no sessionId', async () => {
      const noSessionScope: ScopeContext = { role: 'task' };
      const tools = buildSessionTools(deps, noSessionScope);
      const tool = tools.find((t) => t.name === 'get_session_history');

      const result = await tool!.handler({}, {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('sessionId');
    });

    it('has readOnlyHint and idempotentHint annotations', () => {
      const tools = buildSessionTools(deps, scope);
      const tool = tools.find((t) => t.name === 'get_session_history');
      expect(tool?.annotations?.readOnlyHint).toBe(true);
      expect(tool?.annotations?.idempotentHint).toBe(true);
    });
  });
});
