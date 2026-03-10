import type { RavenSkill } from '../packages/shared/src/types/skills.ts';
import type { SkillTestSuite, TestLevel } from './skill-tests/types.ts';
import { runTests } from './skill-tests/runner.ts';
import { createTickTickSuite } from './skill-tests/suites/ticktick.ts';
import { createGmailSuite } from './skill-tests/suites/gmail.ts';
import { createDigestSuite } from './skill-tests/suites/digest.ts';
import { createTelegramSuite } from './skill-tests/suites/telegram.ts';

type SuiteFactory = (skill: RavenSkill) => SkillTestSuite;

const SKILL_SUITES: Record<string, SuiteFactory> = {
  ticktick: createTickTickSuite,
  gmail: createGmailSuite,
  digest: createDigestSuite,
  telegram: createTelegramSuite,
};

async function loadSkill(name: string): Promise<RavenSkill> {
  const mod = await import(`../packages/skills/skill-${name}/src/index.ts`);
  return mod.default();
}

function parseArgs(args: string[]): { skills: string[]; level?: TestLevel } {
  let level: TestLevel | undefined;
  const skills: string[] = [];
  let all = false;

  for (const arg of args) {
    if (arg === '--all') {
      all = true;
    } else if (arg.startsWith('--level=')) {
      const val = arg.slice('--level='.length);
      if (val !== 'init' && val !== 'mcp' && val !== 'agent') {
        console.error(`Invalid level: ${val}. Must be init, mcp, or agent.`);
        process.exit(1);
      }
      level = val;
    } else if (!arg.startsWith('-')) {
      skills.push(arg);
    }
  }

  if (all) {
    return { skills: Object.keys(SKILL_SUITES), level };
  }

  if (skills.length === 0) {
    console.error('Usage: test-skill <skill-name> [--level=init|mcp|agent]');
    console.error('       test-skill --all [--level=init|mcp|agent]');
    console.error(`\nAvailable skills: ${Object.keys(SKILL_SUITES).join(', ')}`);
    process.exit(1);
  }

  return { skills, level };
}

async function main(): Promise<void> {
  const { skills, level } = parseArgs(process.argv.slice(2));
  const suites: SkillTestSuite[] = [];

  for (const name of skills) {
    const factory = SKILL_SUITES[name];
    if (!factory) {
      console.error(`Unknown skill: ${name}. Available: ${Object.keys(SKILL_SUITES).join(', ')}`);
      process.exit(1);
    }
    const skill = await loadSkill(name);
    suites.push(factory(skill));
  }

  const success = await runTests({ suites, levelFilter: level });
  process.exit(success ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
