import type { SkillTestSuite, TestCase, TestResult } from '../types.ts';
import type { RavenSkill } from '../../../packages/shared/src/types/skills.ts';
import { createMockContext } from '../mock-context.ts';
import { testMcpConnection, connectMcp, callMcpTool, closeMcp } from '../mcp-tester.ts';

export function createTickTickSuite(skill: RavenSkill): SkillTestSuite {
  const tests: TestCase[] = [
    {
      name: 'Skill loads and initializes',
      description: 'Verify manifest has mcp-server + agent-definition capabilities',
      level: 'init',
      async run(): Promise<TestResult> {
        const ctx = createMockContext();
        await skill.initialize(ctx);
        const caps = skill.manifest.capabilities;
        const hasMcp = caps.includes('mcp-server');
        const hasAgent = caps.includes('agent-definition');
        if (!hasMcp || !hasAgent) {
          return {
            passed: false,
            durationMs: 0,
            message: `Missing capabilities: ${!hasMcp ? 'mcp-server' : ''} ${!hasAgent ? 'agent-definition' : ''}`.trim(),
          };
        }
        return { passed: true, durationMs: 0, message: `Capabilities: ${caps.join(', ')}` };
      },
    },
    {
      name: 'MCP server declared with correct command',
      description: 'getMcpServers() returns ticktick key with node command',
      level: 'init',
      async run(): Promise<TestResult> {
        const ctx = createMockContext();
        await skill.initialize(ctx);
        const servers = skill.getMcpServers();
        if (!servers.ticktick) {
          return { passed: false, durationMs: 0, message: 'No "ticktick" MCP server declared' };
        }
        if (servers.ticktick.command !== 'node') {
          return {
            passed: false,
            durationMs: 0,
            message: `Expected command "node", got "${servers.ticktick.command}"`,
          };
        }
        return { passed: true, durationMs: 0, message: `Command: ${servers.ticktick.command} ${servers.ticktick.args.join(' ')}` };
      },
    },
    {
      name: 'Agent definitions declared',
      description: 'getAgentDefinitions() returns ticktick-agent with description and tools',
      level: 'init',
      async run(): Promise<TestResult> {
        const ctx = createMockContext();
        await skill.initialize(ctx);
        const agents = skill.getAgentDefinitions();
        const agent = agents['ticktick-agent'];
        if (!agent) {
          return { passed: false, durationMs: 0, message: 'No "ticktick-agent" defined' };
        }
        if (!agent.description || !agent.tools?.length) {
          return { passed: false, durationMs: 0, message: 'Agent missing description or tools' };
        }
        return { passed: true, durationMs: 0, message: `Agent has ${agent.tools.length} tool patterns` };
      },
    },
    {
      name: 'Actions declared correctly',
      description: 'getActions() includes get-tasks and create-task with correct tiers',
      level: 'init',
      async run(): Promise<TestResult> {
        const ctx = createMockContext();
        await skill.initialize(ctx);
        const actions = skill.getActions();
        const getTasks = actions.find((a) => a.name === 'ticktick:get-tasks');
        const createTask = actions.find((a) => a.name === 'ticktick:create-task');
        if (!getTasks) {
          return { passed: false, durationMs: 0, message: 'Missing ticktick:get-tasks action' };
        }
        if (!createTask) {
          return { passed: false, durationMs: 0, message: 'Missing ticktick:create-task action' };
        }
        if (getTasks.defaultTier !== 'green') {
          return { passed: false, durationMs: 0, message: `get-tasks should be green, got ${getTasks.defaultTier}` };
        }
        if (createTask.defaultTier !== 'yellow') {
          return { passed: false, durationMs: 0, message: `create-task should be yellow, got ${createTask.defaultTier}` };
        }
        return { passed: true, durationMs: 0, message: `${actions.length} actions declared` };
      },
    },
    {
      name: 'MCP server rejects missing token',
      description: 'Spawn MCP server with empty TICKTICK_ACCESS_TOKEN, verify error',
      level: 'mcp',
      async run(): Promise<TestResult> {
        const result = await testMcpConnection({
          command: 'node',
          args: ['--experimental-strip-types', 'packages/mcp-ticktick/src/index.ts'],
          env: { TICKTICK_ACCESS_TOKEN: '', TICKTICK_CLIENT_ID: '', TICKTICK_CLIENT_SECRET: '' },
        });
        if (result.error) {
          return { passed: true, durationMs: 0, message: `Correctly rejected: ${result.error.slice(0, 100)}` };
        }
        return { passed: false, durationMs: 0, message: 'Expected server to reject missing token but it connected' };
      },
    },
    {
      name: 'MCP server connects and lists tools',
      description: 'Spawn real MCP server, connect, verify expected tools',
      level: 'mcp',
      requiredEnvVars: ['TICKTICK_ACCESS_TOKEN'],
      async run(): Promise<TestResult> {
        const result = await testMcpConnection({
          command: 'node',
          args: ['--experimental-strip-types', 'packages/mcp-ticktick/src/index.ts'],
          env: {
            TICKTICK_ACCESS_TOKEN: process.env.TICKTICK_ACCESS_TOKEN!,
            TICKTICK_CLIENT_ID: process.env.TICKTICK_CLIENT_ID ?? '',
            TICKTICK_CLIENT_SECRET: process.env.TICKTICK_CLIENT_SECRET ?? '',
          },
        });
        if (result.error) {
          return { passed: false, durationMs: 0, message: `Connection failed: ${result.error}` };
        }
        const expected = ['get_projects', 'get_all_tasks', 'create_task'];
        const missing = expected.filter((t) => !result.tools.includes(t));
        if (missing.length > 0) {
          return { passed: false, durationMs: 0, message: `Missing tools: ${missing.join(', ')}` };
        }
        return { passed: true, durationMs: 0, message: `${result.tools.length} tools found` };
      },
    },
    {
      name: 'MCP get_projects returns data',
      description: 'Call get_projects tool, verify JSON array with id/name',
      level: 'mcp',
      requiredEnvVars: ['TICKTICK_ACCESS_TOKEN'],
      async run(): Promise<TestResult> {
        const conn = await connectMcp({
          command: 'node',
          args: ['--experimental-strip-types', 'packages/mcp-ticktick/src/index.ts'],
          env: {
            TICKTICK_ACCESS_TOKEN: process.env.TICKTICK_ACCESS_TOKEN!,
            TICKTICK_CLIENT_ID: process.env.TICKTICK_CLIENT_ID ?? '',
            TICKTICK_CLIENT_SECRET: process.env.TICKTICK_CLIENT_SECRET ?? '',
          },
        });
        try {
          const result = await callMcpTool(conn, 'get_projects');
          if (result.error) {
            return { passed: false, durationMs: 0, message: `Tool call failed: ${result.error}` };
          }
          const content = result.content as Array<{ type: string; text: string }>;
          const text = content?.[0]?.text ?? '';
          const projects = JSON.parse(text);
          if (!Array.isArray(projects)) {
            return { passed: false, durationMs: 0, message: 'Expected array response' };
          }
          if (projects.length > 0 && (!projects[0].id || !projects[0].name)) {
            return { passed: false, durationMs: 0, message: 'Projects missing id/name fields' };
          }
          return { passed: true, durationMs: 0, message: `${projects.length} projects returned` };
        } finally {
          await closeMcp(conn);
        }
      },
    },
    {
      name: 'MCP get_all_tasks returns data',
      description: 'Call get_all_tasks, verify returns JSON array',
      level: 'mcp',
      requiredEnvVars: ['TICKTICK_ACCESS_TOKEN'],
      async run(): Promise<TestResult> {
        const conn = await connectMcp({
          command: 'node',
          args: ['--experimental-strip-types', 'packages/mcp-ticktick/src/index.ts'],
          env: {
            TICKTICK_ACCESS_TOKEN: process.env.TICKTICK_ACCESS_TOKEN!,
            TICKTICK_CLIENT_ID: process.env.TICKTICK_CLIENT_ID ?? '',
            TICKTICK_CLIENT_SECRET: process.env.TICKTICK_CLIENT_SECRET ?? '',
          },
        });
        try {
          const result = await callMcpTool(conn, 'get_all_tasks');
          if (result.error) {
            return { passed: false, durationMs: 0, message: `Tool call failed: ${result.error}` };
          }
          const content = result.content as Array<{ type: string; text: string }>;
          const text = content?.[0]?.text ?? '';
          const tasks = JSON.parse(text);
          if (!Array.isArray(tasks)) {
            return { passed: false, durationMs: 0, message: 'Expected array response' };
          }
          return { passed: true, durationMs: 0, message: `${tasks.length} tasks returned` };
        } finally {
          await closeMcp(conn);
        }
      },
    },
  ];

  return {
    skillName: 'ticktick',
    displayName: 'TickTick',
    tests,
  };
}
