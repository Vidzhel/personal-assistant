import { ModelIdSchema } from '@raven/shared';
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { RavenMcpDeps } from '../types.ts';
import type { ScopeContext } from '../scope.ts';

const KEBAB_CASE_RE = /^[a-z][a-z0-9-]*$/;
const DEFAULT_SKILL_MAX_TURNS = 10;

type OkResult = { content: [{ type: 'text'; text: string }] };
type ErrResult = { content: [{ type: 'text'; text: string }]; isError: true };

const okResult = (data: unknown): OkResult => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
});

const errorResult = (message: string): ErrResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The extension tools: "Raven, learn to do X" in chat -> a live,
 * git-committed artifact, no restart. Every write goes through
 * `deps.scaffoldAndActivate` (scaffolding/scaffold-and-activate.ts) — the
 * one path per artifact kind that validates, writes, reloads the affected
 * registry, and commits. Tools here never touch the filesystem directly.
 *
 * See mcp-server/tools/system.ts for create_agent/update_agent, which
 * already hot-reload + commit via namedAgentStore's own event path.
 */
// eslint-disable-next-line max-lines-per-function -- builds four extension tools (template/schedule/skill/reload)
export function buildScaffoldTools(
  deps: RavenMcpDeps,
  _scope: ScopeContext,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK type erasure at heterogeneous tool collection (see system.ts's comment)
): Array<SdkMcpToolDefinition<any>> {
  const createTemplate = tool(
    'create_template',
    'Create a new task template — a reusable, named multi-step plan of agent steps that Raven can run on demand or wire to a schedule. Use this when the owner asks Raven to learn a repeatable multi-step workflow ("every time X happens, do A then B then C").',
    {
      name: z
        .string()
        .regex(KEBAB_CASE_RE, 'Must be kebab-case')
        .describe('Template name (kebab-case)'),
      displayName: z.string().min(1).describe('Human-readable name'),
      description: z.string().optional().describe('What this template does'),
      approval: z
        .enum(['auto', 'manual'])
        .optional()
        .describe('Whether a run needs manual approval before executing (default manual)'),
      tasks: z
        .array(
          z.object({
            id: z.string().min(1).describe('Unique step id within this template'),
            title: z.string().min(1),
            agent: z.string().optional().describe('Named agent that runs this step'),
            prompt: z.string().min(1).describe('Instructions for the agent running this step'),
            blockedBy: z
              .array(z.string())
              .optional()
              .describe('Step ids that must complete before this one starts'),
          }),
        )
        .min(1)
        .describe('Ordered/dependent steps that make up the plan'),
    },
    async (args) => {
      if (!deps.scaffoldAndActivate) return errorResult('scaffoldAndActivate not available');
      try {
        const result = await deps.scaffoldAndActivate({
          kind: 'template',
          input: {
            projectPath: '',
            template: {
              name: args.name,
              displayName: args.displayName,
              description: args.description,
              params: {},
              trigger: [{ type: 'manual' }],
              plan: { approval: args.approval ?? 'manual', parallel: true },
              tasks: args.tasks.map((t) => ({
                id: t.id,
                title: t.title,
                type: 'agent' as const,
                agent: t.agent,
                prompt: t.prompt,
                blockedBy: t.blockedBy ?? [],
              })),
            } as never,
          },
        });
        return okResult({ name: args.name, ...result });
      } catch (err) {
        return errorResult(toErrorMessage(err));
      }
    },
  );

  const createSchedule = tool(
    'create_schedule',
    'Create a new recurring schedule that runs a job or template on a cron. Use this when the owner asks Raven to do something on a recurring basis ("every morning at 8", "every Monday at noon"). Writes to the global schedule set, which is live-scheduled immediately.',
    {
      name: z
        .string()
        .regex(KEBAB_CASE_RE, 'Must be kebab-case')
        .describe('Schedule name (kebab-case)'),
      cron: z.string().min(1).describe('Cron expression, e.g. "0 8 * * *"'),
      timezone: z.string().optional().describe('IANA timezone (default UTC)'),
      kind: z.enum(['job', 'template']).describe('What the schedule runs'),
      target: z.string().min(1).describe('The job name or template name to run'),
      enabled: z
        .boolean()
        .optional()
        .describe('Whether the schedule starts enabled (default true)'),
    },
    async (args) => {
      if (!deps.scaffoldAndActivate) return errorResult('scaffoldAndActivate not available');
      try {
        const result = await deps.scaffoldAndActivate({
          kind: 'schedule',
          input: {
            projectPath: '',
            schedule: {
              name: args.name,
              cron: args.cron,
              timezone: args.timezone ?? 'UTC',
              enabled: args.enabled ?? true,
              run: { kind: args.kind, ref: args.target },
            } as never,
          },
        });
        return okResult({ name: args.name, ...result });
      } catch (err) {
        return errorResult(toErrorMessage(err));
      }
    },
  );

  const createSkill = tool(
    'create_skill',
    'Add a new skill to the capability library — a reusable capability agents can be given (optionally backed by existing MCP tools). Use this when the owner asks Raven to "learn" a new capability. Actions declared here are capped at yellow tier (autonomous with audit and notification) — red tier (requires explicit approval before running) is deliberately unavailable from chat and requires the owner to edit the skill\'s config.json directly.',
    {
      domain: z
        .string()
        .regex(KEBAB_CASE_RE, 'Must be kebab-case')
        .describe('Domain/category folder under library/skills/, e.g. "productivity"'),
      name: z
        .string()
        .regex(KEBAB_CASE_RE, 'Must be kebab-case')
        .describe('Skill name (kebab-case)'),
      displayName: z.string().min(1),
      description: z.string().min(1),
      skillMd: z
        .string()
        .min(1)
        .describe('skill.md body — instructions an agent reads when using this skill'),
      mcps: z
        .array(z.string())
        .optional()
        .describe('Names of existing library MCPs this skill needs (must already exist)'),
      tools: z
        .array(z.string())
        .optional()
        .describe('Built-in tool names this skill needs (e.g. "Read", "Glob")'),
      model: ModelIdSchema.optional(),
      actions: z
        .array(
          z.object({
            name: z.string().describe('Action name in "skill:action" format'),
            description: z.string().min(1),
            defaultTier: z
              .enum(['green', 'yellow'])
              .describe('Capped at yellow — red requires an owner file edit'),
            reversible: z.boolean(),
          }),
        )
        .optional(),
    },
    async (args) => {
      if (!deps.scaffoldAndActivate) return errorResult('scaffoldAndActivate not available');
      try {
        const result = await deps.scaffoldAndActivate({
          kind: 'skill',
          input: {
            domain: args.domain,
            skill: {
              name: args.name,
              displayName: args.displayName,
              description: args.description,
              mcps: args.mcps ?? [],
              vendorSkills: [],
              tools: args.tools ?? [],
              systemDeps: [],
              model: args.model ?? 'sonnet',
              maxTurns: DEFAULT_SKILL_MAX_TURNS,
              actions: args.actions ?? [],
              expectedOutputs: [],
            } as never,
            skillMd: args.skillMd,
          },
        });
        return okResult({ name: args.name, domain: args.domain, ...result });
      } catch (err) {
        return errorResult(toErrorMessage(err));
      }
    },
  );

  const reloadRegistries = tool(
    'reload_registries',
    'Manually reload the project, template, and skill-library registries (and re-sync the schedule engine) from disk, without restarting Raven. Rarely needed — the create_* tools already reload automatically after writing. Use this only if files changed outside of chat need to be picked up.',
    {},
    async () => {
      if (!deps.reloadRegistries) return errorResult('reloadRegistries not available');
      try {
        const result = await deps.reloadRegistries();
        return okResult(result);
      } catch (err) {
        return errorResult(toErrorMessage(err));
      }
    },
    {
      annotations: {
        idempotentHint: true,
      },
    },
  );

  return [createTemplate, createSchedule, createSkill, reloadRegistries];
}
