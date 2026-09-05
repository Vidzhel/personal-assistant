import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildScaffoldTools } from '../../../mcp-server/tools/scaffold.ts';
import type { RavenMcpDeps } from '../../../mcp-server/types.ts';
import type { ScopeContext } from '../../../mcp-server/scope.ts';

describe('buildScaffoldTools', () => {
  let deps: RavenMcpDeps;
  let scope: ScopeContext;
  let scaffoldAndActivate: ReturnType<typeof vi.fn>;
  let reloadRegistries: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    scaffoldAndActivate = vi.fn().mockResolvedValue({ path: '/repo/thing.yaml', live: true });
    reloadRegistries = vi
      .fn()
      .mockResolvedValue({ project: true, template: true, library: true, schedule: true });
    deps = {
      eventBus: { emit: vi.fn() } as never,
      scaffoldAndActivate,
      reloadRegistries,
    } as unknown as RavenMcpDeps;
    scope = { role: 'chat' };
  });

  it('describes autonomous yellow actions and approval-required red actions truthfully', () => {
    const definition = buildScaffoldTools(deps, scope).find(
      (tool) => tool.name === 'create_skill',
    )!;
    expect(definition.description).toContain(
      'yellow tier (autonomous with audit and notification)',
    );
    expect(definition.description).toContain(
      'red tier (requires explicit approval before running)',
    );
    expect(definition.description).not.toContain('fully autonomous, high-risk');
  });

  describe('create_template', () => {
    it('calls scaffoldAndActivate with kind=template and the given tasks', async () => {
      const tools = buildScaffoldTools(deps, scope);
      const tool = tools.find((t) => t.name === 'create_template')!;

      const result = await tool.handler(
        {
          name: 'morning-plan',
          displayName: 'Morning Plan',
          tasks: [
            { id: 'step-1', title: 'Fetch mail', agent: 'gmail', prompt: 'Fetch new mail' },
            {
              id: 'step-2',
              title: 'Summarize',
              agent: 'digest',
              prompt: 'Summarize',
              blockedBy: ['step-1'],
            },
          ],
        },
        {},
      );

      expect(scaffoldAndActivate).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'template',
          input: expect.objectContaining({
            projectPath: '',
            template: expect.objectContaining({
              name: 'morning-plan',
              tasks: expect.arrayContaining([
                expect.objectContaining({ id: 'step-1', type: 'agent', agent: 'gmail' }),
              ]),
            }),
          }),
        }),
      );
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content[0] as { text: string }).text);
      expect(parsed.live).toBe(true);
    });

    it('returns an error result when scaffoldAndActivate is unavailable', async () => {
      deps.scaffoldAndActivate = undefined;
      const tools = buildScaffoldTools(deps, scope);
      const tool = tools.find((t) => t.name === 'create_template')!;

      const result = await tool.handler(
        { name: 'x', displayName: 'X', tasks: [{ id: 'a', title: 'A', prompt: 'do it' }] },
        {},
      );

      expect(result.isError).toBe(true);
    });

    it('surfaces a thrown validation error as an error result', async () => {
      scaffoldAndActivate.mockRejectedValue(
        new Error('Template name must be lowercase kebab-case'),
      );
      const tools = buildScaffoldTools(deps, scope);
      const tool = tools.find((t) => t.name === 'create_template')!;

      const result = await tool.handler(
        { name: 'x', displayName: 'X', tasks: [{ id: 'a', title: 'A', prompt: 'do it' }] },
        {},
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toContain('kebab-case');
    });
  });

  describe('create_schedule', () => {
    it('calls scaffoldAndActivate with kind=schedule and global scope', async () => {
      const tools = buildScaffoldTools(deps, scope);
      const tool = tools.find((t) => t.name === 'create_schedule')!;

      const result = await tool.handler(
        { name: 'daily-check', cron: '0 8 * * *', kind: 'job', target: 'task-archival' },
        {},
      );

      expect(scaffoldAndActivate).toHaveBeenCalledWith({
        kind: 'schedule',
        input: {
          projectPath: '',
          schedule: {
            name: 'daily-check',
            cron: '0 8 * * *',
            timezone: 'UTC',
            enabled: true,
            run: { kind: 'job', ref: 'task-archival' },
          },
        },
      });
      expect(result.isError).toBeFalsy();
    });

    // F1: the tool must surface scaffoldingApi's cron/timezone rejection as
    // an error result rather than let it bubble as an unhandled rejection —
    // the model needs the error text back to retry with a valid cron, and
    // this proves nothing about "success" leaks through when the write
    // never happened.
    it('surfaces an invalid-cron rejection from scaffoldAndActivate as an error result', async () => {
      scaffoldAndActivate.mockRejectedValue(
        new Error('Invalid cron "not a cron" or timezone "UTC" for schedule "daily-check": boom'),
      );
      const tools = buildScaffoldTools(deps, scope);
      const tool = tools.find((t) => t.name === 'create_schedule')!;

      const result = await tool.handler(
        { name: 'daily-check', cron: 'not a cron', kind: 'job', target: 'task-archival' },
        {},
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toContain('Invalid cron');
    });
  });

  describe('create_skill', () => {
    it('calls scaffoldAndActivate with kind=skill, capping actions to green/yellow', async () => {
      const tools = buildScaffoldTools(deps, scope);
      const tool = tools.find((t) => t.name === 'create_skill')!;

      const result = await tool.handler(
        {
          domain: 'productivity',
          name: 'quick-notes',
          displayName: 'Quick Notes',
          description: 'Jots down quick notes',
          skillMd: '# Quick Notes\n\nJot it down.',
          actions: [
            {
              name: 'quick-notes:save',
              description: 'Saves a note',
              defaultTier: 'yellow',
              reversible: true,
            },
          ],
        },
        {},
      );

      expect(scaffoldAndActivate).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'skill',
          input: expect.objectContaining({
            domain: 'productivity',
            skillMd: expect.stringContaining('Quick Notes'),
            skill: expect.objectContaining({
              name: 'quick-notes',
              actions: [
                expect.objectContaining({ name: 'quick-notes:save', defaultTier: 'yellow' }),
              ],
            }),
          }),
        }),
      );
      expect(result.isError).toBeFalsy();
    });

    it('surfaces the red-tier rejection from scaffoldAndActivate as an error result', async () => {
      // The tool's own zod schema already types defaultTier as
      // z.enum(['green', 'yellow']) — 'red' is not a representable value
      // for a real SDK-validated call. The actual enforcement this test
      // exercises is defense-in-depth: scaffoldingApi.createSkill (see
      // scaffold-and-activate.test.ts) rejects red regardless of caller,
      // and this tool must surface that rejection rather than swallow it.
      scaffoldAndActivate.mockRejectedValue(
        new Error('Tool-created skills cannot set action "risky:wipe" to red tier'),
      );
      const tools = buildScaffoldTools(deps, scope);
      const tool = tools.find((t) => t.name === 'create_skill')!;

      const result = await tool.handler(
        {
          domain: 'productivity',
          name: 'risky',
          displayName: 'Risky',
          description: 'desc',
          skillMd: '# Risky',
        },
        {},
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toContain('red tier');
    });
  });

  describe('reload_registries', () => {
    it('calls deps.reloadRegistries and returns its result', async () => {
      const tools = buildScaffoldTools(deps, scope);
      const tool = tools.find((t) => t.name === 'reload_registries')!;

      const result = await tool.handler({}, {});

      expect(reloadRegistries).toHaveBeenCalledOnce();
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content[0] as { text: string }).text);
      expect(parsed.schedule).toBe(true);
    });

    it('returns an error result when reloadRegistries is unavailable', async () => {
      deps.reloadRegistries = undefined;
      const tools = buildScaffoldTools(deps, scope);
      const tool = tools.find((t) => t.name === 'reload_registries')!;

      const result = await tool.handler({}, {});

      expect(result.isError).toBe(true);
    });
  });
});
