import { z } from 'zod';

export const SystemAccessLevel = z.enum(['none', 'read', 'read-write']);
export type SystemAccessLevel = z.infer<typeof SystemAccessLevel>;

export interface Project {
  id: string;
  name: string;
  description?: string;
  skills: string[];
  systemPrompt?: string;
  systemAccess?: SystemAccessLevel;
  isMeta?: boolean;
  createdAt: number;
  updatedAt: number;
}

export const ProjectCreateInput = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  skills: z.array(z.string()).optional(),
  systemPrompt: z.string().optional(),
  systemAccess: SystemAccessLevel.optional().default('none'),
});
export type ProjectCreateInput = z.infer<typeof ProjectCreateInput>;

export const ProjectUpdateInput = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  skills: z.array(z.string()).optional(),
  systemPrompt: z.string().optional(),
  systemAccess: SystemAccessLevel.optional(),
});
export type ProjectUpdateInput = z.infer<typeof ProjectUpdateInput>;
