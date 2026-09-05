/** An ID is one path segment even when a legacy project ID contains slashes. */
export function projectPath(id: string): string {
  return `/projects/${encodeURIComponent(id)}`;
}

/** Next's dynamic route parameter retains percent escapes; decode at this boundary once. */
export function projectIdFromRoute(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
