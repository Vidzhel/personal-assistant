import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ProjectMetadataSchema, type ProjectMetadata } from '@raven/shared';
import type { ProjectRegistry } from '../project-registry/project-registry.ts';
import type { ScaffoldProjectInput } from '../scaffolding/scaffolding-api.ts';
import {
  writeProjectDefinition,
  readProjectDefinition,
} from '../project-registry/project-definition.ts';
import { assertProjectPath, managedPath, readManagedContext } from './project-files.ts';
import { ProjectMutationError, withProjectMutation } from './project-mutation.ts';

interface DefinitionDeps {
  projectsDir: string;
  projectRegistry: ProjectRegistry;
  syncProjects?: () => void;
}

async function validateParent(root: string, path: string): Promise<void> {
  let parent = dirname(path);
  while (parent !== '.') {
    try {
      readProjectDefinition(await readManagedContext(root, parent));
    } catch (error) {
      throw new ProjectMutationError(
        `Parent project ${parent} must have a valid context.md: ${String(error)}`,
      );
    }
    parent = dirname(parent);
  }
}

function metadataForInput(input: ScaffoldProjectInput): ProjectMetadata {
  return ProjectMetadataSchema.parse({
    version: 1,
    id: input.id ?? randomUUID(),
    displayName: input.displayName ?? input.path,
    description: input.description,
    skills: input.skills ?? [],
    systemPrompt: input.systemPrompt,
    systemAccess: input.systemAccess ?? 'none',
  });
}

export async function createProjectDefinition(
  deps: DefinitionDeps,
  input: ScaffoldProjectInput,
  system = false,
): Promise<string> {
  return withProjectMutation(deps.projectsDir, async () => {
    assertProjectPath(input.path, system);
    if (input.id === 'meta' && !system)
      throw new ProjectMutationError('The system project identity is reserved');
    const metadata = metadataForInput(input);
    await validateParent(deps.projectsDir, input.path);
    const path = await managedPath(deps.projectsDir, input.path);
    try {
      await mkdir(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new ProjectMutationError(`Project path ${input.path} already exists`);
      throw error;
    }
    try {
      const body = `# ${metadata.displayName}\n\n${input.description ?? ''}\n`;
      await writeFile(join(path, 'context.md'), writeProjectDefinition(body, metadata), {
        flag: 'wx',
      });
      await deps.projectRegistry.load(deps.projectsDir);
      deps.syncProjects?.();
      return input.path;
    } catch (error) {
      await rm(path, { recursive: true });
      await deps.projectRegistry.load(deps.projectsDir);
      throw error;
    }
  });
}
