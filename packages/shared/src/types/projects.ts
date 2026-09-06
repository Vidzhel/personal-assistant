import { z } from 'zod';
import { ModelConfigSchema } from './model-config.ts';

export const SystemAccessLevel = z.enum(['none', 'read', 'read-write']);
export type SystemAccessLevel = z.infer<typeof SystemAccessLevel>;

/** File-owned metadata inside context.md. */
export const ProjectMetadataSchema = z
  .object({
    version: z.literal(1),
    id: z
      .string()
      .min(1)
      .refine((id) => id !== '_global', 'The global identity is reserved')
      .optional(),
    displayName: z.string().min(1).optional(),
    description: z.string().optional(),
    skills: z.array(z.string()).optional(),
    systemPrompt: z.string().optional(),
    systemAccess: SystemAccessLevel.optional(),
  })
  .strict();
export type ProjectMetadata = z.infer<typeof ProjectMetadataSchema>;

export interface Project {
  id: string;
  name: string;
  description?: string;
  skills: string[];
  systemPrompt?: string;
  systemAccess?: SystemAccessLevel;
  isMeta?: boolean;
  /** Registry node id (relative path under `projects/`) linked to this project. */
  fsPath?: string;
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
  sourceType: 'gdrive' | 'file' | 'url' | 'other' | 'folder';
  createdAt: string;
  updatedAt: string;
  contextFiles?: string[];
}

const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isSafeContextFile(path: string): boolean {
  return (
    path.length > 0 &&
    !path.includes('\0') &&
    !path.includes('\\') &&
    !path.startsWith('/') &&
    !path.split('/').some((part) => part === '' || part === '.' || part === '..')
  );
}

export const ProjectWorkspaceSourceSchema = z
  .object({
    id: z
      .string()
      .regex(SOURCE_ID)
      .refine((id) => id !== 'home', 'The home source is reserved'),
    uri: z.string().min(1),
    label: z.string().min(1),
    description: z.string().optional(),
    sourceType: z.enum(['gdrive', 'file', 'url', 'other', 'folder']),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    contextFiles: z
      .array(z.string().refine(isSafeContextFile, 'Context file must be relative'))
      .optional(),
  })
  .strict()
  .superRefine((source, context) => {
    if (source.sourceType !== 'folder' && source.contextFiles !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Only folder sources may define context files',
        path: ['contextFiles'],
      });
    }
  });
export type ProjectWorkspaceSource = z.infer<typeof ProjectWorkspaceSourceSchema>;

const WorkspaceModeSchema = z.enum(['default', 'auto', 'full']);
export const ProjectMemoryBudgetSchema = z
  .object({
    maxFiles: z.number().int().positive(),
    maxTotalKb: z.number().int().positive(),
  })
  .strict();
export type ProjectMemoryBudget = z.infer<typeof ProjectMemoryBudgetSchema>;
const WorkspaceExecutionSchema = z
  .object({
    mode: WorkspaceModeSchema,
    modelConfig: ModelConfigSchema.optional(),
    sourceId: z
      .string()
      .regex(SOURCE_ID)
      .refine((id) => id !== 'home')
      .optional(),
  })
  .strict();

export const ProjectWorkspaceSchema = z
  .object({
    version: z.literal(1),
    execution: WorkspaceExecutionSchema.default({ mode: 'default' }),
    sources: z.array(ProjectWorkspaceSourceSchema).default([]),
    memory: ProjectMemoryBudgetSchema.optional(),
  })
  .strict()
  .superRefine((workspace, context) => {
    const ids = new Set<string>();
    for (const [index, source] of workspace.sources.entries()) {
      if (ids.has(source.id)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate source id: ${source.id}`,
          path: ['sources', index, 'id'],
        });
      }
      ids.add(source.id);
    }
    if (workspace.execution.sourceId) {
      const selected = workspace.sources.find(
        (source) => source.id === workspace.execution.sourceId,
      );
      if (!selected) {
        context.addIssue({
          code: 'custom',
          message: 'Execution source does not exist',
          path: ['execution', 'sourceId'],
        });
      } else if (selected.sourceType !== 'folder') {
        context.addIssue({
          code: 'custom',
          message: 'Execution source must be a folder',
          path: ['execution', 'sourceId'],
        });
      }
    }
  });
export type ProjectWorkspace = z.infer<typeof ProjectWorkspaceSchema>;

export const WorkspaceUpdateSchema = z
  .object({
    execution: z
      .object({
        mode: WorkspaceModeSchema.optional(),
        modelConfig: ModelConfigSchema.nullable().optional(),
        sourceId: z
          .string()
          .regex(SOURCE_ID)
          .refine((id) => id !== 'home')
          .nullable()
          .optional(),
      })
      .strict()
      .optional(),
    memory: ProjectMemoryBudgetSchema.partial().optional(),
  })
  .strict();
export type WorkspaceUpdate = z.infer<typeof WorkspaceUpdateSchema>;

export function projectWorkspaceDefaults(): ProjectWorkspace {
  return { version: 1, execution: { mode: 'default' }, sources: [] };
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

export const CreateDataSourceSchema = z
  .object({
    uri: z.string().min(1),
    label: z.string().min(1),
    description: z.string().optional(),
    sourceType: z.enum(['gdrive', 'file', 'url', 'other', 'folder']),
    contextFiles: z
      .array(z.string().refine(isSafeContextFile, 'Context file must be relative'))
      .optional(),
  })
  .strict()
  .superRefine((source, context) => {
    if (source.sourceType !== 'folder' && source.contextFiles !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Only folder sources may define context files',
        path: ['contextFiles'],
      });
    }
  });
export type CreateDataSourceInput = z.infer<typeof CreateDataSourceSchema>;

export const UpdateDataSourceSchema = z
  .object({
    uri: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
    description: z.string().optional(),
    sourceType: z.enum(['gdrive', 'file', 'url', 'other', 'folder']).optional(),
    contextFiles: z
      .array(z.string().refine(isSafeContextFile, 'Context file must be relative'))
      .optional(),
  })
  .strict();
export type UpdateDataSourceInput = z.infer<typeof UpdateDataSourceSchema>;

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
