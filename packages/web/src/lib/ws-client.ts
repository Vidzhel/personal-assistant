const RECONNECT_INTERVAL_MS = 3000;

type MessageHandler = (msg: WsMessage) => void;

export interface WsMessage {
  type: string;
  data: unknown;
}

export class WsClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<MessageHandler>();
  private channels: string[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private url: string;

  constructor(url: string) {
    this.url = url;
  }

  connect(channels: string[]): void {
    this.channels = channels;
    this.doConnect();
  }

  private doConnect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      this.ws?.send(JSON.stringify({ type: 'subscribe', channels: this.channels }));
    };

    this.ws.onmessage = (e) => {
      try {
        const msg: WsMessage = JSON.parse(e.data);
        this.handlers.forEach((h) => h(msg));
      } catch {
        // ignore malformed messages
      }
    };

    this.ws.onclose = () => {
      this.reconnectTimer = setTimeout(() => this.doConnect(), RECONNECT_INTERVAL_MS);
    };
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }
}
