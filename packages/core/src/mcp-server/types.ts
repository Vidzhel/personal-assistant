import type { TaskExecutionEngine } from '../task-execution/task-execution-engine.ts';
import type { MessageStore } from '../session-manager/message-store.ts';
import type { SessionManager } from '../session-manager/session-manager.ts';
import type { KnowledgeStore } from '../knowledge-engine/knowledge-store.ts';
import type { RetrievalEngine } from '../knowledge-engine/retrieval.ts';
import type { NamedAgentStore } from '../agent-registry/named-agent-store.ts';
import type { ProjectRegistry } from '../project-registry/project-registry.ts';
import type { Scheduler } from '../scheduler/scheduler.ts';
import type { PipelineEngine } from '../pipeline-engine/pipeline-engine.ts';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { DatabaseInterface } from '@raven/shared';
import type { PendingApprovals } from '../permission-engine/pending-approvals.ts';

export interface RavenMcpDeps {
  executionEngine?: TaskExecutionEngine;
  messageStore?: MessageStore;
  sessionManager?: SessionManager;
  knowledgeStore?: KnowledgeStore;
  retrievalEngine?: RetrievalEngine;
  namedAgentStore?: NamedAgentStore;
  projectRegistry?: ProjectRegistry;
  scheduler?: Scheduler;
  pipelineEngine?: PipelineEngine;
  eventBus: EventBus;
  db?: DatabaseInterface;
  pendingApprovals?: PendingApprovals;
}
