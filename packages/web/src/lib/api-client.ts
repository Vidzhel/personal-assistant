const API_URL = process.env.NEXT_PUBLIC_CORE_API_URL || 'http://localhost:4001/api';

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...(opts?.headers as Record<string, string>) };
  if (opts?.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API_URL}${path}`, { ...opts, headers });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  getHealth: async () => {
    const raw = await request<{
      status: string;
      uptime: number;
      subsystems: {
        skills: { names: string[] };
        agentManager: { queueLength: number; runningCount: number };
      };
    }>('/health');
    return {
      status: raw.status,
      uptime: raw.uptime,
      skills: raw.subsystems.skills.names,
      agentQueue: raw.subsystems.agentManager.queueLength,
      agentsRunning: raw.subsystems.agentManager.runningCount,
    };
  },
  getProjects: () => request<Project[]>('/projects'),
  getProject: (id: string) => request<Project>(`/projects/${id}`),
  createProject: (data: {
    name: string;
    description?: string;
    skills?: string[];
    systemAccess?: 'none' | 'read' | 'read-write';
  }) => request<Project>('/projects', { method: 'POST', body: JSON.stringify(data) }),
  deleteProject: (id: string) => request(`/projects/${id}`, { method: 'DELETE' }),
  getSkills: () => request<Skill[]>('/skills'),
  getSchedules: () => request<Schedule[]>('/schedules'),
  getEvents: (params?: { since?: number; type?: string; source?: string; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.since) qs.set('since', String(params.since));
    if (params?.type) qs.set('type', params.type);
    if (params?.source) qs.set('source', params.source);
    if (params?.limit) qs.set('limit', String(params.limit));
    return request<EventRecord[]>(`/events?${qs}`);
  },
  getEventSources: () => request<string[]>('/events/sources'),
  getEventTypes: () => request<string[]>('/events/types'),
  sendChat: (projectId: string, message: string) =>
    request(`/projects/${projectId}/chat`, { method: 'POST', body: JSON.stringify({ message }) }),
  getProjectSessions: (projectId: string) => request<Session[]>(`/projects/${projectId}/sessions`),
  createSession: (projectId: string) =>
    request<Session>(`/projects/${projectId}/sessions/new`, { method: 'POST' }),
  getSessionDebug: (sessionId: string) => request<SessionDebug>(`/sessions/${sessionId}/debug`),
  updateSession: (
    sessionId: string,
    data: { name?: string; description?: string; pinned?: boolean },
  ) => request<Session>(`/sessions/${sessionId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  getCrossReferences: (sessionId: string) =>
    request<{ from: CrossSessionReference[]; to: CrossSessionReference[] }>(
      `/sessions/${sessionId}/cross-references`,
    ),
  createCrossReference: (sessionId: string, data: { targetSessionId: string; context?: string }) =>
    request<CrossSessionReference>(`/sessions/${sessionId}/cross-references`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  deleteCrossReference: (sessionId: string, refId: string) =>
    request(`/sessions/${sessionId}/cross-references/${refId}`, { method: 'DELETE' }),
  getAgentTasks: (params?: {
    status?: string;
    skillName?: string;
    limit?: number;
    offset?: number;
  }) => {
    const qs = new URLSearchParams();
    if (params?.status) qs.set('status', params.status);
    if (params?.skillName) qs.set('skillName', params.skillName);
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.offset) qs.set('offset', String(params.offset));
    return request<TaskRecord[]>(`/agent-tasks?${qs}`);
  },
  getAgentTask: (id: string) => request<TaskRecord>(`/agent-tasks/${id}`),
  getActiveTasks: () => request<ActiveTasks>('/agent-tasks/active'),
  cancelTask: (taskId: string) => request(`/agent-tasks/${taskId}/cancel`, { method: 'POST' }),
  getPipelines: () => request<EnrichedPipeline[]>('/pipelines'),
  getPipeline: (name: string) => request<EnrichedPipeline>(`/pipelines/${name}`),
  getPipelineRuns: (name: string, limit?: number) => {
    const qs = limit ? `?limit=${limit}` : '';
    return request<PipelineRunRecord[]>(`/pipelines/${name}/runs${qs}`);
  },
  triggerPipeline: (name: string) =>
    request<{ runId: string; status: string }>(`/pipelines/${name}/trigger`, { method: 'POST' }),
  savePipeline: async (name: string, yamlString: string) => {
    const res = await fetch(`${API_URL}/pipelines/${name}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/yaml' },
      body: yamlString,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const detail = (body as { error?: string } | null)?.error;
      throw new Error(detail ?? `Pipeline save failed (${res.status})`);
    }
    return res.json() as Promise<{ config: PipelineConfig }>;
  },
  getMetrics: (period = '24h') => request<MetricsResponse>(`/metrics?period=${period}`),
  getKnowledgeGraph: (params?: {
    view?: string;
    tag?: string;
    domain?: string;
    permanence?: string;
  }) => {
    const qs = new URLSearchParams();
    if (params?.view) qs.set('view', params.view);
    if (params?.tag) qs.set('tag', params.tag);
    if (params?.domain) qs.set('domain', params.domain);
    if (params?.permanence) qs.set('permanence', params.permanence);
    return request<KnowledgeGraphData>(`/knowledge/graph?${qs}`);
  },
  getKnowledgeBubble: (id: string) => request<KnowledgeBubble>(`/knowledge/${id}`),
  updateKnowledgeBubble: (id: string, data: Record<string, unknown>) =>
    request<KnowledgeBubble>(`/knowledge/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  patchPermanence: (id: string, permanence: string) =>
    request(`/knowledge/${id}/permanence`, {
      method: 'PATCH',
      body: JSON.stringify({ permanence }),
    }),
  deleteKnowledgeBubble: (id: string) => request(`/knowledge/${id}`, { method: 'DELETE' }),
  searchKnowledge: (query: string) =>
    request<KnowledgeSearchResult>('/knowledge/search', {
      method: 'POST',
      body: JSON.stringify({ query }),
    }),
  mergeKnowledgeBubbles: (bubbleIds: string[]) =>
    request<{ mergedBubbleId: string }>('/knowledge/merge', {
      method: 'POST',
      body: JSON.stringify({ bubbleIds }),
    }),
  getSessionReferences: (sessionId: string) =>
    request<SessionReferences>(`/sessions/${sessionId}/references`),
  getLogs: (params?: { lines?: number; level?: string; component?: string; search?: string }) => {
    const qs = new URLSearchParams();
    if (params?.lines) qs.set('lines', String(params.lines));
    if (params?.level) qs.set('level', params.level);
    if (params?.component) qs.set('component', params.component);
    if (params?.search) qs.set('search', params.search);
    return request<LogsResponse>(`/logs?${qs}`);
  },
  getLogFiles: () => request<LogFile[]>('/logs/files'),
  getLogFile: (
    filename: string,
    params?: { lines?: number; level?: string; component?: string; search?: string },
  ) => {
    const qs = new URLSearchParams();
    if (params?.lines) qs.set('lines', String(params.lines));
    if (params?.level) qs.set('level', params.level);
    if (params?.component) qs.set('component', params.component);
    if (params?.search) qs.set('search', params.search);
    return request<LogsResponse>(`/logs/${filename}?${qs}`);
  },
  updateProject: (
    id: string,
    data: {
      name?: string;
      description?: string;
      skills?: string[];
      systemPrompt?: string | null;
      systemAccess?: 'none' | 'read' | 'read-write';
    },
  ) => request<Project>(`/projects/${id}`, { method: 'PUT', body: JSON.stringify(data) }),

  // Task management
  // eslint-disable-next-line complexity -- builds query string from many optional filter params
  getTasks: (params?: {
    status?: string;
    projectId?: string;
    source?: string;
    assignedAgentId?: string;
    search?: string;
    includeArchived?: boolean;
    limit?: number;
    offset?: number;
  }) => {
    const qs = new URLSearchParams();
    if (params?.status) qs.set('status', params.status);
    if (params?.projectId) qs.set('projectId', params.projectId);
    if (params?.source) qs.set('source', params.source);
    if (params?.assignedAgentId) qs.set('assignedAgentId', params.assignedAgentId);
    if (params?.search) qs.set('search', params.search);
    if (params?.includeArchived) qs.set('includeArchived', 'true');
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.offset) qs.set('offset', String(params.offset));
    return request<RavenTaskRecord[]>(`/tasks?${qs}`);
  },
  getTask: (id: string) => request<RavenTaskDetail>(`/tasks/${id}`),
  createTask: (data: {
    title: string;
    description?: string;
    prompt?: string;
    templateName?: string;
    projectId?: string;
    assignedAgentId?: string;
  }) => request<RavenTaskRecord>('/tasks', { method: 'POST', body: JSON.stringify(data) }),
  updateTask: (id: string, data: Record<string, unknown>) =>
    request<RavenTaskRecord>(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  completeTask: (id: string, artifacts?: string[]) =>
    request<RavenTaskRecord>(`/tasks/${id}/complete`, {
      method: 'POST',
      body: JSON.stringify({ artifacts }),
    }),
  getTaskCounts: (projectId?: string) => {
    const qs = projectId ? `?projectId=${projectId}` : '';
    return request<Record<string, number>>(`/tasks/counts${qs}`);
  },
  getTaskTemplates: () => request<TaskTemplateRecord[]>('/task-templates'),
  enqueueMessage: (sessionId: string, message: string) =>
    request(`/sessions/${sessionId}/enqueue`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),

  // Named agents management
  getAgents: () => request<NamedAgentRecord[]>('/agents'),
  getAgent: (id: string) => request<NamedAgentRecord>(`/agents/${id}`),
  createAgent: (data: {
    name: string;
    description?: string;
    instructions?: string;
    suiteIds?: string[];
  }) => request<NamedAgentRecord>('/agents', { method: 'POST', body: JSON.stringify(data) }),
  updateAgent: (
    id: string,
    data: {
      name?: string;
      description?: string | null;
      instructions?: string | null;
      suiteIds?: string[];
    },
  ) => request<NamedAgentRecord>(`/agents/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteAgent: (id: string) => request(`/agents/${id}`, { method: 'DELETE' }),
  getNamedAgentTasks: (id: string, params?: { limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.offset) qs.set('offset', String(params.offset));
    return request<RavenTaskRecord[]>(`/agents/${id}/tasks?${qs}`);
  },
  createSuite: (data: { name: string; displayName: string; description?: string }) =>
    request<{ name: string; displayName: string; description: string; suitePath: string }>(
      '/suites',
      {
        method: 'POST',
        body: JSON.stringify(data),
      },
    ),

  // Project data sources
  getProjectDataSources: (projectId: string) =>
    request<ProjectDataSource[]>(`/projects/${projectId}/data-sources`),
  createProjectDataSource: (
    projectId: string,
    data: { uri: string; label: string; description?: string; sourceType: string },
  ) =>
    request<ProjectDataSource>(`/projects/${projectId}/data-sources`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateProjectDataSource: (
    projectId: string,
    dsId: string,
    data: Partial<{ uri: string; label: string; description: string; sourceType: string }>,
  ) =>
    request<ProjectDataSource>(`/projects/${projectId}/data-sources/${dsId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteProjectDataSource: (projectId: string, dsId: string) =>
    request(`/projects/${projectId}/data-sources/${dsId}`, { method: 'DELETE' }),

  // Project knowledge links
  getProjectKnowledgeLinks: (projectId: string) =>
    request<LinkedBubbleSummary[]>(`/projects/${projectId}/knowledge-links`),
  linkKnowledgeToProject: (projectId: string, bubbleId: string) =>
    request(`/projects/${projectId}/knowledge-links`, {
      method: 'POST',
      body: JSON.stringify({ bubbleId }),
    }),
  unlinkKnowledgeFromProject: (projectId: string, bubbleId: string) =>
    request(`/projects/${projectId}/knowledge-links/${bubbleId}`, { method: 'DELETE' }),
};

export interface Project {
  id: string;
  name: string;
  description: string | null;
  skills: string[];
  systemPrompt: string | null;
  systemAccess?: 'none' | 'read' | 'read-write';
  isMeta?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Skill {
  name: string;
  displayName: string;
  version: string;
  description: string;
  capabilities: string[];
  mcpServers: string[];
  agentDefinitions: string[];
}

export interface Schedule {
  id: string;
  name: string;
  cron: string;
  timezone: string;
  taskType: string;
  skillName: string;
  enabled: boolean;
}

export interface Session {
  id: string;
  projectId: string;
  status: string;
  createdAt: number;
  lastActiveAt: number;
  turnCount: number;
  sdkSessionId?: string;
  name?: string;
  description?: string;
  pinned?: boolean;
  summary?: string;
}

export interface CrossSessionReference {
  id: string;
  sourceSessionId: string;
  targetSessionId: string;
  context?: string;
  createdAt: string;
}

export interface SessionDebug {
  session: Session;
  messages: unknown[];
  tasks: unknown[];
  auditEntries: unknown[];
  rawMessages: string[];
}

export interface TaskRecord {
  id: string;
  sessionId?: string;
  projectId?: string;
  skillName: string;
  actionName?: string;
  prompt: string;
  status: string;
  priority: string;
  result?: string;
  durationMs?: number;
  errors?: string[];
  blocked: boolean;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ActiveTaskInfo {
  taskId: string;
  skillName: string;
  actionName?: string;
  sessionId?: string;
  projectId?: string;
  projectName?: string;
  priority: string;
  status: string;
  startedAt?: number;
  createdAt: number;
  durationMs?: number;
  namedAgentId?: string;
}

export interface ActiveTasks {
  running: ActiveTaskInfo[];
  queued: ActiveTaskInfo[];
}

export interface EventRecord {
  id: string;
  type: string;
  source: string;
  projectId: string | null;
  payload: unknown;
  timestamp: number;
}

export interface PipelineRunRecord {
  id: string;
  pipeline_name: string;
  trigger_type: string;
  status: string;
  started_at: string;
  completed_at?: string;
  node_results?: string;
  error?: string;
}

export interface PipelineTrigger {
  type: 'cron' | 'event' | 'manual' | 'webhook';
  schedule?: string;
  event?: string;
  filter?: Record<string, string>;
}

export interface PipelineConfig {
  name: string;
  description?: string;
  version: number;
  trigger: PipelineTrigger;
  settings?: {
    retry?: { maxAttempts: number; backoffMs: number };
    timeout?: number;
    onError?: 'stop' | 'continue';
  };
  nodes: Record<string, unknown>;
  connections: unknown[];
  enabled: boolean;
}

export interface EnrichedPipeline {
  config: PipelineConfig;
  executionOrder: string[];
  entryPoints: string[];
  filePath: string;
  loadedAt: string;
  lastRun: PipelineRunRecord | null;
  nextRun: string | null;
}

interface StatsBlock {
  total: number;
  succeeded: number;
  failed: number;
  successRate: number;
  avgDurationMs: number | null;
}

export interface MetricsResponse {
  period: string;
  tasks: StatsBlock;
  pipelines: StatsBlock;
  perSkill: Array<StatsBlock & { skillName: string }>;
  perPipeline: Array<StatsBlock & { pipelineName: string }>;
}

export interface KnowledgeGraphNode {
  id: string;
  title: string;
  domain: string | null;
  permanence: 'temporary' | 'normal' | 'robust';
  tags: string[];
  clusterLabel: string | null;
  connectionDegree: number;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string | null;
}

export interface KnowledgeGraphEdge {
  source: string;
  target: string;
  relationshipType: string;
  confidence: number | null;
}

export interface KnowledgeGraphData {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  view: string;
}

export interface KnowledgeBubble {
  id: string;
  title: string;
  content: string;
  filePath: string;
  source: string | null;
  sourceFile: string | null;
  sourceUrl: string | null;
  tags: string[];
  domains: string[];
  permanence: 'temporary' | 'normal' | 'robust';
  createdAt: string;
  updatedAt: string;
}

export interface SessionReferenceItem {
  bubbleId: string;
  title: string;
  snippet: string;
  score: number;
  tags: string[];
  domains: string[];
  permanence: string;
}

export interface SessionReferences {
  references: Record<string, SessionReferenceItem[]>;
}

export interface KnowledgeSearchResult {
  results: Array<{
    bubbleId: string;
    title: string;
    score: number;
    contentPreview: string;
    tags: string[];
    domains: string[];
    permanence: string;
  }>;
  query: string;
  queryType: string;
  totalCandidates: number;
}

export interface LogEntry {
  level: number;
  levelLabel: string;
  time: number;
  component?: string;
  msg: string;
  [key: string]: unknown;
}

export interface LogsResponse {
  lines: LogEntry[];
  total: number;
  error?: string;
}

export interface LogFile {
  name: string;
  size: number;
  modified: number;
}

export interface RavenTaskRecord {
  id: string;
  title: string;
  description?: string;
  prompt?: string;
  status: string;
  assignedAgentId?: string;
  projectId?: string;
  pipelineId?: string;
  scheduleId?: string;
  parentTaskId?: string;
  source: string;
  externalId?: string;
  artifacts: string[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface RavenTaskDetail extends RavenTaskRecord {
  subtasks: RavenTaskRecord[];
}

export interface NamedAgentRecord {
  id: string;
  name: string;
  description: string | null;
  instructions: string | null;
  suiteIds: string[];
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  suites?: Array<{ name: string; displayName: string }>;
  isActive?: boolean;
  taskCounts?: { completed: number; inProgress: number };
}

export interface TaskTemplateRecord {
  name: string;
  title: string;
  description?: string;
  prompt?: string;
  defaultAgentId?: string;
  projectId?: string;
}

export interface ProjectDataSource {
  id: string;
  projectId: string;
  uri: string;
  label: string;
  description?: string;
  sourceType: 'gdrive' | 'file' | 'url' | 'other';
  createdAt: string;
  updatedAt: string;
}

export interface LinkedBubbleSummary {
  bubbleId: string;
  title: string;
  contentPreview: string;
  tags: string[];
  source: string;
  linkedBy: string | null;
  createdAt: string;
}
