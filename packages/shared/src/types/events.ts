import { z } from 'zod';
import type { PermissionTier } from './permissions.ts';
import { PermissionTierSchema } from './permissions.ts';

export interface BaseEvent {
  id: string;
  timestamp: number;
  source: string;
  projectId?: string;
}

export interface NewEmailEvent extends BaseEvent {
  type: 'email:new';
  payload: {
    from: string;
    subject: string;
    snippet: string;
    messageId: string;
    receivedAt: number;
  };
}

export const NewEmailPayloadSchema = z.object({
  from: z.string(),
  subject: z.string(),
  snippet: z.string(),
  messageId: z.string(),
  receivedAt: z.number(),
});

export interface ScheduleTriggeredEvent extends BaseEvent {
  type: 'schedule:triggered';
  payload: {
    scheduleId: string;
    scheduleName: string;
    taskType: string;
  };
}

export interface AgentTaskRequestEvent extends BaseEvent {
  type: 'agent:task:request';
  payload: {
    taskId: string;
    prompt: string;
    skillName: string;
    actionName?: string;
    pipelineName?: string;
    mcpServers: Record<string, McpServerConfig>;
    agentDefinitions?: Record<string, SubAgentDefinition>;
    knowledgeContext?: string;
    priority: Priority;
    sessionId?: string;
    projectId?: string;
  };
}

export interface AgentTaskCompleteEvent extends BaseEvent {
  type: 'agent:task:complete';
  payload: {
    taskId: string;
    sessionId?: string;
    result: string;
    durationMs: number;
    success: boolean;
    errors?: string[];
  };
}

export interface AgentMessageEvent extends BaseEvent {
  type: 'agent:message';
  payload: {
    taskId: string;
    sessionId?: string;
    messageType: 'assistant' | 'tool_use' | 'thinking' | 'result';
    content: string;
    messageId?: string;
    agentName?: string;
  };
}

export interface UserChatMessageEvent extends BaseEvent {
  type: 'user:chat:message';
  payload: {
    projectId: string;
    sessionId?: string;
    message: string;
    topicId?: number;
    topicName?: string;
    mediaAttachment?: {
      type: 'photo' | 'document';
      filePath: string;
      mimeType: string;
      fileName: string;
    };
  };
}

export type DeliveryMode = 'tell-now' | 'tell-when-active' | 'save-for-later';

export type UrgencyTier = 'red' | 'yellow' | 'green';

export interface NotificationEvent extends BaseEvent {
  type: 'notification';
  payload: {
    channel: 'telegram' | 'web' | 'all';
    title: string;
    body: string;
    topicName?: string;
    actions?: Array<{ label: string; action: string; data?: unknown }>;
    urgencyTier?: UrgencyTier;
    deliveryMode?: DeliveryMode;
  };
}

export interface NotificationDeliverEvent extends BaseEvent {
  type: 'notification:deliver';
  payload: {
    channel: 'telegram' | 'web' | 'all';
    title: string;
    body: string;
    topicName?: string;
    actions?: Array<{ label: string; action: string; data?: unknown }>;
    urgencyTier?: UrgencyTier;
    deliveryMode?: DeliveryMode;
    queueId?: string;
  };
}

export interface NotificationQueuedEvent extends BaseEvent {
  type: 'notification:queued';
  payload: {
    queueId: string;
    urgencyTier: UrgencyTier;
    deliveryMode: DeliveryMode;
    scheduledFor?: string;
  };
}

export interface NotificationBatchedEvent extends BaseEvent {
  type: 'notification:batched';
  payload: {
    queueId: string;
    urgencyTier: UrgencyTier;
  };
}

export interface SkillDataEvent extends BaseEvent {
  type: 'skill:data';
  payload: {
    skillName: string;
    dataType: string;
    data: unknown;
  };
}

export interface ConfigReloadedEvent extends BaseEvent {
  type: 'config:reloaded';
  payload: {
    configType: string;
    timestamp: string;
  };
}

export const ConfigReloadedPayloadSchema = z.object({
  configType: z.string(),
  timestamp: z.string(),
});

export interface PermissionApprovedEvent extends BaseEvent {
  type: 'permission:approved';
  payload: {
    actionName: string;
    skillName: string;
    tier: PermissionTier;
    sessionId?: string;
  };
}

export interface PermissionBlockedEvent extends BaseEvent {
  type: 'permission:blocked';
  payload: {
    actionName: string;
    skillName: string;
    tier: PermissionTier;
    approvalId: string;
    sessionId?: string;
  };
}

export const PermissionApprovedPayloadSchema = z.object({
  actionName: z.string(),
  skillName: z.string(),
  tier: PermissionTierSchema,
  sessionId: z.string().optional(),
});

export const PermissionBlockedPayloadSchema = z.object({
  actionName: z.string(),
  skillName: z.string(),
  tier: PermissionTierSchema,
  approvalId: z.string(),
  sessionId: z.string().optional(),
});

export interface PermissionDeniedEvent extends BaseEvent {
  type: 'permission:denied';
  payload: {
    actionName: string;
    skillName: string;
    tier: PermissionTier;
    approvalId: string;
    sessionId?: string;
  };
}

export const PermissionDeniedPayloadSchema = z.object({
  actionName: z.string(),
  skillName: z.string(),
  tier: PermissionTierSchema,
  approvalId: z.string(),
  sessionId: z.string().optional(),
});

export interface ConfigPipelinesReloadedEvent extends BaseEvent {
  type: 'config:pipelines:reloaded';
  payload: {
    pipelineName: string;
    action: 'loaded' | 'reloaded' | 'removed';
    timestamp: string;
  };
}

export interface PipelineStartedEvent extends BaseEvent {
  type: 'pipeline:started';
  payload: {
    runId: string;
    pipelineName: string;
    triggerType: string;
    timestamp: string;
  };
}

export interface PipelineStepCompleteEvent extends BaseEvent {
  type: 'pipeline:step:complete';
  payload: {
    runId: string;
    pipelineName: string;
    nodeId: string;
    output: unknown;
    durationMs: number;
    timestamp: string;
    attempt?: number;
    maxAttempts?: number;
  };
}

export interface PipelineStepFailedEvent extends BaseEvent {
  type: 'pipeline:step:failed';
  payload: {
    runId: string;
    pipelineName: string;
    nodeId: string;
    error: string;
    durationMs: number;
    timestamp: string;
    attempt?: number;
    maxAttempts?: number;
  };
}

export interface PipelineStepRetryEvent extends BaseEvent {
  type: 'pipeline:step:retry';
  payload: {
    runId: string;
    pipelineName: string;
    nodeId: string;
    attempt: number;
    maxAttempts: number;
    backoffMs: number;
    timestamp: string;
  };
}

export interface PipelineCompleteEvent extends BaseEvent {
  type: 'pipeline:complete';
  payload: {
    runId: string;
    pipelineName: string;
    status: 'completed';
    durationMs: number;
    timestamp: string;
  };
}

export interface PipelineFailedEvent extends BaseEvent {
  type: 'pipeline:failed';
  payload: {
    runId: string;
    pipelineName: string;
    status: 'failed';
    error: string;
    durationMs: number;
    timestamp: string;
  };
}

export interface VoiceReceivedEvent extends BaseEvent {
  type: 'voice:received';
  payload: {
    projectId: string;
    audioData: string; // base64-encoded audio
    mimeType: string; // 'audio/ogg' for Telegram voice
    duration: number; // seconds
    topicId?: number;
    topicName?: string;
    replyMessageId?: number; // message ID of "Transcribing..." reply for editing
  };
}

export const VoiceReceivedPayloadSchema = z.object({
  projectId: z.string(),
  audioData: z.string(),
  mimeType: z.string(),
  duration: z.number(),
  topicId: z.number().optional(),
  topicName: z.string().optional(),
  replyMessageId: z.number().optional(),
});

export interface MediaReceivedEvent extends BaseEvent {
  type: 'media:received';
  payload: {
    projectId: string;
    mediaType: 'photo' | 'document';
    filePath: string;
    mimeType: string;
    fileName: string;
    fileSize?: number;
    caption?: string;
    topicId?: number;
    topicName?: string;
    replyMessageId?: number;
  };
}

export const MediaReceivedPayloadSchema = z.object({
  projectId: z.string(),
  mediaType: z.enum(['photo', 'document']),
  filePath: z.string(),
  mimeType: z.string(),
  fileName: z.string(),
  fileSize: z.number().optional(),
  caption: z.string().optional(),
  topicId: z.number().optional(),
  topicName: z.string().optional(),
  replyMessageId: z.number().optional(),
});

export interface EmailReplyStartEvent extends BaseEvent {
  type: 'email:reply:start';
  payload: {
    emailId: string;
    userIntent?: string;
    topicId?: number;
    topicName?: string;
  };
}

export const EmailReplyStartPayloadSchema = z.object({
  emailId: z.string(),
  userIntent: z.string().optional(),
  topicId: z.number().optional(),
  topicName: z.string().optional(),
});

export interface EmailReplySendEvent extends BaseEvent {
  type: 'email:reply:send';
  payload: {
    compositionId: string;
  };
}

export const EmailReplySendPayloadSchema = z.object({
  compositionId: z.string(),
});

export interface EmailReplyEditEvent extends BaseEvent {
  type: 'email:reply:edit';
  payload: {
    compositionId: string;
    newInstructions: string;
  };
}

export const EmailReplyEditPayloadSchema = z.object({
  compositionId: z.string(),
  newInstructions: z.string(),
});

export interface EmailReplyCancelEvent extends BaseEvent {
  type: 'email:reply:cancel';
  payload: {
    compositionId: string;
  };
}

export const EmailReplyCancelPayloadSchema = z.object({
  compositionId: z.string(),
});

export interface EmailTriageProcessedEvent extends BaseEvent {
  type: 'email:triage:processed';
  payload: {
    emailId: string;
    rulesMatched: string[];
    actionsTaken: string[];
  };
}

export const EmailTriageProcessedPayloadSchema = z.object({
  emailId: z.string(),
  rulesMatched: z.array(z.string()),
  actionsTaken: z.array(z.string()),
});

export interface EmailTriageActionItemsEvent extends BaseEvent {
  type: 'email:triage:action-items';
  payload: {
    emailId: string;
  };
}

export const EmailTriageActionItemsPayloadSchema = z.object({
  emailId: z.string(),
});

export interface EmailActionExtractCompletedEvent extends BaseEvent {
  type: 'email:action-extract:completed';
  payload: {
    emailId: string;
    tasksCreated: number;
    actionItems: string[];
  };
}

export const EmailActionExtractCompletedPayloadSchema = z.object({
  emailId: z.string(),
  tasksCreated: z.number(),
  actionItems: z.array(z.string()),
});

export interface EmailActionExtractFailedEvent extends BaseEvent {
  type: 'email:action-extract:failed';
  payload: {
    emailId: string;
    error: string;
  };
}

export const EmailActionExtractFailedPayloadSchema = z.object({
  emailId: z.string(),
  error: z.string(),
});

export interface TaskManagementAutonomousCompletedEvent extends BaseEvent {
  type: 'task-management:autonomous:completed';
  payload: {
    executedCount: number;
    queuedCount: number;
    failedCount: number;
    actions: Array<{
      action: string;
      taskTitle: string;
      reason: string;
      outcome: 'executed' | 'queued' | 'failed';
    }>;
  };
}

export const TaskManagementAutonomousCompletedPayloadSchema = z.object({
  executedCount: z.number(),
  queuedCount: z.number(),
  failedCount: z.number(),
  actions: z.array(
    z.object({
      action: z.string(),
      taskTitle: z.string(),
      reason: z.string(),
      outcome: z.enum(['executed', 'queued', 'failed']),
    }),
  ),
});

export interface TaskManagementAutonomousFailedEvent extends BaseEvent {
  type: 'task-management:autonomous:failed';
  payload: {
    error: string;
  };
}

export const TaskManagementAutonomousFailedPayloadSchema = z.object({
  error: z.string(),
});

export interface TaskManagementManageRequestEvent extends BaseEvent {
  type: 'task-management:manage-request';
  payload: {
    source: 'telegram' | 'api' | 'pipeline';
    requestId?: string;
  };
}

export const TaskManagementManageRequestPayloadSchema = z.object({
  source: z.enum(['telegram', 'api', 'pipeline']),
  requestId: z.string().optional(),
});

export interface KnowledgeIngestRequestEvent extends BaseEvent {
  type: 'knowledge:ingest:request';
  payload: {
    taskId: string;
    type: 'text' | 'file' | 'voice-memo' | 'url';
    content?: string;
    filePath?: string;
    url?: string;
    title?: string;
    source?: string;
    tags?: string[];
  };
}

export interface KnowledgeIngestCompleteEvent extends BaseEvent {
  type: 'knowledge:ingest:complete';
  payload: {
    taskId: string;
    bubbleId: string;
    title: string;
    filePath: string;
    sourceFilePath?: string;
    sourceUrl?: string;
  };
}

export interface KnowledgeIngestFailedEvent extends BaseEvent {
  type: 'knowledge:ingest:failed';
  payload: {
    taskId: string;
    error: string;
    type: 'text' | 'file' | 'voice-memo' | 'url';
  };
}

export interface KnowledgeBubbleCreatedEvent extends BaseEvent {
  type: 'knowledge:bubble:created';
  payload: {
    bubbleId: string;
    title: string;
    filePath: string;
  };
}

export interface KnowledgeBubbleUpdatedEvent extends BaseEvent {
  type: 'knowledge:bubble:updated';
  payload: {
    bubbleId: string;
    title: string;
    filePath: string;
  };
}

export interface KnowledgeBubbleDeletedEvent extends BaseEvent {
  type: 'knowledge:bubble:deleted';
  payload: {
    bubbleId: string;
    title: string;
    filePath: string;
  };
}

export interface KnowledgeEmbeddingGeneratedEvent extends BaseEvent {
  type: 'knowledge:embedding:generated';
  payload: {
    bubbleId: string;
  };
}

export interface KnowledgeTagsSuggestedEvent extends BaseEvent {
  type: 'knowledge:tags:suggested';
  payload: {
    bubbleId: string;
    suggestedTags: Array<{ tag: string; confidence: number; parentTag: string | null }>;
  };
}

export interface KnowledgeLinksSuggestedEvent extends BaseEvent {
  type: 'knowledge:links:suggested';
  payload: {
    bubbleId: string;
    links: Array<{
      targetBubbleId: string;
      confidence: number;
      relationshipType: string;
    }>;
  };
}

export interface KnowledgeClusteringCompleteEvent extends BaseEvent {
  type: 'knowledge:clustering:complete';
  payload: {
    clusterCount: number;
    clusteredBubbles: number;
    taskId: string;
  };
}

export interface KnowledgeMergeDetectedEvent extends BaseEvent {
  type: 'knowledge:merge:detected';
  payload: {
    mergeCount: number;
  };
}

export interface KnowledgeHubDetectedEvent extends BaseEvent {
  type: 'knowledge:hub:detected';
  payload: {
    bubbleId: string;
    linkCount: number;
  };
}

export interface KnowledgeChunkIndexedEvent extends BaseEvent {
  type: 'knowledge:chunk:indexed';
  payload: {
    bubbleId: string;
    chunkCount: number;
  };
}

export interface KnowledgeReindexProgressEvent extends BaseEvent {
  type: 'knowledge:reindex:progress';
  payload: {
    completed: number;
    total: number;
    bubbleId: string;
  };
}

export interface KnowledgeReindexCompleteEvent extends BaseEvent {
  type: 'knowledge:reindex:complete';
  payload: {
    total: number;
    indexed: number;
    errors: string[];
  };
}

export interface KnowledgeRetrospectiveCompleteEvent extends BaseEvent {
  type: 'knowledge:retrospective:complete';
  payload: {
    period: { since: string; until: string };
    bubblesCreated: number;
    bubblesUpdated: number;
    linksCreated: number;
    staleBubblesCount: number;
    temporaryBubblesCount: number;
  };
}

export interface KnowledgeStaleBubblesDetectedEvent extends BaseEvent {
  type: 'knowledge:stale:detected';
  payload: {
    staleBubbleIds: string[];
    count: number;
  };
}

export interface InsightGeneratedEvent extends BaseEvent {
  type: 'insight:generated';
  payload: {
    insightId: string;
    patternKey: string;
    title: string;
    confidence: number;
    serviceSources: string[];
  };
}

export interface InsightQueuedEvent extends BaseEvent {
  type: 'insight:queued';
  payload: {
    insightId: string;
    patternKey: string;
  };
}

export interface InsightSuppressedEvent extends BaseEvent {
  type: 'insight:suppressed';
  payload: {
    insightId: string;
    patternKey: string;
    reason: 'duplicate' | 'low-confidence';
  };
}

export interface SystemHealthAlertEvent extends BaseEvent {
  type: 'system:health:alert';
  payload: {
    severity: 'warning' | 'error' | 'critical';
    source: string;
    message: string;
    taskId?: string;
  };
}

export const SystemHealthAlertPayloadSchema = z.object({
  severity: z.enum(['warning', 'error', 'critical']),
  source: z.string(),
  message: z.string(),
  taskId: z.string().optional(),
});

export type RavenEvent =
  | NewEmailEvent
  | ScheduleTriggeredEvent
  | AgentTaskRequestEvent
  | AgentTaskCompleteEvent
  | AgentMessageEvent
  | UserChatMessageEvent
  | NotificationEvent
  | SkillDataEvent
  | ConfigReloadedEvent
  | PermissionApprovedEvent
  | PermissionBlockedEvent
  | PermissionDeniedEvent
  | ConfigPipelinesReloadedEvent
  | SystemHealthAlertEvent
  | VoiceReceivedEvent
  | MediaReceivedEvent
  | PipelineStartedEvent
  | PipelineStepCompleteEvent
  | PipelineStepFailedEvent
  | PipelineStepRetryEvent
  | PipelineCompleteEvent
  | PipelineFailedEvent
  | EmailReplyStartEvent
  | EmailReplySendEvent
  | EmailReplyEditEvent
  | EmailReplyCancelEvent
  | EmailTriageProcessedEvent
  | EmailTriageActionItemsEvent
  | EmailActionExtractCompletedEvent
  | EmailActionExtractFailedEvent
  | TaskManagementAutonomousCompletedEvent
  | TaskManagementAutonomousFailedEvent
  | TaskManagementManageRequestEvent
  | KnowledgeIngestRequestEvent
  | KnowledgeIngestCompleteEvent
  | KnowledgeIngestFailedEvent
  | KnowledgeBubbleCreatedEvent
  | KnowledgeBubbleUpdatedEvent
  | KnowledgeBubbleDeletedEvent
  | KnowledgeEmbeddingGeneratedEvent
  | KnowledgeTagsSuggestedEvent
  | KnowledgeLinksSuggestedEvent
  | KnowledgeClusteringCompleteEvent
  | KnowledgeMergeDetectedEvent
  | KnowledgeHubDetectedEvent
  | KnowledgeChunkIndexedEvent
  | KnowledgeReindexProgressEvent
  | KnowledgeReindexCompleteEvent
  | KnowledgeRetrospectiveCompleteEvent
  | KnowledgeStaleBubblesDetectedEvent
  | InsightGeneratedEvent
  | InsightQueuedEvent
  | InsightSuppressedEvent
  | NotificationDeliverEvent
  | NotificationQueuedEvent
  | NotificationBatchedEvent;

export type RavenEventType = RavenEvent['type'];

export type Priority = 'low' | 'normal' | 'high' | 'urgent';

export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface SubAgentDefinition {
  description: string;
  prompt: string;
  tools?: string[];
  model?: string;
  mcpServers?: string[];
}
