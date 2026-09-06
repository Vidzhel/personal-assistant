import { lstatSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { ProjectWorkspace, ProjectWorkspaceSource } from '@raven/shared';

const KIB = 1024;
const MAX_OVERVIEW_KIB = 24;
const MAX_TOTAL_BYTES = MAX_OVERVIEW_KIB * KIB;
const MAX_SOURCE_KIB = 8;
const MAX_SOURCE_BYTES = MAX_SOURCE_KIB * KIB;
const MAX_SOURCES = 32;
const MAX_FILES_PER_SOURCE = 12;
const MAX_DESCRIPTION_CHARS = 512;
const MAX_ID_CHARS = 128;
const MAX_LABEL_CHARS = 256;
const OMISSION_NOTICE_RESERVE_BYTES = 160;
const STANDARD_CONTEXT_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  '.claude/CLAUDE.md',
  'README.md',
  'index.md',
];
const MANAGED_HOME_ANCHORS = [
  'context.md',
  'project.yaml',
  'memory',
  'tasks',
  'agents',
  'schedules',
  'templates',
];
const RFC3986_ESCAPES: Record<string, string> = {
  '!': '%21',
  "'": '%27',
  '(': '%28',
  ')': '%29',
  '*': '%2A',
};
const MARKDOWN_ESCAPES: Record<string, string> = {
  '\\': '\\\\',
  '[': '\\[',
  ']': '\\]',
};
const URI_ESCAPES: Record<string, string> = {
  ' ': '%20',
  '!': '%21',
  "'": '%27',
  '*': '%2A',
  '#': '%23',
  '(': '%28',
  ')': '%29',
  '[': '%5B',
  ']': '%5D',
  '<': '%3C',
  '>': '%3E',
  '\\': '%5C',
  '`': '%60',
};

export interface WorkspaceContextInput {
  workspace: ProjectWorkspace;
  home: string;
  cwd: string;
}

function inline(value: string): string {
  return value.replaceAll(/\s+/g, ' ');
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function truncateUtf8(value: string, maximum: number): string {
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const size = utf8Length(character);
    if (bytes + size > maximum) break;
    bytes += size;
    end += character.length;
  }
  return value.slice(0, end);
}

function markdownLabel(value: string): string {
  return inline(value).replace(/[\\[\]]/g, (character) => MARKDOWN_ESCAPES[character]);
}

function codeSpan(value: string): string {
  const text = inline(value);
  if (!text.includes('`')) return `\`${text}\``;
  let fence = '`';
  while (text.includes(fence)) fence += '`';
  return `${fence} ${text} ${fence}`;
}

function markdownPath(path: string): string {
  return path
    .split('/')
    .map((part) =>
      encodeURIComponent(part).replace(/[!'()*]/g, (character) => RFC3986_ESCAPES[character]),
    )
    .join('/');
}

function safeUri(uri: string): string {
  return [...uri].map((character) => URI_ESCAPES[character] ?? character).join('');
}

function boundedText(value: string, maximum: number): string {
  return value.length > maximum ? `${value.slice(0, maximum)}…` : value;
}

function safeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    !path.split('/').some((part) => part.length === 0 || part === '.' || part === '..')
  );
}

function boundedDescription(description: string | undefined): string | undefined {
  if (description === undefined) return undefined;
  const text = markdownLabel(description);
  return text.length > MAX_DESCRIPTION_CHARS
    ? `${text.slice(0, MAX_DESCRIPTION_CHARS)}… [description truncated]`
    : text;
}

function fileStatus(path: string): 'available' | 'unavailable' {
  if (hasSymlinkComponent(path)) return 'unavailable';
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink() ? 'available' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

function hasSymlinkComponent(path: string): boolean {
  const absolute = resolve(path);
  let current: string = sep;
  for (const part of absolute.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

function sourceFile(source: ProjectWorkspaceSource, path: string): string {
  const target = resolve(source.uri, path);
  const status = fileStatus(target);
  const label = `${path}${status === 'unavailable' ? ' (unavailable)' : ''}`;
  return `    - [${markdownLabel(label)}](${markdownPath(target)})`;
}

function sourceLocation(source: ProjectWorkspaceSource): string {
  return source.sourceType === 'folder' ? resolve(source.uri) : source.uri;
}

function sourceHeader(source: ProjectWorkspaceSource, selected: boolean): string {
  const location = sourceLocation(source);
  const renderedLocation =
    source.sourceType === 'folder'
      ? `[${markdownLabel(boundedText(location, MAX_LABEL_CHARS))}](${markdownPath(location)})`
      : `[${markdownLabel(boundedText(location, MAX_LABEL_CHARS))}](${safeUri(location)})`;
  return `  - ${markdownLabel(boundedText(source.id, MAX_ID_CHARS))} — ${markdownLabel(boundedText(source.label, MAX_LABEL_CHARS))} — ${renderedLocation}${selected ? ' (selected cwd)' : ''}`;
}

function sourceFiles(source: ProjectWorkspaceSource): {
  paths: string[];
  invalid: number;
  omitted: number;
} {
  if (source.sourceType !== 'folder') return { paths: [], invalid: 0, omitted: 0 };
  const configured = source.contextFiles;
  const explicit = configured?.filter(safeRelativePath);
  if (explicit !== undefined) {
    return {
      paths: explicit.slice(0, MAX_FILES_PER_SOURCE),
      invalid: (configured?.length ?? 0) - explicit.length,
      omitted: Math.max(0, explicit.length - MAX_FILES_PER_SOURCE),
    };
  }
  const existing = STANDARD_CONTEXT_FILES.filter(
    (path) => fileStatus(resolve(source.uri, path)) === 'available',
  );
  return { paths: existing.slice(0, MAX_FILES_PER_SOURCE), invalid: 0, omitted: 0 };
}

function sourceSection(source: ProjectWorkspaceSource, selected: boolean): string {
  const lines = [sourceHeader(source, selected)];
  const description = boundedDescription(source.description);
  if (description) lines.push(`    - Description: ${description}`);
  if (source.sourceType !== 'folder') {
    lines.push('    - Non-folder source metadata only; content was not inspected.');
    return boundedLines(lines);
  }
  const files = sourceFiles(source);
  if (files.paths.length === 0) {
    lines.push('    - No standard root context files detected.');
  } else {
    lines.push('    - Context files:');
    lines.push(...files.paths.map((path) => sourceFile(source, path)));
  }
  if (files.invalid > 0) lines.push(`    - Omitted ${files.invalid} unsafe context file path(s).`);
  if (files.omitted > 0)
    lines.push(`    - Omitted ${files.omitted} excess context file link(s) by source limit.`);
  return boundedLines(lines);
}

function boundedLines(lines: string[]): string {
  const notice = '\n    - Additional source details omitted by the per-source byte limit.';
  let output = lines[0] ?? '';
  let omitted = false;
  for (const line of lines.slice(1)) {
    const candidate = `${output}\n${line}`;
    if (utf8Length(candidate + notice) > MAX_SOURCE_BYTES) {
      omitted = true;
      continue;
    }
    output = candidate;
  }
  if (!omitted) return output;
  const available = Math.max(0, MAX_SOURCE_BYTES - utf8Length(notice));
  return `${truncateUtf8(output, available)}${notice}`;
}

function orderedSources(workspace: ProjectWorkspace): ProjectWorkspaceSource[] {
  const sources = workspace.sources;
  const selected = workspace.execution.sourceId
    ? sources.find((source) => source.id === workspace.execution.sourceId)
    : undefined;
  return selected ? [selected, ...sources.filter((source) => source.id !== selected.id)] : sources;
}

function managedAnchors(home: string): string {
  return MANAGED_HOME_ANCHORS.map((name) => `[${name}](${markdownPath(join(home, name))})`).join(
    ', ',
  );
}

function baseContext(input: WorkspaceContextInput, sources: ProjectWorkspaceSource[]): string {
  const selected = input.workspace.execution.sourceId;
  const selection = selected
    ? sources.some((source) => source.id === selected)
      ? `selected source ${codeSpan(boundedText(selected, MAX_ID_CHARS))}`
      : `requested source ${codeSpan(boundedText(selected, MAX_ID_CHARS))} is unavailable`
    : 'managed home';
  return [
    '## Workspace execution context',
    `- Managed home: ${codeSpan(resolve(input.home))}`,
    `- Current working directory: ${codeSpan(resolve(input.cwd))} (${selection})`,
    `- Native execution mode: ${codeSpan(input.workspace.execution.mode)}. Auto and full request native shell/file work subject to SDK and tool policy; full is trusted host execution.`,
    `- Managed home anchors: ${managedAnchors(resolve(input.home))}. Keep these project-owned files and directories intact.`,
    '- Ordinary project working directories may be created or reorganized. Selected repositories may use existing pipelines and skills; put artifacts in the project and return their exact paths.',
    '- This overview lists filenames and locations only; file bodies are intentionally not included.',
    '',
    '### Sources',
  ].join('\n');
}

function fitContext(base: string, sections: string[], omittedSources: number): string {
  let output = base;
  let included = 0;
  for (const section of sections) {
    const candidate = `${output}\n${section}`;
    if (utf8Length(candidate) > MAX_TOTAL_BYTES - OMISSION_NOTICE_RESERVE_BYTES) break;
    output = candidate;
    included += 1;
  }
  const omitted = omittedSources + sections.length - included;
  const notice =
    omitted > 0 ? `\n\n_Omitted ${omitted} source(s) from this bounded overview._` : '';
  if (utf8Length(output + notice) <= MAX_TOTAL_BYTES) return output + notice;
  const available = Math.max(0, MAX_TOTAL_BYTES - utf8Length(notice) - 1);
  return `${truncateUtf8(output, available).trimEnd()}${notice}`;
}

export function buildWorkspaceContext(input: WorkspaceContextInput): string {
  const allSources = orderedSources(input.workspace);
  const sources = allSources.slice(0, MAX_SOURCES);
  const sections = sources.map((source) =>
    sourceSection(source, source.id === input.workspace.execution.sourceId),
  );
  return fitContext(baseContext(input, allSources), sections, allSources.length - sources.length);
}
