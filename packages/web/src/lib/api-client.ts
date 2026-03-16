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
  createProject: (data: { name: string; description?: string; skills?: string[] }) =>
    request<Project>('/projects', { method: 'POST', body: JSON.stringify(data) }),
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
};

export interface Project {
  id: string;
  name: string;
  description: string | null;
  skills: string[];
  systemPrompt: string | null;
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
  sessionId?: string;
  projectId?: string;
  priority: string;
  status: string;
  startedAt?: number;
  createdAt: number;
  durationMs?: number;
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
