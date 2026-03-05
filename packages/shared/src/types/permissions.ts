import { z } from 'zod';

export type PermissionTier = 'green' | 'yellow' | 'red';

export const PermissionTierSchema = z.enum(['green', 'yellow', 'red']);

export const ACTION_NAME_REGEX = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;

export interface SkillAction {
  name: string;
  description: string;
  defaultTier: PermissionTier;
  reversible: boolean;
}

export const SkillActionSchema = z.object({
  name: z.string().regex(ACTION_NAME_REGEX, {
    message: 'Action name must match <skill-name>:<action-name> in kebab-case',
  }),
  description: z.string().min(1),
  defaultTier: PermissionTierSchema,
  reversible: z.boolean(),
});
