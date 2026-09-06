// Next embeds NEXT_PUBLIC values and NODE_ENV during the web build. Rebuild when these change.
const configuredApiUrl = process.env.NEXT_PUBLIC_CORE_API_URL?.trim();
const configuredWsUrl = process.env.NEXT_PUBLIC_CORE_WS_URL?.trim();
const development = process.env.NODE_ENV === 'development';

export const CORE_API_URL = (
  configuredApiUrl || (development ? 'http://localhost:4001/api' : '/api')
).replace(/\/+$/, '');

function sameOriginWebSocketUrl(): string {
  if (typeof window === 'undefined') return '/ws';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

export const CORE_WS_URL =
  configuredWsUrl || (development ? 'ws://localhost:4001/ws' : sameOriginWebSocketUrl());
