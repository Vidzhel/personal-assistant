import type { SkillTestSuite, TestCase, TestResult } from '../types.ts';
import type { RavenSkill } from '../../../packages/shared/src/types/skills.ts';
import { createMockContext } from '../mock-context.ts';

export function createTelegramSuite(skill: RavenSkill): SkillTestSuite {
  const tests: TestCase[] = [
    {
      name: 'Skill loads without bot creds',
      description: 'Initialize without TELEGRAM_BOT_TOKEN, verify no crash and warns',
      level: 'init',
      async run(): Promise<TestResult> {
        const savedToken = process.env.TELEGRAM_BOT_TOKEN;
        const savedChat = process.env.TELEGRAM_CHAT_ID;
        delete process.env.TELEGRAM_BOT_TOKEN;
        delete process.env.TELEGRAM_CHAT_ID;
        try {
          const ctx = createMockContext();
          await skill.initialize(ctx);
          const hasWarn = ctx.logger.messages.some(
            (m) => m.level === 'warn' && m.msg.includes('credentials'),
          );
          if (!hasWarn) {
            return { passed: false, durationMs: 0, message: 'Expected warning about missing credentials' };
          }
          return { passed: true, durationMs: 0, message: 'Initialized with credential warning' };
        } finally {
          if (savedToken) process.env.TELEGRAM_BOT_TOKEN = savedToken;
          if (savedChat) process.env.TELEGRAM_CHAT_ID = savedChat;
        }
      },
    },
    {
      name: 'No MCPs or agent definitions',
      description: 'Both getMcpServers() and getAgentDefinitions() return empty objects',
      level: 'init',
      async run(): Promise<TestResult> {
        const ctx = createMockContext();
        await skill.initialize(ctx);
        const mcpKeys = Object.keys(skill.getMcpServers());
        const agentKeys = Object.keys(skill.getAgentDefinitions());
        if (mcpKeys.length > 0) {
          return { passed: false, durationMs: 0, message: `Unexpected MCP servers: ${mcpKeys.join(', ')}` };
        }
        if (agentKeys.length > 0) {
          return { passed: false, durationMs: 0, message: `Unexpected agents: ${agentKeys.join(', ')}` };
        }
        return { passed: true, durationMs: 0, message: 'No MCPs or agents (as expected)' };
      },
    },
    {
      name: 'Actions declared',
      description: 'getActions() returns send-message and send-notification',
      level: 'init',
      async run(): Promise<TestResult> {
        const ctx = createMockContext();
        await skill.initialize(ctx);
        const actions = skill.getActions();
        const sendMsg = actions.find((a) => a.name === 'telegram:send-message');
        const sendNotif = actions.find((a) => a.name === 'telegram:send-notification');
        if (!sendMsg) {
          return { passed: false, durationMs: 0, message: 'Missing telegram:send-message action' };
        }
        if (!sendNotif) {
          return { passed: false, durationMs: 0, message: 'Missing telegram:send-notification action' };
        }
        return { passed: true, durationMs: 0, message: `${actions.length} actions declared` };
      },
    },
    {
      name: 'Capabilities correct',
      description: 'Manifest has notification-sink and event-source capabilities',
      level: 'init',
      async run(): Promise<TestResult> {
        const caps = skill.manifest.capabilities;
        const hasNotif = caps.includes('notification-sink');
        const hasEvent = caps.includes('event-source');
        if (!hasNotif) {
          return { passed: false, durationMs: 0, message: 'Missing notification-sink capability' };
        }
        if (!hasEvent) {
          return { passed: false, durationMs: 0, message: 'Missing event-source capability' };
        }
        return { passed: true, durationMs: 0, message: `Capabilities: ${caps.join(', ')}` };
      },
    },
  ];

  return {
    skillName: 'telegram',
    displayName: 'Telegram',
    tests,
  };
}
