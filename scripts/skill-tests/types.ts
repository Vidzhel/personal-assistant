export type TestLevel = 'init' | 'mcp' | 'agent';

export interface TestCase {
  name: string;
  description: string;
  level: TestLevel;
  requiredEnvVars?: string[];
  run: () => Promise<TestResult>;
}

export interface TestResult {
  passed: boolean;
  message: string;
  durationMs: number;
  skipped?: boolean;
  skipReason?: string;
}

export interface SkillTestSuite {
  skillName: string;
  displayName: string;
  tests: TestCase[];
}
