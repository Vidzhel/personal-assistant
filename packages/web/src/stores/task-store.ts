import { create } from 'zustand';
import { api, type RavenTaskRecord, type RavenTaskDetail } from '@/lib/api-client';

interface TaskFilters {
  status?: string;
  projectId?: string;
  source?: string;
  assignedAgentId?: string;
  search?: string;
  includeArchived?: boolean;
}

interface TaskState {
  tasks: RavenTaskRecord[];
  selectedTask: RavenTaskDetail | null;
  filters: TaskFilters;
  counts: Record<string, number>;
  loading: boolean;
  tab: 'tasks' | 'monitor';

  setTab: (tab: 'tasks' | 'monitor') => void;
  setFilters: (filters: Partial<TaskFilters>) => void;
  clearFilters: () => void;
  fetchTasks: () => Promise<void>;
  fetchCounts: () => Promise<void>;
  selectTask: (id: string) => Promise<void>;
  clearSelection: () => void;
}

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: [],
  selectedTask: null,
  filters: {},
  counts: { todo: 0, in_progress: 0, completed: 0, archived: 0 },
  loading: false,
  tab: 'tasks',

  setTab: (tab) => set({ tab }),

  setFilters: (filters) => {
    set((state) => ({ filters: { ...state.filters, ...filters } }));
    void get().fetchTasks();
  },

  clearFilters: () => {
    set({ filters: {} });
    void get().fetchTasks();
  },

  fetchTasks: async () => {
    try {
      const { filters } = get();
      const tasks = await api.getTasks(filters);
      set({ tasks });
    } catch {
      /* polling failure — keep stale data */
    }
  },

  fetchCounts: async () => {
    try {
      const counts = await api.getTaskCounts();
      set({ counts });
    } catch {
      /* polling failure */
    }
  },

  selectTask: async (id) => {
    try {
      const task = await api.getTask(id);
      set({ selectedTask: task });
    } catch {
      /* */
    }
  },

  clearSelection: () => set({ selectedTask: null }),
}));
