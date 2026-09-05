import { create } from 'zustand';
import {
  api,
  type NamedAgentRecord,
  type RavenTaskRecord,
  type Skill,
  type Project,
  type AgentMemoryFile,
} from '@/lib/api-client';

interface AgentState {
  agents: NamedAgentRecord[];
  availableSkills: Skill[];
  availableProjects: Project[];
  selectedAgentTasks: RavenTaskRecord[];
  selectedAgentMemory: AgentMemoryFile[];
  /** Set when the memory fetch itself failed (e.g. the backend's memory
   * store isn't wired, or the request errored) — distinct from a
   * successful fetch that simply returned no files. */
  selectedAgentMemoryError: string | null;
  memoryProjectId: string | null;
  memoryLoading: boolean;
  showForm: boolean;
  editingAgentId: string | null;
  showTaskHistory: string | null;
  showMemory: string | null;
  loading: boolean;
  error: string | null;

  fetchAgents: () => Promise<void>;
  fetchSkills: () => Promise<void>;
  fetchProjects: () => Promise<void>;
  openCreateForm: () => void;
  openEditForm: (id: string) => void;
  closeForm: () => void;
  showHistory: (agentId: string) => Promise<void>;
  closeHistory: () => void;
  showMemoryPanel: (agentId: string) => Promise<void>;
  closeMemoryPanel: () => void;
  selectMemoryProject: (projectId: string) => Promise<void>;
  createAgent: (data: {
    name: string;
    description?: string;
    instructions?: string;
    skills?: string[];
    model?: string;
    maxTurns?: number;
    bash?: object;
    projectScope?: string;
  }) => Promise<void>;
  updateAgent: (
    id: string,
    data: {
      name?: string;
      description?: string | null;
      instructions?: string | null;
      skills?: string[];
      model?: string | null;
      maxTurns?: number | null;
      bash?: object;
    },
  ) => Promise<void>;
  deleteAgent: (id: string) => Promise<void>;
}

let memoryRequest = 0;

// eslint-disable-next-line max-lines-per-function -- Zustand store factory
export const useAgentStore = create<AgentState>((set, get) => ({
  agents: [],
  availableSkills: [],
  availableProjects: [],
  selectedAgentTasks: [],
  selectedAgentMemory: [],
  selectedAgentMemoryError: null,
  memoryProjectId: null,
  memoryLoading: false,
  showForm: false,
  editingAgentId: null,
  showTaskHistory: null,
  showMemory: null,
  loading: false,
  error: null,

  fetchAgents: async () => {
    try {
      const agents = await api.getAgents();
      set({ agents });
    } catch {
      /* polling failure */
    }
  },

  fetchSkills: async () => {
    try {
      const skills = await api.getSkills();
      set({ availableSkills: skills });
    } catch {
      /* */
    }
  },

  fetchProjects: async () => {
    try {
      const projects = await api.getProjects();
      set({ availableProjects: projects });
    } catch {
      /* */
    }
  },

  openCreateForm: () => set({ showForm: true, editingAgentId: null }),
  openEditForm: (id) => set({ showForm: true, editingAgentId: id }),
  closeForm: () => set({ showForm: false, editingAgentId: null, error: null }),

  showHistory: async (agentId) => {
    set({ showTaskHistory: agentId, selectedAgentTasks: [] });
    try {
      const tasks = await api.getNamedAgentTasks(agentId, { limit: 50 });
      set({ selectedAgentTasks: tasks });
    } catch {
      /* polling failure — panel shows empty */
    }
  },

  closeHistory: () => set({ showTaskHistory: null, selectedAgentTasks: [] }),

  showMemoryPanel: async (agentId) => {
    ++memoryRequest;
    set({
      showMemory: agentId,
      memoryProjectId: null,
      memoryLoading: false,
      selectedAgentMemory: [],
      selectedAgentMemoryError: null,
    });
    const projectId = get().agents.find((agent) => agent.id === agentId)?.projectId;
    if (projectId) await get().selectMemoryProject(projectId);
  },

  selectMemoryProject: async (projectId) => {
    const requestId = ++memoryRequest;
    set({
      memoryProjectId: projectId || null,
      selectedAgentMemory: [],
      selectedAgentMemoryError: null,
      memoryLoading: !!projectId,
    });
    if (!projectId) return;
    try {
      const memory = await api.getProjectMemory(projectId);
      if (requestId === memoryRequest) set({ selectedAgentMemory: memory });
    } catch (err) {
      if (requestId === memoryRequest) set({ selectedAgentMemoryError: (err as Error).message });
    } finally {
      if (requestId === memoryRequest) set({ memoryLoading: false });
    }
  },

  closeMemoryPanel: () => {
    ++memoryRequest;
    set({
      showMemory: null,
      memoryProjectId: null,
      memoryLoading: false,
      selectedAgentMemory: [],
      selectedAgentMemoryError: null,
    });
  },

  createAgent: async (data) => {
    set({ loading: true, error: null });
    try {
      await api.createAgent(data);
      await get().fetchAgents();
      set({ showForm: false });
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ loading: false });
    }
  },

  updateAgent: async (id, data) => {
    set({ loading: true, error: null });
    try {
      await api.updateAgent(id, data);
      await get().fetchAgents();
      set({ showForm: false, editingAgentId: null });
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ loading: false });
    }
  },

  deleteAgent: async (id) => {
    set({ loading: true });
    try {
      await api.deleteAgent(id);
      await get().fetchAgents();
    } finally {
      set({ loading: false });
    }
  },
}));
