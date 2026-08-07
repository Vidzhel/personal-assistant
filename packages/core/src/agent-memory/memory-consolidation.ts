import { createLogger, generateId, gitAutoCommit } from '@raven/shared';
import { z } from 'zod';
import type { AppConfig } from '../config.ts';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { NamedAgentStore } from '../agent-registry/yaml-named-agent-store.ts';
import { runAgentTask } from '../agent-manager/agent-session.ts';
import type { MemoryStore } from './memory-store.ts';
import { resolveMemoryDir } from './memory-store.ts';
import {
  archiveCandidate,
  listPendingCandidates,
  type PendingCandidate,
} from './memory-candidates.ts';

const log = createLogger('memory-consolidation');

const INDEX_FILE = 'MEMORY.md';
/** Deterministic guard: even if the model proposes more, only the first N
 * ops are ever applied per agent per run. Path-traversal / budget guards
 * live one layer down in memory-store.ts (safePath + checkAndWrite) —
 * every op still goes through those regardless of this cap. */
const MAX_CONSOLIDATION_OPS = 10;
const INDEX_LINE_MAX_LENGTH = 120;

/** Named agent `model` tiers ('haiku'|'sonnet'|'opus'|null — see
 * NamedAgentCreateInputSchema) mapped to real model IDs for this one
 * dispatch. 'sonnet' and unset both fall through to config.CLAUDE_MODEL —
 * the same model every other internal dispatch (session-retrospective,
 * knowledge-consolidation) already uses — rather than hardcoding a second
 * sonnet id that could drift from the global default. */
const MODEL_TIER_IDS: Record<string, string> = {
  haiku: 'claude-haiku-4-5',
  opus: 'claude-opus-5',
};

function resolveModel(config: AppConfig, agentModel: string | null): string {
  if (agentModel && agentModel in MODEL_TIER_IDS) return MODEL_TIER_IDS[agentModel];
  return config.CLAUDE_MODEL;
}

const ConsolidationOpSchema = z.object({
  action: z.enum(['create', 'update', 'delete']),
  path: z.string().min(1),
  content: z.string().optional(),
});

const ConsolidationResultSchema = z.object({
  ops: z.array(ConsolidationOpSchema).default([]),
});

type ConsolidationOp = z.infer<typeof ConsolidationOpSchema>;

const CONSOLIDATION_PROMPT_HEADER = `You are a memory consolidation agent. Below is an agent's current durable memory (its MEMORY.md index and the full contents of every memory file) plus a set of newly proposed candidates from recent retrospectives. Decide how to fold the candidates into memory and produce a JSON response matching this schema:
{
  "ops": [
    { "action": "create", "path": "user-preferences.md", "content": "full file content" },
    { "action": "update", "path": "existing-file.md", "content": "full replacement content" },
    { "action": "delete", "path": "stale-file.md" }
  ]
}

Guidelines:
- Never propose an op for MEMORY.md — it is regenerated automatically from whatever files exist after your ops are applied.
- "path" is always a bare filename inside the agent's memory dir (no slashes) — nested paths are rejected.
- Merge a candidate into an existing file when it's a natural fit; create a new small file when it isn't; update rather than duplicate.
- "content" for create/update is the FULL new file content, not a diff.
- Prefer a handful of well-organized files over one per candidate.
- Delete a file only when a candidate clearly supersedes or corrects it.
- Keep files concise — this is a working memory, not an archive.
- Only output valid JSON. No markdown code fences, no explanation.`;

export interface MemoryConsolidationDeps {
  projectsDir: string;
  memoryStore: MemoryStore;
  namedAgentStore: NamedAgentStore;
  eventBus: EventBus;
  config: AppConfig;
}

export interface MemoryConsolidationResult {
  agentsProcessed: number;
  opsApplied: number;
  candidatesArchived: number;
}

export interface MemoryConsolidation {
  runConsolidation: () => Promise<MemoryConsolidationResult>;
}

async function buildPrompt(
  memoryStore: MemoryStore,
  agentName: string,
  candidates: PendingCandidate[],
): Promise<string> {
  const memoryIndex = (await memoryStore.readIndex(agentName)) ?? '(no index yet)';
  const fileNames = (await memoryStore.list(agentName)).filter((f) => f !== INDEX_FILE);

  const fileSections: string[] = [];
  for (const file of fileNames) {
    try {
      fileSections.push(`### ${file}\n${await memoryStore.read(agentName, file)}`);
    } catch (err) {
      log.warn(`Failed to read memory file ${file} for ${agentName}: ${err}`);
    }
  }

  const candidateSections = candidates.map(
    (c, i) => `### Candidate ${i + 1} (${c.frontmatter.source})\n${c.body}`,
  );

  return [
    CONSOLIDATION_PROMPT_HEADER,
    '',
    '## Current MEMORY.md index',
    memoryIndex,
    '',
    '## Current memory files',
    fileSections.length > 0 ? fileSections.join('\n\n') : '(none yet)',
    '',
    '## Pending candidates to incorporate',
    candidateSections.join('\n\n'),
  ].join('\n');
}

/** Apply at most MAX_CONSOLIDATION_OPS ops via memoryStore, skipping any
 * that target MEMORY.md (regenerated separately, never model-authored) or
 * that memoryStore itself rejects (budget, path-traversal, missing file for
 * update/delete — see checkAndWrite/safePath in memory-store.ts). Never
 * throws — a rejected or errored op is logged and simply not counted. */
async function applyOps(
  memoryStore: MemoryStore,
  agentName: string,
  ops: ConsolidationOp[],
): Promise<number> {
  let applied = 0;

  for (const op of ops.slice(0, MAX_CONSOLIDATION_OPS)) {
    if (op.path === INDEX_FILE) {
      log.warn(
        `Consolidation for ${agentName} proposed touching ${INDEX_FILE} directly — skipped (regenerated separately)`,
      );
      continue;
    }

    try {
      const result =
        op.action === 'delete'
          ? await memoryStore.remove(agentName, op.path)
          : op.action === 'create'
            ? await memoryStore.write(agentName, op.path, op.content ?? '')
            : await memoryStore.update(agentName, op.path, op.content ?? '');

      if (result.ok) {
        applied++;
      } else {
        log.warn(
          `Consolidation op ${op.action} ${op.path} for ${agentName} rejected: ${result.error}`,
        );
      }
    } catch (err) {
      log.error(`Consolidation op ${op.action} ${op.path} for ${agentName} failed: ${err}`);
    }
  }

  return applied;
}

/** Rebuild MEMORY.md deterministically from whatever memory files actually
 * exist after ops were applied — the index is never model-authored, so it
 * can't drift from reality or leak a rejected/partial op. */
async function regenerateIndex(memoryStore: MemoryStore, agentName: string): Promise<void> {
  const files = (await memoryStore.list(agentName)).filter((f) => f !== INDEX_FILE).sort();

  const lines: string[] = [];
  for (const file of files) {
    try {
      const content = await memoryStore.read(agentName, file);
      const firstLine =
        content
          .split('\n')
          .find((l) => l.trim().length > 0)
          ?.replace(/^#+\s*/, '')
          .trim() ?? file;
      lines.push(`- **${file}** — ${firstLine.slice(0, INDEX_LINE_MAX_LENGTH)}`);
    } catch {
      lines.push(`- **${file}**`);
    }
  }

  const title = agentName.charAt(0).toUpperCase() + agentName.slice(1);
  const body = lines.length > 0 ? lines.join('\n') : '- (no memories yet)';
  const content = `# ${title} Memory Index\n\n${body}\n`;

  const existing = await memoryStore.readIndex(agentName);
  const result =
    existing !== null
      ? await memoryStore.update(agentName, INDEX_FILE, content)
      : await memoryStore.write(agentName, INDEX_FILE, content);
  if (!result.ok) {
    log.error(`Failed to regenerate ${INDEX_FILE} for ${agentName}: ${result.error}`);
  }
}

interface ProcessAgentResult {
  opsApplied: number;
  candidatesArchived: number;
}

/** Defensive JSON parse of the consolidation agent's raw output — a
 * malformed or non-JSON response yields an empty op list (logged) rather
 * than throwing, so one bad model turn can't take down the whole run. */
function parseConsolidationOps(rawResult: string, agentName: string): ConsolidationOp[] {
  try {
    const parsed = ConsolidationResultSchema.safeParse(JSON.parse(rawResult));
    if (parsed.success) return parsed.data.ops;
    log.warn(
      `Consolidation result for ${agentName} failed schema validation: ${parsed.error.message}`,
    );
  } catch (err) {
    log.warn(`Consolidation result for ${agentName} was not valid JSON: ${err}`);
  }
  return [];
}

async function consolidateAgent(
  deps: MemoryConsolidationDeps,
  agentName: string,
  agentModel: string | null,
): Promise<ProcessAgentResult> {
  const { projectsDir, memoryStore, eventBus, config } = deps;

  const candidates = await listPendingCandidates(projectsDir, agentName);
  if (candidates.length === 0) return { opsApplied: 0, candidatesArchived: 0 };

  log.info(`Consolidating ${candidates.length} candidate(s) for agent ${agentName}`);

  const prompt = await buildPrompt(memoryStore, agentName, candidates);
  const task = {
    id: generateId(),
    skillName: 'memory-consolidation',
    prompt,
    status: 'queued' as const,
    priority: 'low' as const,
    mcpServers: {},
    agentDefinitions: {},
    createdAt: Date.now(),
  };

  const agentResult = await runAgentTask({
    task,
    eventBus,
    mcpServers: {},
    agentDefinitions: {},
    model: resolveModel(config, agentModel),
  });

  const ops = parseConsolidationOps(agentResult.result, agentName);
  const opsApplied = await applyOps(memoryStore, agentName, ops);
  await regenerateIndex(memoryStore, agentName);

  let candidatesArchived = 0;
  for (const candidate of candidates) {
    await archiveCandidate(projectsDir, agentName, candidate.filename);
    candidatesArchived++;
  }

  // Commit the whole memory dir (new/updated/deleted fact files, the
  // regenerated index, and the candidate archive moves) in one shot — same
  // primitive ConfigCommitter uses for agent.yaml, called directly here
  // since ConfigCommitter itself only listens for agent:config:* events
  // (a different resource) and shouldn't be repurposed for memory files.
  await gitAutoCommit(
    [resolveMemoryDir(projectsDir, agentName)],
    `chore(memory): consolidate ${candidates.length} candidate(s) for ${agentName}`,
  );

  return { opsApplied, candidatesArchived };
}

export function createMemoryConsolidation(deps: MemoryConsolidationDeps): MemoryConsolidation {
  const { namedAgentStore } = deps;

  async function runConsolidation(): Promise<MemoryConsolidationResult> {
    const agents = namedAgentStore.listAgents();

    let agentsProcessed = 0;
    let totalOpsApplied = 0;
    let totalCandidatesArchived = 0;

    for (const agent of agents) {
      const { opsApplied, candidatesArchived } = await consolidateAgent(
        deps,
        agent.name,
        agent.model,
      );
      if (candidatesArchived > 0) agentsProcessed++;
      totalOpsApplied += opsApplied;
      totalCandidatesArchived += candidatesArchived;
    }

    log.info(
      `Memory consolidation complete: agents=${agentsProcessed}, ops=${totalOpsApplied}, candidates=${totalCandidatesArchived}`,
    );

    return {
      agentsProcessed,
      opsApplied: totalOpsApplied,
      candidatesArchived: totalCandidatesArchived,
    };
  }

  return { runConsolidation };
}
