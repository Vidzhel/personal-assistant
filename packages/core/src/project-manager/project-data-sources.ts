import type { ProjectDataSource } from '@raven/shared';

/** Render source metadata for prompts without making the file store global. */
export function formatProjectDataSources(
  sources: readonly ProjectDataSource[],
): string | undefined {
  if (sources.length === 0) return undefined;
  return sources
    .map((source) => {
      const description = source.description ? `\n  ${source.description}` : '';
      const context =
        source.contextFiles && source.contextFiles.length > 0
          ? `\n  Context files: ${source.contextFiles.join(', ')}`
          : '';
      return `- **${source.label}** (${source.sourceType}): ${source.uri}${description}${context}`;
    })
    .join('\n');
}
