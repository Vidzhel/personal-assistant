import { createLogger, generateId } from '@raven/shared';
import type { SessionCompactedEvent } from '@raven/shared';
import type { MessageStore, StoredMessage } from './message-store.ts';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { AppConfig } from '../config.ts';
import { runAgentTask } from '../agent-manager/agent-session.ts';

const log = createLogger('session-compaction');

const KEEP_RECENT = 10;

interface SessionCompactionDeps {
  messageStore: MessageStore;
  eventBus: EventBus;
  config: AppConfig;
}

export interface SessionCompaction {
  checkAndCompact: (sessionId: string) => Promise<boolean>;
}

const COMPACTION_PROMPT = `You are a session compaction agent. Summarize the following conversation messages into a concise context block that preserves:
- Key decisions and their reasoning
- Important facts and discoveries
- Current state of any work in progress
- Any pending action items or unresolved questions

Be concise but thorough. Write in third person. Do not include tool usage details — focus on the substance of the conversation.

Only output the summary text. No markdown headers, no JSON, no explanation.`;

// eslint-disable-next-line max-lines-per-function -- handles compaction flow: message loading, agent summarization, archive+rewrite
export function createSessionCompaction(deps: SessionCompactionDeps): SessionCompaction {
  const { messageStore, eventBus, config } = deps;

  // eslint-disable-next-line max-lines-per-function -- compaction flow: load, split, summarize, archive, rewrite
  async function checkAndCompact(sessionId: string): Promise<boolean> {
    const messages = messageStore.getMessages(sessionId);
    if (messages.length <= config.RAVEN_SESSION_COMPACTION_THRESHOLD) {
      return false;
    }

    log.info(
      `Compacting session ${sessionId}: ${messages.length} messages (threshold: ${config.RAVEN_SESSION_COMPACTION_THRESHOLD})`,
    );

    const splitIndex = messages.length - KEEP_RECENT;
    const oldMessages = messages.slice(0, splitIndex);
    const recentMessages = messages.slice(splitIndex);

    // Format old messages for summarization
    const oldText = oldMessages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => `${m.role}: ${m.content}`)
      .join('\n\n');

    // Spawn lightweight agent to summarize
    const task = {
      id: generateId(),
      skillName: 'session-compaction',
      prompt: `${COMPACTION_PROMPT}\n\n---\n\n${oldText}`,
      status: 'queued' as const,
      priority: 'low' as const,
      mcpServers: {},
      agentDefinitions: {},
      createdAt: Date.now(),
    };

    const result = await runAgentTask({
      task,
      eventBus,
      mcpServers: {},
      agentDefinitions: {},
    });

    const summary = result.result;

    // Create compaction block as a context message
    const compactionMessage: StoredMessage = {
      id: generateId(),
      role: 'context',
      content: `[Compacted Context — ${oldMessages.length} messages summarized]\n\n${summary}`,
      timestamp: Date.now(),
    };

    // Archive original transcript and write compacted version
    messageStore.archiveTranscript(sessionId);
    messageStore.replaceTranscript(sessionId, [compactionMessage, ...recentMessages]);

    // Emit event
    const event: SessionCompactedEvent = {
      id: generateId(),
      timestamp: Date.now(),
      source: 'session-compaction',
      type: 'session:compacted',
      payload: {
        sessionId,
        messagesCompacted: oldMessages.length,
        summaryLength: summary.length,
      },
    };
    eventBus.emit(event);

    log.info(
      `Compacted session ${sessionId}: ${oldMessages.length} messages → ${summary.length} char summary`,
    );

    return true;
  }

  return { checkAndCompact };
}
