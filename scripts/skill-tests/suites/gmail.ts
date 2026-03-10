import type { SkillTestSuite, TestCase, TestResult } from '../types.ts';
import type { RavenSkill } from '../../../packages/shared/src/types/skills.ts';
import { createMockContext } from '../mock-context.ts';
import { testMcpConnection } from '../mcp-tester.ts';

export function createGmailSuite(skill: RavenSkill): SkillTestSuite {
  const tests: TestCase[] = [
    {
      name: 'Skill loads without IMAP creds',
      description: 'Initialize without IMAP env vars, verify no crash and warns about missing creds',
      level: 'init',
      async run(): Promise<TestResult> {
        // Clear IMAP env vars for this test
        const savedUser = process.env.GMAIL_IMAP_USER;
        const savedPass = process.env.GMAIL_IMAP_PASSWORD;
        delete process.env.GMAIL_IMAP_USER;
        delete process.env.GMAIL_IMAP_PASSWORD;
        try {
          const ctx = createMockContext({ watchFolders: ['INBOX'] });
          await skill.initialize(ctx);
          const hasWarn = ctx.logger.messages.some(
            (m) => m.level === 'warn' && m.msg.includes('credentials'),
          );
          if (!hasWarn) {
            return { passed: false, durationMs: 0, message: 'Expected warning about missing credentials' };
          }
          return { passed: true, durationMs: 0, message: 'Initialized with credential warning' };
        } finally {
          if (savedUser) process.env.GMAIL_IMAP_USER = savedUser;
          if (savedPass) process.env.GMAIL_IMAP_PASSWORD = savedPass;
        }
      },
    },
    {
      name: 'MCP server declares gmail key',
      description: 'getMcpServers() returns gmail with npx command',
      level: 'init',
      async run(): Promise<TestResult> {
        const ctx = createMockContext();
        await skill.initialize(ctx);
        const servers = skill.getMcpServers();
        if (!servers.gmail) {
          return { passed: false, durationMs: 0, message: 'No "gmail" MCP server declared' };
        }
        if (servers.gmail.command !== 'npx') {
          return { passed: false, durationMs: 0, message: `Expected command "npx", got "${servers.gmail.command}"` };
        }
        return { passed: true, durationMs: 0, message: `Command: ${servers.gmail.command} ${servers.gmail.args.join(' ')}` };
      },
    },
    {
      name: 'Agent definitions declared',
      description: 'getAgentDefinitions() returns gmail-agent',
      level: 'init',
      async run(): Promise<TestResult> {
        const ctx = createMockContext();
        await skill.initialize(ctx);
        const agents = skill.getAgentDefinitions();
        const agent = agents['gmail-agent'];
        if (!agent) {
          return { passed: false, durationMs: 0, message: 'No "gmail-agent" defined' };
        }
        if (!agent.description) {
          return { passed: false, durationMs: 0, message: 'Agent missing description' };
        }
        return { passed: true, durationMs: 0, message: 'gmail-agent declared' };
      },
    },
    {
      name: 'Actions include all tiers',
      description: 'Verify green (search-emails), yellow (archive-email), red (send-email) present',
      level: 'init',
      async run(): Promise<TestResult> {
        const ctx = createMockContext();
        await skill.initialize(ctx);
        const actions = skill.getActions();
        const search = actions.find((a) => a.name === 'gmail:search-emails');
        const archive = actions.find((a) => a.name === 'gmail:archive-email');
        const send = actions.find((a) => a.name === 'gmail:send-email');
        const errors: string[] = [];
        if (!search || search.defaultTier !== 'green') errors.push('search-emails should be green');
        if (!archive || archive.defaultTier !== 'yellow') errors.push('archive-email should be yellow');
        if (!send || send.defaultTier !== 'red') errors.push('send-email should be red');
        if (errors.length > 0) {
          return { passed: false, durationMs: 0, message: errors.join('; ') };
        }
        return { passed: true, durationMs: 0, message: `${actions.length} actions across all tiers` };
      },
    },
    {
      name: 'MCP server connects',
      description: 'Spawn Gmail MCP, connect, list tools (30s timeout for npx download)',
      level: 'mcp',
      requiredEnvVars: ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'],
      async run(): Promise<TestResult> {
        const result = await testMcpConnection(
          {
            command: 'npx',
            args: ['-y', '@shinzolabs/gmail-mcp'],
            env: {
              GMAIL_CLIENT_ID: process.env.GMAIL_CLIENT_ID!,
              GMAIL_CLIENT_SECRET: process.env.GMAIL_CLIENT_SECRET!,
              GMAIL_REFRESH_TOKEN: process.env.GMAIL_REFRESH_TOKEN!,
            },
          },
          30_000,
        );
        if (result.error) {
          return { passed: false, durationMs: 0, message: `Connection failed: ${result.error}` };
        }
        return { passed: true, durationMs: 0, message: `${result.tools.length} tools found` };
      },
    },
  ];

  return {
    skillName: 'gmail',
    displayName: 'Gmail',
    tests,
  };
}
