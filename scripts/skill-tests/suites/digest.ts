import type { SkillTestSuite, TestCase, TestResult } from '../types.ts';
import type { RavenSkill } from '../../../packages/shared/src/types/skills.ts';
import { createMockContext } from '../mock-context.ts';

export function createDigestSuite(skill: RavenSkill): SkillTestSuite {
  const tests: TestCase[] = [
    {
      name: 'Skill loads and initializes',
      description: 'Initialize, verify manifest has agent-definition capability',
      level: 'init',
      async run(): Promise<TestResult> {
        const ctx = createMockContext();
        await skill.initialize(ctx);
        const hasAgent = skill.manifest.capabilities.includes('agent-definition');
        if (!hasAgent) {
          return { passed: false, durationMs: 0, message: 'Missing agent-definition capability' };
        }
        return { passed: true, durationMs: 0, message: `Capabilities: ${skill.manifest.capabilities.join(', ')}` };
      },
    },
    {
      name: 'No MCP servers declared',
      description: 'getMcpServers() returns empty object',
      level: 'init',
      async run(): Promise<TestResult> {
        const ctx = createMockContext();
        await skill.initialize(ctx);
        const servers = skill.getMcpServers();
        const keys = Object.keys(servers);
        if (keys.length > 0) {
          return { passed: false, durationMs: 0, message: `Unexpected MCP servers: ${keys.join(', ')}` };
        }
        return { passed: true, durationMs: 0, message: 'No MCP servers (as expected)' };
      },
    },
    {
      name: 'No agent definitions (delegates via orchestrator)',
      description: 'getAgentDefinitions() returns empty object',
      level: 'init',
      async run(): Promise<TestResult> {
        const ctx = createMockContext();
        await skill.initialize(ctx);
        const agents = skill.getAgentDefinitions();
        const keys = Object.keys(agents);
        if (keys.length > 0) {
          return { passed: false, durationMs: 0, message: `Unexpected agents: ${keys.join(', ')}` };
        }
        return { passed: true, durationMs: 0, message: 'No agent definitions (as expected)' };
      },
    },
    {
      name: 'Schedule declared',
      description: 'manifest.defaultSchedules includes morning-digest with cron 0 8 * * *',
      level: 'init',
      async run(): Promise<TestResult> {
        const schedules = skill.manifest.defaultSchedules ?? [];
        const digest = schedules.find((s) => s.id === 'morning-digest');
        if (!digest) {
          return { passed: false, durationMs: 0, message: 'No morning-digest schedule found' };
        }
        if (digest.cron !== '0 8 * * *') {
          return { passed: false, durationMs: 0, message: `Expected cron "0 8 * * *", got "${digest.cron}"` };
        }
        return { passed: true, durationMs: 0, message: `Schedule: ${digest.name} (${digest.cron})` };
      },
    },
    {
      name: 'handleScheduledTask returns valid payload',
      description: 'Call handleScheduledTask("morning-digest"), verify AgentTaskPayload with prompt',
      level: 'init',
      async run(): Promise<TestResult> {
        const ctx = createMockContext();
        await skill.initialize(ctx);
        const payload = await skill.handleScheduledTask('morning-digest', ctx);
        if (!payload) {
          return { passed: false, durationMs: 0, message: 'handleScheduledTask returned undefined' };
        }
        if (!payload.prompt) {
          return { passed: false, durationMs: 0, message: 'Payload missing prompt' };
        }
        if (!payload.taskId) {
          return { passed: false, durationMs: 0, message: 'Payload missing taskId' };
        }
        const mentionsTickTick = payload.prompt.includes('ticktick-agent');
        const mentionsGmail = payload.prompt.includes('gmail-agent');
        if (!mentionsTickTick || !mentionsGmail) {
          return {
            passed: false,
            durationMs: 0,
            message: `Prompt should mention ticktick-agent and gmail-agent`,
          };
        }
        return { passed: true, durationMs: 0, message: 'Valid payload with sub-agent references' };
      },
    },
  ];

  return {
    skillName: 'digest',
    displayName: 'Digest',
    tests,
  };
}
