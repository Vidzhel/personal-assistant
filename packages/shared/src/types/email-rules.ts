import { z } from 'zod';

export const EmailTriageMatchSchema = z.object({
  from: z.array(z.string()).optional(),
  subject: z.array(z.string()).optional(),
  has: z.array(z.string()).optional(),
});

export const EmailTriageActionsSchema = z.object({
  archive: z.boolean().optional(),
  label: z.string().optional(),
  markRead: z.boolean().optional(),
  flag: z.enum(['urgent', 'important']).optional(),
  extractActions: z.boolean().optional(),
});

export const EmailTriageRuleSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  match: EmailTriageMatchSchema,
  actions: EmailTriageActionsSchema,
  enabled: z.boolean().default(true),
  priority: z.number().default(10),
});

export const EmailTriageConfigSchema = z.object({
  rules: z.array(EmailTriageRuleSchema),
  matchMode: z.enum(['first', 'all']).default('all'),
  enabled: z.boolean().default(true),
});

export type EmailTriageMatch = z.infer<typeof EmailTriageMatchSchema>;
export type EmailTriageActions = z.infer<typeof EmailTriageActionsSchema>;
export type EmailTriageRule = z.infer<typeof EmailTriageRuleSchema>;
export type EmailTriageConfig = z.infer<typeof EmailTriageConfigSchema>;
