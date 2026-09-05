import { stat } from 'node:fs/promises';
import { validateProjects } from '../../project-registry/project-validator.ts';
import { validateLibrary } from '../../capability-library/library-validator.ts';
import { loadLibrary } from '../../capability-library/library-loader.ts';

export interface ConventionViolation {
  resourceType: 'agent' | 'schedule' | 'project' | 'library';
  resourceName: string;
  rule: string;
  severity: 'error' | 'warning';
  message: string;
  fix: string;
}

export interface ConventionAuditReport {
  violations: ConventionViolation[];
  /** Counts validated definition roots, rather than obsolete JSON records. */
  compliantCount: number;
  totalChecked: number;
  checkedAt: string;
}

export interface ConventionAuditPaths {
  projectsDir: string;
  libraryDir: string;
  knownSkills?: Set<string>;
}

/** Use the same validators as validate:projects / validate:library. */
export async function auditConventions(
  paths: ConventionAuditPaths,
): Promise<ConventionAuditReport> {
  const violations: ConventionViolation[] = [];
  let knownSkills = paths.knownSkills;
  try {
    knownSkills ??= new Set((await loadLibrary(paths.libraryDir)).skills.keys());
  } catch {
    // The library validation below reports unreadable/malformed definitions.
  }
  violations.push(
    ...(await check('project', paths.projectsDir, () =>
      validateProjects(paths.projectsDir, { knownSkills }),
    )),
  );
  violations.push(
    ...(await check('library', paths.libraryDir, async () => ({
      errors: await validateLibrary(paths.libraryDir),
      warnings: [],
    }))),
  );
  const totalChecked = 2;
  return {
    violations,
    totalChecked,
    compliantCount: totalChecked - new Set(violations.map((v) => v.resourceType)).size,
    checkedAt: new Date().toISOString(),
  };
}

async function check(
  resourceType: 'project' | 'library',
  resourceName: string,
  validate: () => Promise<{ errors: string[]; warnings: string[] }>,
): Promise<ConventionViolation[]> {
  const violations: ConventionViolation[] = [];
  try {
    if (!(await stat(resourceName)).isDirectory())
      throw new Error('Definition root is not a directory');
    const result = await validate();
    for (const severity of ['error', 'warning'] as const) {
      for (const message of result[severity === 'error' ? 'errors' : 'warnings']) {
        violations.push({
          resourceType,
          resourceName,
          rule: 'current-definition-validation',
          severity,
          message,
          fix: `Repair the referenced ${resourceType} definition and rerun its validator`,
        });
      }
    }
  } catch (err) {
    violations.push({
      resourceType,
      resourceName,
      rule: 'readable-definition-root',
      severity: 'error',
      message: String(err),
      fix: 'Restore a readable definition root and rerun validation',
    });
  }
  return violations;
}
