/**
 * 缠论买卖点扫描的 WebSocket 客户端。
 *
 * 浏览器端不再拉 K 线、不再算缠论: 只负责发一次扫描请求, 之后接收后端
 * (server/scan.ts) 推送的进度 / 信号行 / 资金流。本封装处理连接建立、
 * 断线重连 (指数退避) 与离线时的消息排队, 页面只管收发语义。
 */
import type { ScanClientMessage, ScanServerMessage } from '../types/scan';

export type ScanConnectionState = 'connecting' | 'open' | 'closed';

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15000;

/**
 * 扫描 WebSocket 地址。
 * 默认走同源 /ws (vite dev 与 preview 都把 /ws 代理到 :8899);
 * 生产环境前后端分离时用 VITE_ANALYSIS_WS_URL 指定完整地址。
 */
export function scanWsUrl(): string {
  const configured = (import.meta.env?.VITE_ANALYSIS_WS_URL as string | undefined) ?? '';
  if (configured) return configured.replace(/\/$/, '');
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}/ws`;
}

export class ScanSocket {
  private ws: WebSocket | null = null;
  private queued: ScanClientMessage[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = RECONNECT_MIN_MS;
  private disposed = false;
  private current: ScanConnectionState = 'closed';

  constructor(
    private readonly onMessage: (msg: ScanServerMessage) => void,
    private readonly onState: (state: ScanConnectionState) => void,
  ) {}

  get state(): ScanConnectionState {
    return this.current;
  }

  connect(): void {
    if (this.disposed) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;

    this.setState('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(scanWsUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.retryDelay = RECONNECT_MIN_MS;
      this.setState('open');
      const pending = this.queued;
      this.queued = [];
      for (const msg of pending) ws.send(JSON.stringify(msg));
    };
    ws.onmessage = event => {
      if (typeof event.data !== 'string') return;
      let msg: ScanServerMessage;
      try {
        msg = JSON.parse(event.data) as ScanServerMessage;
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
      this.onMessage(msg);
    };
    ws.onerror = () => {
      // onclose 紧随其后, 重连逻辑统一在那里处理
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.setState('closed');
      this.scheduleReconnect();
    };
  }

  /** 发送一条指令; 未连上时排队 (同类指令只保留最新一条), 连上后自动补发 */
  send(msg: ScanClientMessage): void {
    if (this.disposed) return;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return;
    }
    const at = this.queued.findIndex(q => q.type === msg.type);
    if (at >= 0) this.queued[at] = msg;
    else this.queued.push(msg);
    this.connect();
  }

  dispose(): void {
    this.disposed = true;
    this.queued = [];
    if (this.retryTimer != null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      ws.close();
    }
    this.setState('closed');
  }

  private setState(state: ScanConnectionState): void {
    if (this.current === state) return;
    this.current = state;
    this.onState(state);
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.retryTimer != null) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, RECONNECT_MAX_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }
}
