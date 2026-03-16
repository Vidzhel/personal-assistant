import { z } from 'zod';

export type PermissionTier = 'green' | 'yellow' | 'red';

export const PermissionTierSchema = z.enum(['green', 'yellow', 'red']);

export type AuditOutcome = 'executed' | 'approved' | 'denied' | 'queued' | 'failed';

export const AuditOutcomeSchema = z.enum(['executed', 'approved', 'denied', 'queued', 'failed']);

export interface AuditEntry {
  id: string;
  timestamp: string;
  skillName: string;
  actionName: string;
  permissionTier: PermissionTier;
  outcome: AuditOutcome;
  details?: string;
  sessionId?: string;
  pipelineName?: string;
}

export interface AuditLogFilter {
  skillName?: string;
  tier?: PermissionTier;
  outcome?: AuditOutcome;
  sessionId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

const MAX_AUDIT_LIMIT = 1000;
const DEFAULT_AUDIT_LIMIT = 100;

export const AuditLogFilterSchema = z.object({
  skillName: z.string().optional(),
  tier: PermissionTierSchema.optional(),
  outcome: AuditOutcomeSchema.optional(),
  sessionId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_AUDIT_LIMIT)
    .optional()
    .default(DEFAULT_AUDIT_LIMIT),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

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

export interface PermissionConfig {
  [actionName: string]: PermissionTier;
}

export const PermissionConfigSchema = z.record(
  z.string().regex(ACTION_NAME_REGEX, {
    message: 'Action name must match <skill-name>:<action-name> in kebab-case',
  }),
  PermissionTierSchema,
);
