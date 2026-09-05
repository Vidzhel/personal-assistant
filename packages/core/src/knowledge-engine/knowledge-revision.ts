import { createHash } from 'node:crypto';

/** Semantic source revision shared by file indexing and derived data writers. */
export function knowledgeRevision(source: {
  title: string;
  content: string;
  tags: string[];
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        title: source.title,
        content: source.content.trim(),
        tags: [...new Set(source.tags)].sort(),
      }),
    )
    .digest('hex');
}
