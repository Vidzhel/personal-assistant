import { CORE_API_URL } from '@/lib/core-endpoints';

function serverError(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const error = body as { error?: unknown; message?: unknown };
    if (typeof error.message === 'string') return error.message;
    if (typeof error.error === 'string') return error.error;
  }
  return `API error: ${status}`;
}

export async function apiRequest<T>(path: string, opts?: RequestInit): Promise<T> {
  const headers = new Headers(opts?.headers);
  if (opts?.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${CORE_API_URL}${path}`, { ...opts, headers });
  const text = await response.text();
  let body: unknown;
  try {
    body = text.trim() ? JSON.parse(text) : undefined;
  } catch {
    if (response.ok) throw new Error('API returned an invalid JSON response');
  }
  if (!response.ok) throw new Error(serverError(body, response.status));
  return body as T;
}
