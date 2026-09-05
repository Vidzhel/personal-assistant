const RECONNECT_INTERVAL_MS = 3000;

type MessageHandler = (msg: WsMessage) => void;
export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

export interface WsMessage {
  type: string;
  data: unknown;
}

export class WsClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<MessageHandler>();
  private channels: string[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private stateHandlers = new Set<(state: ConnectionState) => void>();

  private url: string;

  constructor(url: string) {
    this.url = url;
  }

  connect(channels: string[]): void {
    this.channels = channels;
    this.stopped = false;
    this.doConnect();
  }

  private doConnect(): void {
    if (this.stopped || this.ws) return;
    this.setState('connecting');
    const socket = new WebSocket(this.url);
    this.ws = socket;
    socket.onopen = () => {
      if (this.stopped || this.ws !== socket) return;
      socket.send(JSON.stringify({ type: 'subscribe', channels: this.channels }));
      this.setState('connected');
    };

    socket.onmessage = (e) => {
      if (this.stopped || this.ws !== socket) return;
      try {
        const msg: WsMessage = JSON.parse(e.data);
        this.handlers.forEach((h) => h(msg));
      } catch {
        // ignore malformed messages
      }
    };

    socket.onclose = () => {
      if (this.ws !== socket) return;
      this.ws = null;
      this.setState('disconnected');
      if (this.stopped) return;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.doConnect();
      }, RECONNECT_INTERVAL_MS);
    };
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onState(handler: (state: ConnectionState) => void): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  private setState(state: ConnectionState): void {
    this.stateHandlers.forEach((handler) => handler(state));
  }

  send(msg: unknown): boolean {
    if (this.stopped || this.ws?.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  disconnect(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.ws;
    this.ws = null;
    socket?.close();
    this.setState('disconnected');
  }
}
