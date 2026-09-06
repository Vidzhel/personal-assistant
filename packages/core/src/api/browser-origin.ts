import type { FastifyInstance } from 'fastify';

const FORBIDDEN = 403;

const LOCAL_BROWSER_ORIGINS = [
  'http://localhost:4000',
  'http://127.0.0.1:4000',
  'http://localhost:4001',
  'http://127.0.0.1:4001',
];

/** Canonical origins only: credentials, paths and opaque/null origins are forbidden. */
export function parseBrowserOrigin(value: string): string {
  if (value !== value.trim() || /[\s\p{Cc}]/u.test(value)) {
    throw new Error('Browser origin must not contain whitespace or control characters');
  }
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  )
    throw new Error('Browser origin must be an HTTP(S) origin without credentials or a path');
  return url.origin;
}

export function configuredBrowserOrigins(config: {
  RAVEN_BASE_URL?: string;
  RAVEN_BROWSER_ORIGINS?: string;
}): string[] {
  const primary = config.RAVEN_BASE_URL
    ? [parseBrowserOrigin(config.RAVEN_BASE_URL)]
    : LOCAL_BROWSER_ORIGINS;
  const additional = config.RAVEN_BROWSER_ORIGINS
    ? config.RAVEN_BROWSER_ORIGINS.split(',').map((value) => parseBrowserOrigin(value.trim()))
    : [];
  return [...new Set([...primary, ...additional])];
}

/** This is browser request protection, not authentication; the private gateway owns auth. */
export function registerBrowserOriginPolicy(
  app: FastifyInstance,
  origins: readonly string[],
): void {
  const allowed = new Set(origins.map(parseBrowserOrigin));
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin === undefined) return;
    // Compare the exact serialized browser origin; do not trust Host or forwarded headers.
    if (!allowed.has(origin)) {
      if (request.headers.upgrade?.toLowerCase() === 'websocket') {
        const socket = request.raw.socket;
        reply.raw.once('finish', () => socket.end());
      }
      return reply
        .header('Connection', 'close')
        .code(FORBIDDEN)
        .send({ error: 'Browser origin is not allowed' });
    }
  });
}
