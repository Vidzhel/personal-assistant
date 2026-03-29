import type { z } from 'zod';

import type {
  AgentYamlSchema,
  BashAccessSchema,
  ScheduleYamlSchema,
  ValidationConfigSchema,
} from '../project/schemas.ts';

// --- Inferred from schemas ---

export type AgentYaml = z.infer<typeof AgentYamlSchema>;
export type BashAccess = z.infer<typeof BashAccessSchema>;
export type ValidationConfig = z.infer<typeof ValidationConfigSchema>;
export type ScheduleYaml = z.infer<typeof ScheduleYamlSchema>;

// --- Manual interfaces ---

export interface ProjectNode {
  id: string;
  name: string;
  displayName?: string;
  description?: string;
  path: string;
  relativePath: string;
  parentId: string | null;
  systemAccess: 'none' | 'read' | 'read-write';
  isMeta: boolean;
  contextMd: string;
  agents: AgentYaml[];
  schedules: ScheduleYaml[];
  children: string[];
}

export interface ResolvedProjectContext {
  contextChain: string[];
  agents: Map<string, AgentYaml>;
  schedules: ScheduleYaml[];
}

export interface ProjectIndex {
  projects: Map<string, ProjectNode>;
  rootProjects: string[];
}
