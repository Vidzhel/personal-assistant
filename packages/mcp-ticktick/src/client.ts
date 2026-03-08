const BASE_URL = 'https://api.ticktick.com/open/v1';

export interface TickTickProject {
  id: string;
  name: string;
  color?: string;
  sortOrder?: number;
  closed?: boolean;
  groupId?: string;
  viewMode?: string;
  kind?: string;
}

export interface TickTickTask {
  id: string;
  projectId: string;
  title: string;
  content?: string;
  desc?: string;
  dueDate?: string;
  startDate?: string;
  priority?: number;
  status?: number;
  completedTime?: string;
  tags?: string[];
  items?: TickTickChecklistItem[];
  timeZone?: string;
  isAllDay?: boolean;
  sortOrder?: number;
}

export interface TickTickChecklistItem {
  id?: string;
  title: string;
  status?: number;
  sortOrder?: number;
}

export interface ProjectData {
  project: TickTickProject;
  tasks: TickTickTask[];
}

export interface CreateTaskInput {
  title: string;
  projectId?: string;
  content?: string;
  desc?: string;
  dueDate?: string;
  startDate?: string;
  priority?: number;
  tags?: string[];
  items?: TickTickChecklistItem[];
  isAllDay?: boolean;
  timeZone?: string;
}

export interface UpdateTaskInput {
  title?: string;
  content?: string;
  desc?: string;
  dueDate?: string;
  startDate?: string;
  priority?: number;
  tags?: string[];
  items?: TickTickChecklistItem[];
  isAllDay?: boolean;
}

export interface CreateProjectInput {
  name: string;
  color?: string;
  viewMode?: string;
  kind?: string;
}

export interface UpdateProjectInput {
  name?: string;
  color?: string;
  viewMode?: string;
}

async function request<T>(
  path: string,
  token: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const { method = 'GET', body } = options;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`TickTick API ${method} ${path} failed (${res.status}): ${text}`);
  }

  if (res.status === 204 || res.headers.get('content-length') === '0') {
    return undefined as T;
  }

  return (await res.json()) as T;
}

export function createClient(token: string): {
  getProjects: () => Promise<TickTickProject[]>;
  getProject: (projectId: string) => Promise<TickTickProject>;
  getProjectData: (projectId: string) => Promise<ProjectData>;
  createProject: (input: CreateProjectInput) => Promise<TickTickProject>;
  updateProject: (projectId: string, input: UpdateProjectInput) => Promise<TickTickProject>;
  deleteProject: (projectId: string) => Promise<void>;
  getTask: (projectId: string, taskId: string) => Promise<TickTickTask>;
  createTask: (input: CreateTaskInput) => Promise<TickTickTask>;
  updateTask: (projectId: string, taskId: string, input: UpdateTaskInput) => Promise<TickTickTask>;
  deleteTask: (projectId: string, taskId: string) => Promise<void>;
  completeTask: (projectId: string, taskId: string) => Promise<void>;
  batchCreateTasks: (tasks: CreateTaskInput[]) => Promise<TickTickTask[]>;
} {
  return {
    getProjects: () => request<TickTickProject[]>('/project', token),

    getProject: (projectId) => request<TickTickProject>(`/project/${projectId}`, token),

    getProjectData: (projectId) => request<ProjectData>(`/project/${projectId}/data`, token),

    createProject: (input) =>
      request<TickTickProject>('/project', token, { method: 'POST', body: input }),

    updateProject: (projectId, input) =>
      request<TickTickProject>(`/project/${projectId}`, token, { method: 'POST', body: input }),

    deleteProject: (projectId) =>
      request<undefined>(`/project/${projectId}`, token, { method: 'DELETE' }),

    getTask: (projectId, taskId) => request<TickTickTask>(`/task/${projectId}/${taskId}`, token),

    createTask: (input) => request<TickTickTask>('/task', token, { method: 'POST', body: input }),

    updateTask: (projectId, taskId, input) =>
      request<TickTickTask>(`/task/${projectId}/${taskId}`, token, { method: 'POST', body: input }),

    deleteTask: (projectId, taskId) =>
      request<undefined>(`/task/${projectId}/${taskId}`, token, { method: 'DELETE' }),

    completeTask: (projectId, taskId) =>
      request<undefined>(`/project/${projectId}/task/${taskId}/complete`, token, {
        method: 'POST',
      }),

    batchCreateTasks: (tasks) =>
      request<TickTickTask[]>('/batch/task', token, { method: 'POST', body: tasks }),
  };
}
