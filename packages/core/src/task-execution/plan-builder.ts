import { createLogger, TaskTreeNodeSchema, type TaskTreeNode } from '@raven/shared';

const log = createLogger('plan-builder');

// ── Types ──────────────────────────────────────────────────────────────

export interface TriageResult {
  mode: 'direct' | 'delegated' | 'planned';
  planDescription?: string;
  taskTree?: TaskTreeNode[];
}

// ── Triage instruction builder ─────────────────────────────────────────

export function buildTriageInstructions(
  availableAgents: string[],
  availableTemplates: string[],
): string {
  const agentList = availableAgents.length > 0 ? availableAgents.join(', ') : 'none';
  const templateList = availableTemplates.length > 0 ? availableTemplates.join(', ') : 'none';

  return [
    '## Execution Mode Classification',
    '',
    'Before responding, classify this request into one of three modes:',
    '',
    '**DIRECT** — Simple queries, lookups, casual chat. Answer immediately with a single agent call.',
    'Examples: "What\'s on my schedule today?", "Summarize this email", "What\'s the weather?"',
    '',
    '**DELEGATED** — Substantial single-agent work. One agent handles it but it\'s non-trivial.',
    'Examples: "Triage my inbox", "Write a report on X", "Process this document"',
    '',
    '**PLANNED** — Multi-step work needing multiple agents or complex coordination.',
    'Examples: "Prepare me for tomorrow\'s exam", "Set up my weekly review", "Research X and create a presentation"',
    '',
    'For DIRECT and DELEGATED: proceed normally — answer the user\'s question.',
    'For PLANNED: respond with a structured plan in this EXACT format:',
    '',
    'EXECUTION_MODE: PLANNED',
    'PLAN_DESCRIPTION: One sentence describing the plan',
    'TASK_TREE:',
    '```json',
    '[',
    '  { "id": "step-1", "title": "...", "type": "agent", "agent": "agent-name", "prompt": "...", "blockedBy": [] },',
    '  { "id": "step-2", "title": "...", "type": "agent", "agent": "agent-name", "prompt": "...", "blockedBy": ["step-1"] },',
    '  { "id": "notify", "title": "Send summary", "type": "notify", "channel": "telegram", "message": "...", "blockedBy": ["step-2"] }',
    ']',
    '```',
    '',
    `Available agents: ${agentList}`,
    `Available templates: ${templateList}`,
    '',
    'Most requests are DIRECT. Only use PLANNED for genuinely multi-step work.',
  ].join('\n');
}

// ── Response parser ────────────────────────────────────────────────────

const PLANNED_MODE_MARKER = 'EXECUTION_MODE: PLANNED';
const PLAN_DESCRIPTION_PREFIX = 'PLAN_DESCRIPTION:';

export function parseTriageResponse(response: string): TriageResult {
  // Default: direct mode (backward compatible)
  if (!response.includes(PLANNED_MODE_MARKER)) {
    return { mode: 'direct' };
  }

  // Extract plan description
  let planDescription: string | undefined;
  const descriptionMatch = response.match(
    new RegExp(`${PLAN_DESCRIPTION_PREFIX}\\s*(.+?)(?:\\n|$)`),
  );
  if (descriptionMatch) {
    planDescription = descriptionMatch[1].trim();
  }

  // Extract JSON task tree from the response
  const taskTree = extractTaskTree(response);
  if (!taskTree) {
    log.warn('PLANNED response detected but task tree parsing failed, defaulting to direct');
    return { mode: 'direct' };
  }

  return {
    mode: 'planned',
    planDescription,
    taskTree,
  };
}

// ── Internal helpers ───────────────────────────────────────────────────

function extractTaskTree(response: string): TaskTreeNode[] | undefined {
  // Try to find JSON in a code block first
  const codeBlockMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const jsonStr = codeBlockMatch ? codeBlockMatch[1].trim() : extractBareJson(response);

  if (!jsonStr) return undefined;

  try {
    const parsed: unknown = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) {
      log.warn('Task tree JSON is not an array');
      return undefined;
    }

    return validateTaskTreeNodes(parsed);
  } catch (err) {
    log.warn(`Task tree JSON parse failed: ${err}`);
    return undefined;
  }
}

function extractBareJson(response: string): string | undefined {
  // Look for a JSON array after "TASK_TREE:" marker
  const markerIdx = response.indexOf('TASK_TREE:');
  if (markerIdx === -1) return undefined;

  const afterMarker = response.slice(markerIdx + 'TASK_TREE:'.length).trim();
  const bracketStart = afterMarker.indexOf('[');
  if (bracketStart === -1) return undefined;

  // Find the matching closing bracket
  let depth = 0;
  for (let i = bracketStart; i < afterMarker.length; i++) {
    if (afterMarker[i] === '[') depth++;
    if (afterMarker[i] === ']') depth--;
    if (depth === 0) {
      return afterMarker.slice(bracketStart, i + 1);
    }
  }

  return undefined;
}

function validateTaskTreeNodes(nodes: unknown[]): TaskTreeNode[] | undefined {
  const validated: TaskTreeNode[] = [];

  for (const node of nodes) {
    const result = TaskTreeNodeSchema.safeParse(node);
    if (result.success) {
      validated.push(result.data);
    } else {
      log.warn(`Invalid task tree node: ${JSON.stringify(result.error.issues)}`);
      return undefined;
    }
  }

  if (validated.length === 0) {
    return undefined;
  }

  return validated;
}
