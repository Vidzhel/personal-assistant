import type { SkillTestSuite, TestLevel, TestResult } from './types.ts';

interface RunnerOptions {
  suites: SkillTestSuite[];
  levelFilter?: TestLevel;
}

interface RunSummary {
  passed: number;
  failed: number;
  skipped: number;
}

export async function runTests(options: RunnerOptions): Promise<boolean> {
  const { suites, levelFilter } = options;
  const totals: RunSummary = { passed: 0, failed: 0, skipped: 0 };

  for (const suite of suites) {
    console.log(`\n=== ${suite.displayName} ===\n`);

    const tests = levelFilter
      ? suite.tests.filter((t) => t.level === levelFilter)
      : suite.tests;

    if (tests.length === 0) {
      console.log(`  No ${levelFilter ?? ''} tests defined\n`);
      continue;
    }

    for (const test of tests) {
      const tag = `[${test.level.toUpperCase()}]`;

      // Check required env vars
      if (test.requiredEnvVars?.length) {
        const missing = test.requiredEnvVars.filter((v) => !process.env[v]);
        if (missing.length > 0) {
          totals.skipped++;
          console.log(`${tag} ${test.name}`);
          console.log(`  ${test.description}`);
          console.log(`  SKIP — Missing ${missing.join(', ')}\n`);
          continue;
        }
      }

      const start = performance.now();
      let result: TestResult;
      try {
        result = await test.run();
        result.durationMs = Math.round(performance.now() - start);
      } catch (err) {
        result = {
          passed: false,
          durationMs: Math.round(performance.now() - start),
          message: err instanceof Error ? err.message : String(err),
        };
      }

      console.log(`${tag} ${test.name}`);
      console.log(`  ${test.description}`);

      if (result.skipped) {
        totals.skipped++;
        console.log(`  SKIP — ${result.skipReason ?? 'unknown reason'}\n`);
      } else if (result.passed) {
        totals.passed++;
        console.log(`  PASS (${formatDuration(result.durationMs)}) — ${result.message}\n`);
      } else {
        totals.failed++;
        console.log(`  FAIL (${formatDuration(result.durationMs)}) — ${result.message}\n`);
      }
    }
  }

  console.log('---');
  console.log(
    `Summary: ${totals.passed} passed, ${totals.failed} failed, ${totals.skipped} skipped`,
  );
  console.log('');

  return totals.failed === 0;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
