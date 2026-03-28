import type { z } from 'zod';

import type {
  McpDefinitionSchema,
  SkillConfigSchema,
  LibraryIndexSchema,
  SkillIndexEntrySchema,
  McpIndexEntrySchema,
} from '../library/schemas.ts';

// --- Inferred types from Zod schemas ---

export type McpDefinition = z.infer<typeof McpDefinitionSchema>;
export type SkillConfig = z.infer<typeof SkillConfigSchema>;
export type LibraryIndex = z.infer<typeof LibraryIndexSchema>;
export type SkillIndexEntry = z.infer<typeof SkillIndexEntrySchema>;
export type McpIndexEntry = z.infer<typeof McpIndexEntrySchema>;

// --- Loaded types (runtime) ---

export interface LoadedSkill {
  config: SkillConfig;
  skillMd: string;
  path: string;
  domain: string;
}

export interface LoadedLibrary {
  skills: Map<string, LoadedSkill>;
  mcps: Map<string, McpDefinition>;
  vendorPaths: Map<string, string>;
  index: LibraryIndex;
}
