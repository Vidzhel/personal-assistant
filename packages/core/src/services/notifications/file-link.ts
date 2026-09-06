import { isAbsolute, relative, resolve, sep } from 'node:path';
import { parseBrowserOrigin } from '../../api/browser-origin.ts';

/** Link only the existing global-file route; attached repository files use project artifacts. */
export function notificationFileUrl(
  filePath: string,
  runtimeRoot: string,
  baseUrl?: string,
): string | undefined {
  if (!baseUrl) return undefined;
  let origin: string;
  try {
    origin = parseBrowserOrigin(baseUrl);
  } catch {
    return undefined;
  }
  const root = resolve(runtimeRoot, 'data/files');
  const path = relative(root, resolve(runtimeRoot, filePath));
  if (!path || isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) return undefined;
  return `${origin}/api/files/${path.split(sep).map(encodeURIComponent).join('/')}`;
}
