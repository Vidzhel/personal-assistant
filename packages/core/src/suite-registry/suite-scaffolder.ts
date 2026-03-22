import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import { createLogger, gitAutoCommit } from '@raven/shared';

const log = createLogger('suite-scaffolder');

export const SuiteScaffoldInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Must be kebab-case'),
  displayName: z.string().min(1),
  description: z.string().default(''),
  mcpServers: z.record(z.string(), z.unknown()).optional(),
});

export type SuiteScaffoldInput = z.infer<typeof SuiteScaffoldInputSchema>;

export interface SuiteScaffolder {
  scaffoldSuite: (input: SuiteScaffoldInput) => { suitePath: string };
}

export function createSuiteScaffolder(deps: {
  suitesDir: string;
  configDir: string;
}): SuiteScaffolder {
  const { suitesDir, configDir } = deps;
  const suitesConfigPath = resolve(configDir, 'suites.json');

  return {
    scaffoldSuite(input: SuiteScaffoldInput): { suitePath: string } {
      const suitePath = join(suitesDir, input.name);

      if (existsSync(suitePath)) {
        throw new Error(`Suite directory already exists: ${input.name}`);
      }

      // Create suite directory structure
      mkdirSync(suitePath, { recursive: true });
      mkdirSync(join(suitePath, 'agents'), { recursive: true });

      // Write suite.ts — use JSON.stringify to prevent template injection
      const suiteTs = `import { defineSuite } from '@raven/shared';

export default defineSuite({
  name: ${JSON.stringify(input.name)},
  displayName: ${JSON.stringify(input.displayName)},
  description: ${JSON.stringify(input.description)},
  capabilities: [],
});
`;
      writeFileSync(join(suitePath, 'suite.ts'), suiteTs, 'utf-8');

      // Write mcp.json
      const mcpConfig = input.mcpServers ? { mcpServers: input.mcpServers } : { mcpServers: {} };
      writeFileSync(
        join(suitePath, 'mcp.json'),
        JSON.stringify(mcpConfig, null, 2) + '\n',
        'utf-8',
      );

      // Add entry to suites.json
      const suitesConfig = existsSync(suitesConfigPath)
        ? (JSON.parse(readFileSync(suitesConfigPath, 'utf-8')) as Record<string, unknown>)
        : {};
      suitesConfig[input.name] = { enabled: true };
      writeFileSync(suitesConfigPath, JSON.stringify(suitesConfig, null, 2) + '\n', 'utf-8');

      log.info(`Suite scaffolded: ${input.name} at ${suitePath}`);

      // Git auto-commit the new suite
      gitAutoCommit(
        [suitePath, suitesConfigPath],
        `chore: scaffold new suite — ${input.name}`,
      ).catch((err: unknown) => {
        log.warn(`Git auto-commit failed for suite scaffold: ${err}`);
      });

      return { suitePath };
    },
  };
}
