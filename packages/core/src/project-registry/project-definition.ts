import { parseDocument, isMap } from 'yaml';
import { ProjectMetadataSchema, type ProjectMetadata } from '@raven/shared';

const NAMESPACE = 'ravenProject';
const FRONTMATTER = /^---\r?\n((?:[\s\S]*?\r?\n)?)(?:---|\.\.\.)(?:\r?\n|$)/;

function splitDefinition(raw: string): { frontmatter: string; body: string } {
  const match = FRONTMATTER.exec(raw);
  if (!match) {
    if (raw.startsWith('---\n') || raw.startsWith('---\r\n')) {
      throw new Error('Unterminated project frontmatter');
    }
    return { frontmatter: '', body: raw };
  }
  return { frontmatter: match[1], body: raw.slice(match[0].length) };
}

function parseFrontmatter(source: string): ReturnType<typeof parseDocument> {
  const doc = parseDocument(source);
  if (doc.errors.length > 0)
    throw new Error(`Invalid project frontmatter: ${doc.errors[0].message}`);
  if (doc.contents !== null && !isMap(doc.contents)) {
    throw new Error('Project frontmatter must be a mapping');
  }
  return doc;
}

export function readProjectDefinition(raw: string): { body: string; metadata?: ProjectMetadata } {
  const { frontmatter, body } = splitDefinition(raw);
  const doc = parseFrontmatter(frontmatter);
  if (!doc.has(NAMESPACE)) return { body };
  return { body, metadata: ProjectMetadataSchema.parse(doc.get(NAMESPACE)?.toJSON()) };
}

/** Retain the human body byte-for-byte and leave unrelated YAML nodes/comments intact. */
export function writeProjectDefinition(raw: string, metadata: ProjectMetadata): string {
  const { frontmatter, body } = splitDefinition(raw);
  const doc = parseFrontmatter(frontmatter);
  doc.set(NAMESPACE, ProjectMetadataSchema.parse(metadata));
  return `---\n${String(doc)}---\n${body}`;
}
