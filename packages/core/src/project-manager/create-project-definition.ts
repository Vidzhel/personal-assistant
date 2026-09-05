import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { stringify } from 'yaml';
import {
  ProjectMetadataSchema,
  projectWorkspaceDefaults,
  type ProjectMetadata,
} from '@raven/shared';
import type { ProjectRegistry } from '../project-registry/project-registry.ts';
import type { ScaffoldProjectInput } from '../scaffolding/scaffolding-api.ts';
import {
  writeProjectDefinition,
  readProjectDefinition,
} from '../project-registry/project-definition.ts';
import {
  assertProjectPath,
  managedPath,
  pathPresent,
  readManagedContext,
} from './project-files.ts';
import { ProjectMutationError, withProjectMutation } from './project-mutation.ts';
import {
  createMutationJournal,
  flushProjectMutationPath,
  readProjectRecoveryReport,
  removeProjectMutationJournal,
} from './project-recovery/journal.ts';

export interface DefinitionDeps {
  projectsDir: string;
  projectRegistry: ProjectRegistry;
  syncProjects?: () => void;
  checkpoint?: (label: string) => Promise<void>;
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
  return withProjectMutation(deps.projectsDir, () =>
    createDefinitionMutation({ deps, input, system }),
  );
}

async function createDefinitionMutation(input: {
  deps: DefinitionDeps;
  input: ScaffoldProjectInput;
  system: boolean;
}): Promise<string> {
  const { deps, input: projectInput, system } = input;
  assertProjectPath(projectInput.path, system);
  assertNoPendingProjectMutation(deps, projectInput.path);
  if (projectInput.id === 'meta' && !system)
    throw new ProjectMutationError('The system project identity is reserved');
  const metadata = metadataForInput(projectInput);
  await validateParent(deps.projectsDir, projectInput.path);
  const path = await managedPath(deps.projectsDir, projectInput.path);
  if (await pathPresent(path))
    throw new ProjectMutationError(`Project path ${projectInput.path} already exists`);
  const body = `# ${metadata.displayName}\n\n${projectInput.description ?? ''}\n`;
  const intended = writeProjectDefinition(body, metadata);
  const workspaceBytes = stringify(projectWorkspaceDefaults());
  await publishCreatedDefinition({ deps, projectInput, metadata, intended, workspaceBytes, path });
  return projectInput.path;
}

function assertNoPendingProjectMutation(deps: DefinitionDeps, path: string): void {
  const pending = [
    ...readProjectRecoveryReport(deps.projectsDir).pendingProjectPaths,
    ...deps.projectRegistry.getInvalidProjectPaths(),
  ];
  if (
    pending.some(
      (candidate) =>
        candidate === '.' ||
        candidate === path ||
        candidate.startsWith(`${path}/`) ||
        path.startsWith(`${candidate}/`),
    )
  ) {
    throw new ProjectMutationError(`Project mutation recovery is pending for ${path}`);
  }
}

async function publishCreatedDefinition(input: {
  deps: DefinitionDeps;
  projectInput: ScaffoldProjectInput;
  metadata: ProjectMetadata;
  intended: string;
  workspaceBytes: string;
  path: string;
}): Promise<void> {
  const { deps, projectInput, metadata, intended, workspaceBytes, path } = input;
  const preparedRelative = `.project-mutations/prepared-${randomUUID()}`;
  const preparedPath = join(deps.projectsDir, preparedRelative);
  const journal = createMutationJournal({
    projectsDir: deps.projectsDir,
    operation: 'create',
    projectId: metadata.id ?? projectInput.path,
    path: projectInput.path,
    originalBytes: '',
    intendedBytes: intended,
    preparedPath: preparedRelative,
    workspaceBytes,
  });
  await deps.checkpoint?.('create:journal');
  await mkdir(preparedPath);
  await writeFile(join(preparedPath, 'context.md'), intended, { flag: 'wx' });
  await writeFile(join(preparedPath, 'project.yaml'), workspaceBytes, { flag: 'wx' });
  flushProjectMutationPath(join(preparedPath, 'context.md'));
  flushProjectMutationPath(join(preparedPath, 'project.yaml'));
  flushProjectMutationPath(preparedPath);
  await deps.checkpoint?.('create:staged');
  await renamePreparedProject(preparedPath, path);
  await deps.checkpoint?.('create:published');
  await deps.projectRegistry.load(deps.projectsDir);
  removeProjectMutationJournal(deps.projectsDir, journal.mutationId);
  deps.syncProjects?.();
  await deps.checkpoint?.('create:cache');
}

async function renamePreparedProject(preparedPath: string, destination: string): Promise<void> {
  await rename(preparedPath, destination);
  flushProjectMutationPath(dirname(preparedPath));
  flushProjectMutationPath(dirname(destination));
}
