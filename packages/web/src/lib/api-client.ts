const API_URL = process.env.NEXT_PUBLIC_CORE_API_URL || 'http://localhost:3001/api';

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...opts?.headers },
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  getHealth: () =>
    request<{
      status: string;
      uptime: number;
      skills: string[];
      agentQueue: number;
      agentsRunning: number;
    }>('/health'),
  getProjects: () => request<Project[]>('/projects'),
  getProject: (id: string) => request<Project>(`/projects/${id}`),
  createProject: (data: { name: string; description?: string; skills?: string[] }) =>
    request<Project>('/projects', { method: 'POST', body: JSON.stringify(data) }),
  deleteProject: (id: string) => request(`/projects/${id}`, { method: 'DELETE' }),
  getSkills: () => request<Skill[]>('/skills'),
  getSchedules: () => request<Schedule[]>('/schedules'),
  getEvents: (params?: { since?: number; type?: string; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.since) qs.set('since', String(params.since));
    if (params?.type) qs.set('type', params.type);
    if (params?.limit) qs.set('limit', String(params.limit));
    return request<EventRecord[]>(`/events?${qs}`);
  },
  sendChat: (projectId: string, message: string) =>
    request(`/projects/${projectId}/chat`, { method: 'POST', body: JSON.stringify({ message }) }),
  getProjectSessions: (projectId: string) => request<Session[]>(`/projects/${projectId}/sessions`),
  createSession: (projectId: string) =>
    request<Session>(`/projects/${projectId}/sessions/new`, { method: 'POST' }),
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

export interface EventRecord {
  id: string;
  type: string;
  source: string;
  projectId: string | null;
  payload: unknown;
  timestamp: number;
}
