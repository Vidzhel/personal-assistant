import { z } from 'zod';

const MAX_RESULT_BYTES = 65_536;
const MAX_ID_LENGTH = 256;
const MAX_DETAILS_LENGTH = 4_096;

export const TickTickOperationSchema = z.enum([
  'create-task',
  'update-task',
  'complete-task',
  'delete-task',
]);

const TickTickMutationEvidenceSchema = z
  .object({
    operation: TickTickOperationSchema,
    outcome: z.enum(['verified', 'uncertain', 'failed']),
    taskId: z.string().min(1).max(MAX_ID_LENGTH),
    projectId: z.string().min(1).max(MAX_ID_LENGTH),
    details: z.string().max(MAX_DETAILS_LENGTH).optional(),
  })
  .strict();

export type TickTickOperation = z.infer<typeof TickTickOperationSchema>;
export type TickTickMutationEvidence = z.infer<typeof TickTickMutationEvidenceSchema>;

interface ExpectedMutation {
  operation: TickTickOperation;
  taskId?: string;
  projectId?: string;
}

function parseExactJson(text: string): unknown {
  if (Buffer.byteLength(text, 'utf8') > MAX_RESULT_BYTES) {
    throw new Error('TickTick mutation evidence exceeds its bound');
  }
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  return JSON.parse(fenced?.[1] ?? trimmed);
}

export function parseTickTickMutationEvidence(
  text: string | undefined,
  expected: ExpectedMutation,
): TickTickMutationEvidence | null {
  if (!text) return null;
  try {
    const parsed = TickTickMutationEvidenceSchema.safeParse(parseExactJson(text));
    if (!parsed.success || parsed.data.operation !== expected.operation) return null;
    if (expected.taskId && parsed.data.taskId !== expected.taskId) return null;
    if (expected.projectId && parsed.data.projectId !== expected.projectId) return null;
    return parsed.data;
  } catch {
    return null;
  }
}
