import { createHash } from 'node:crypto';
import { createLogger, generateId } from '@raven/shared';
import type {
  SessionRetrospectiveResult,
  CandidateBubble,
  SessionRetrospectiveCompleteEvent,
  NotificationEvent,
} from '@raven/shared';
import type { MessageStore, StoredMessage } from './message-store.ts';
import type { SessionManager } from './session-manager.ts';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { AppConfig } from '../config.ts';
import type { KnowledgeStore } from '../knowledge-engine/knowledge-store.ts';
import type { Neo4jClient } from '../knowledge-engine/neo4j-client.ts';
import { linkBubbleToProject } from '../knowledge-engine/project-knowledge.ts';
import { getProjectKnowledgeLinks } from '../knowledge-engine/project-knowledge.ts';
import { isContentRejected } from '../knowledge-engine/knowledge-rejections.ts';
import { runAgentTask } from '../agent-manager/agent-session.ts';

const log = createLogger('session-retrospective');

const CONTENT_HASH_LENGTH = 16;
const NOTIFICATION_PREVIEW_LENGTH = 200;

interface SessionRetrospectiveDeps {
  messageStore: MessageStore;
  sessionManager: SessionManager;
  eventBus: EventBus;
  config: AppConfig;
  knowledgeStore: KnowledgeStore;
  neo4j: Neo4jClient;
}

export interface SessionRetrospective {
  runRetrospective: (sessionId: string, projectId: string) => Promise<SessionRetrospectiveResult>;
}

function formatTranscript(messages: StoredMessage[]): string {
  return messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `**${m.role}:** ${m.content}`)
    .join('\n\n');
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, CONTENT_HASH_LENGTH);
}

const RETROSPECTIVE_SYSTEM_PROMPT = `You are a session retrospective agent. Analyze the conversation transcript below and produce a JSON response matching this schema:
{
  "summary": "2-3 paragraph session summary",
  "decisions": ["decision 1", "decision 2"],
  "findings": ["finding 1", "finding 2"],
  "actionItems": ["action 1", "action 2"],
  "candidateBubbles": [
    { "title": "...", "content": "...", "tags": ["..."], "confidence": "high|low", "sourceDescription": "..." }
  ]
}

Guidelines:
- Summary: Concise overview of what was discussed and accomplished (2-3 paragraphs max)
- Decisions: Explicit choices or commitments made during the session
- Findings: Technical discoveries, learned facts, or observations
- Action items: Tasks or follow-ups identified but not completed
- Candidate bubbles: Reusable knowledge nuggets. Use "high" confidence for clear factual findings and explicit decisions. Use "low" confidence for subjective interpretations or tentative conclusions.
- Compare against the existing project knowledge (provided below) to avoid duplicates — do NOT propose bubbles that repeat existing knowledge.

Only output valid JSON. No markdown code fences, no explanation.`;

// eslint-disable-next-line max-lines-per-function -- orchestrates retrospective flow: transcript loading, agent spawning, result parsing, bubble processing
export function createSessionRetrospective(deps: SessionRetrospectiveDeps): SessionRetrospective {
  const { messageStore, sessionManager, eventBus, knowledgeStore, neo4j } = deps;

  async function buildPrompt(sessionId: string, projectId: string): Promise<string> {
    const messages = messageStore.getMessages(sessionId);
    const transcript = formatTranscript(messages);

    // Get existing project knowledge for dedup context
    let knowledgeContext = '';
    try {
      const links = await getProjectKnowledgeLinks(neo4j, projectId);
      if (links.length > 0) {
        const entries = links
          .map((l) => `- ${l.title} [tags: ${(l.tags ?? []).join(', ')}]`)
          .join('\n');
        knowledgeContext = `\n\nExisting project knowledge (do NOT duplicate):\n${entries}`;
      }
    } catch (err) {
      log.warn(`Failed to load project knowledge for dedup: ${err}`);
    }

    return `${RETROSPECTIVE_SYSTEM_PROMPT}${knowledgeContext}\n\n---\n\nSession Transcript:\n\n${transcript}`;
  }

  // eslint-disable-next-line max-lines-per-function -- processes high/low confidence bubbles with knowledge store + notification
  async function processCandidateBubbles(
    projectId: string,
    bubbles: CandidateBubble[],
    sessionId: string,
  ): Promise<{ created: number; drafted: number }> {
    let created = 0;
    let drafted = 0;

    for (const bubble of bubbles) {
      const hash = contentHash(bubble.content);
      if (isContentRejected(projectId, hash)) {
        log.info(`Skipping rejected content: ${bubble.title}`);
        continue;
      }

      if (bubble.confidence === 'high') {
        try {
          const newBubble = await knowledgeStore.insert({
            title: bubble.title,
            content: bubble.content,
            tags: bubble.tags,
            source: `auto-retrospective:${sessionId}`,
          });
          await linkBubbleToProject({
            neo4j,
            projectId,
            bubbleId: newBubble.id,
            linkedBy: 'auto-retrospective',
          });
          created++;
        } catch (err) {
          log.error(`Failed to create bubble "${bubble.title}": ${err}`);
        }
      } else {
        // Low-confidence: create as draft and notify
        try {
          const newBubble = await knowledgeStore.insert({
            title: `[Draft] ${bubble.title}`,
            content: bubble.content,
            tags: [...bubble.tags, 'draft'],
            source: `auto-retrospective:${sessionId}`,
          });
          await linkBubbleToProject({
            neo4j,
            projectId,
            bubbleId: newBubble.id,
            linkedBy: 'auto-retrospective',
          });

          const notification: NotificationEvent = {
            id: generateId(),
            timestamp: Date.now(),
            source: 'session-retrospective',
            type: 'notification',
            payload: {
              channel: 'telegram',
              title: 'Knowledge Draft for Review',
              body: `${bubble.title}\n${bubble.content.slice(0, NOTIFICATION_PREVIEW_LENGTH)}...`,
              topicName: 'system',
            },
          };
          eventBus.emit(notification);
          drafted++;
        } catch (err) {
          log.error(`Failed to create draft bubble "${bubble.title}": ${err}`);
        }
      }
    }

    return { created, drafted };
  }

  // eslint-disable-next-line max-lines-per-function -- orchestrates full retrospective: prompt, agent, parse, store, emit
  async function runRetrospective(
    sessionId: string,
    projectId: string,
  ): Promise<SessionRetrospectiveResult> {
    log.info(`Running retrospective for session ${sessionId}`);

    const prompt = await buildPrompt(sessionId, projectId);

    const task = {
      id: generateId(),
      skillName: 'session-retrospective',
      prompt,
      status: 'queued' as const,
      priority: 'low' as const,
      mcpServers: {},
      agentDefinitions: {},
      createdAt: Date.now(),
    };

    const agentResult = await runAgentTask({
      task,
      eventBus,
      mcpServers: {},
      agentDefinitions: {},
    });

    let parsed: SessionRetrospectiveResult;
    try {
      const raw = JSON.parse(agentResult.result) as Omit<
        SessionRetrospectiveResult,
        'sessionId' | 'projectId'
      >;
      parsed = {
        sessionId,
        projectId,
        summary: raw.summary ?? '',
        decisions: raw.decisions ?? [],
        findings: raw.findings ?? [],
        actionItems: raw.actionItems ?? [],
        candidateBubbles: raw.candidateBubbles ?? [],
        bubblesCreated: 0,
        bubblesDrafted: 0,
      };
    } catch (err) {
      log.error(`Failed to parse retrospective result: ${err}`);
      parsed = {
        sessionId,
        projectId,
        summary: agentResult.result,
        decisions: [],
        findings: [],
        actionItems: [],
        candidateBubbles: [],
        bubblesCreated: 0,
        bubblesDrafted: 0,
      };
    }

    // Store summary
    sessionManager.updateSummary(sessionId, parsed.summary);

    // Process knowledge bubbles
    const { created, drafted } = await processCandidateBubbles(
      projectId,
      parsed.candidateBubbles,
      sessionId,
    );

    // Set actual counts on the result
    parsed.bubblesCreated = created;
    parsed.bubblesDrafted = drafted;

    // Emit completion event
    const completeEvent: SessionRetrospectiveCompleteEvent = {
      id: generateId(),
      timestamp: Date.now(),
      source: 'session-retrospective',
      projectId,
      type: 'session:retrospective:complete',
      payload: {
        sessionId,
        projectId,
        summary: parsed.summary,
        bubblesCreated: created,
        bubblesDrafted: drafted,
      },
    };
    eventBus.emit(completeEvent);

    log.info(
      `Retrospective complete: session=${sessionId}, bubbles created=${created}, drafted=${drafted}`,
    );

    return parsed;
  }

  return { runRetrospective };
}
