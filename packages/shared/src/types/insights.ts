import { z } from 'zod';

export const InsightStatusSchema = z.enum(['pending', 'queued', 'delivered', 'acted', 'dismissed']);
export type InsightStatus = z.infer<typeof InsightStatusSchema>;

export const InsightSchema = z.object({
  id: z.string(),
  patternKey: z.string(),
  title: z.string(),
  body: z.string(),
  confidence: z.number().min(0).max(1),
  status: InsightStatusSchema,
  serviceSources: z.array(z.string()),
  suppressionHash: z.string(),
  createdAt: z.string(),
  deliveredAt: z.string().nullable(),
  dismissedAt: z.string().nullable(),
});

export type Insight = z.infer<typeof InsightSchema>;

export const InsightGeneratedPayloadSchema = z.object({
  insightId: z.string(),
  patternKey: z.string(),
  title: z.string(),
  confidence: z.number(),
  serviceSources: z.array(z.string()),
});

export type InsightGeneratedPayload = z.infer<typeof InsightGeneratedPayloadSchema>;

export const InsightQueuedPayloadSchema = z.object({
  insightId: z.string(),
  patternKey: z.string(),
});

export type InsightQueuedPayload = z.infer<typeof InsightQueuedPayloadSchema>;

export const InsightSuppressedPayloadSchema = z.object({
  insightId: z.string(),
  patternKey: z.string(),
  reason: z.enum(['duplicate', 'low-confidence']),
});

export type InsightSuppressedPayload = z.infer<typeof InsightSuppressedPayloadSchema>;

export const AgentInsightSchema = z.object({
  patternKey: z.string(),
  title: z.string(),
  body: z.string(),
  confidence: z.number().min(0).max(1),
  serviceSources: z.array(z.string()),
  keyFacts: z.array(z.string()),
});

export type AgentInsight = z.infer<typeof AgentInsightSchema>;

export const AgentInsightResultSchema = z.object({
  insights: z.array(AgentInsightSchema),
});

export type AgentInsightResult = z.infer<typeof AgentInsightResultSchema>;
