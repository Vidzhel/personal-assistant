import { z } from 'zod';
import type { KnowledgeSnapshot } from './knowledge-snapshots.ts';

const ConsolidationPlanSchema = z
  .object({
    merges: z
      .array(
        z
          .object({
            keepId: z.string().min(1),
            removeIds: z.array(z.string().min(1)).min(1),
            mergedContent: z.string().trim().min(1),
          })
          .strict(),
      )
      .default([]),
    prunes: z.array(z.string().min(1)).default([]),
    digest: z.string().trim().min(1).optional(),
  })
  .strict();

export type ConsolidationPlan = z.infer<typeof ConsolidationPlanSchema>;
export interface ProjectConsolidationPlan {
  projectId: string;
  snapshots: KnowledgeSnapshot[];
  plan: ConsolidationPlan;
}

export function parseConsolidationPlan(text: string): ConsolidationPlan {
  return ConsolidationPlanSchema.parse(JSON.parse(text));
}

/** Validate every project plan before any project can begin applying mutations. */
export function validateConsolidationPlans(plans: ProjectConsolidationPlan[]): void {
  const touched = new Set<string>();
  for (const { projectId, snapshots, plan } of plans) {
    const selected = new Set(snapshots.map(({ bubble }) => bubble.id));
    const ids = [
      ...plan.merges.flatMap((merge) => [merge.keepId, ...merge.removeIds]),
      ...plan.prunes,
    ];
    for (const id of ids) {
      if (!selected.has(id)) {
        throw new Error(`Consolidation source ${id} is outside selected project ${projectId}`);
      }
      if (touched.has(id)) throw new Error(`Consolidation plan has overlapping source: ${id}`);
      touched.add(id);
    }
  }
}
