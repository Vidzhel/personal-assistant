import { create } from 'zustand';
import {
  api,
  type Project,
  type Skill,
  type Schedule,
  type TemplateRecord,
} from '@/lib/api-client';

interface AppState {
  projects: Project[];
  skills: Skill[];
  schedules: Schedule[];
  templates: TemplateRecord[];
  health: {
    status: string;
    uptime: number;
    skills: string[];
    agentQueue: number;
    agentsRunning: number;
  } | null;
  loading: boolean;
  fetchProjects: () => Promise<void>;
  fetchSkills: () => Promise<void>;
  fetchSchedules: () => Promise<void>;
  fetchTemplates: () => Promise<void>;
  fetchHealth: () => Promise<void>;
  fetchAll: () => Promise<void>;
}

export const useAppStore = create<AppState>((set) => ({
  projects: [],
  skills: [],
  schedules: [],
  templates: [],
  health: null,
  loading: false,

  fetchProjects: async () => {
    const projects = await api.getProjects();
    set({ projects });
  },

  fetchSkills: async () => {
    const skills = await api.getSkills();
    set({ skills });
  },

  fetchSchedules: async () => {
    const schedules = await api.getSchedules();
    set({ schedules });
  },

  fetchTemplates: async () => {
    const templates = await api.getTemplates();
    set({ templates });
  },

  fetchHealth: async () => {
    const health = await api.getHealth();
    set({ health });
  },

  fetchAll: async () => {
    set({ loading: true });
    try {
      const [projects, skills, schedules, templates, health] = await Promise.all([
        api.getProjects(),
        api.getSkills(),
        api.getSchedules(),
        api.getTemplates(),
        api.getHealth(),
      ]);
      set({ projects, skills, schedules, templates, health, loading: false });
    } catch {
      set({ loading: false });
    }
  },
}));
