// Next embeds NEXT_PUBLIC values during the web build. Rebuild when these change.
export const CORE_API_URL = (
  process.env.NEXT_PUBLIC_CORE_API_URL || 'http://localhost:4001/api'
).replace(/\/+$/, '');

export const CORE_WS_URL = process.env.NEXT_PUBLIC_CORE_WS_URL || 'ws://localhost:4001/ws';
