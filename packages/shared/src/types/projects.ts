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

export interface ProjectKnowledgeLink {
  projectId: string;
  bubbleId: string;
  linkedBy?: string;
  createdAt: string;
}

export interface KnowledgeDiscoveryProposal {
  bubbleTitle: string;
  bubbleContent: string;
  tags: string[];
  sourceSessionId: string;
  sourceDescription: string;
}

export const CreateDataSourceSchema = z.object({
  uri: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  sourceType: z.enum(['gdrive', 'file', 'url', 'other']),
});
export type CreateDataSourceInput = z.infer<typeof CreateDataSourceSchema>;

export const CreateProjectKnowledgeLinkSchema = z.object({
  bubbleId: z.string().min(1),
});
export type CreateProjectKnowledgeLinkInput = z.infer<typeof CreateProjectKnowledgeLinkSchema>;

export const KnowledgeProposalResponseSchema = z.object({
  action: z.enum(['approve', 'reject', 'modify']),
  modifiedContent: z.string().optional(),
  reason: z.string().optional(),
});
export type KnowledgeProposalResponse = z.infer<typeof KnowledgeProposalResponseSchema>;

export const ProjectUpdateInput = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  skills: z.array(z.string()).optional(),
  systemPrompt: z.string().optional(),
  systemAccess: SystemAccessLevel.optional(),
});
export type ProjectUpdateInput = z.infer<typeof ProjectUpdateInput>;
