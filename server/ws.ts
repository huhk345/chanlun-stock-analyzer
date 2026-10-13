/**
 * 极简 RFC 6455 WebSocket 服务端 (无第三方依赖)。
 *
 * 只实现本项目需要的部分: HTTP Upgrade 握手 + 文本帧收发 + 分片重组 +
 * ping/pong + close。前端扫描页面通过它接收后端推送的缠论买卖点结果,
 * 避免再上传几十万根 K 线到服务端计算。
 */
import crypto from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 单条消息上限 (扫描请求很小, 1MB 足够, 同时作为恶意长度头的兜底) */
const MAX_MESSAGE_BYTES = 1024 * 1024;

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** 服务端 -> 客户端的帧不加掩码 (RFC 6455 §5.1) */
function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, payload]);
}

export class WebSocketPeer {
  /** 收到一条完整文本消息 */
  onMessage: (data: string) => void = () => {};
  /** 连接关闭 (正常关闭或异常断开都会触发一次) */
  onClose: () => void = () => {};

  private buf: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentsSize = 0;
  private closed = false;

  constructor(private readonly socket: Socket) {
    socket.setNoDelay(true);
    socket.setTimeout(0);
    socket.on('data', (chunk: Buffer) => this.push(chunk));
    socket.on('error', () => this.destroy());
    socket.on('close', () => this.finish());
  }

  get open(): boolean {
    return !this.closed && this.socket.writable;
  }

  /** Upgrade 阶段可能已带上首帧数据, 需手动喂一次 */
  push(chunk: Buffer): void {
    if (this.closed || !chunk?.length) return;
    this.buf = this.buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buf, chunk]);
    while (!this.closed) {
      const frame = this.readFrame();
      if (!frame) break;
      this.handleFrame(frame);
    }
  }

  /** 发送一条文本消息; 连接已断开时返回 false (不抛异常) */
  send(data: string): boolean {
    if (!this.open) return false;
    try {
      this.socket.write(encodeFrame(OP_TEXT, Buffer.from(data, 'utf-8')));
      return true;
    } catch (err) {
      console.warn('[ws] 发送失败:', err);
      this.destroy();
      return false;
    }
  }

  /** 正常关闭 (先发 close 帧, 再断开) */
  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    try {
      const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
      payload.writeUInt16BE(code, 0);
      payload.write(reason, 2);
      this.socket.write(encodeFrame(OP_CLOSE, payload));
    } catch { /* 对端可能已断开 */ }
    this.destroy();
  }

  destroy(): void {
    try { this.socket.destroy(); } catch { /* ignore */ }
    this.finish();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.onClose();
  }

  /** 解析一帧; 数据不足时返回 null 等待下一次 data */
  private readFrame(): { fin: boolean; opcode: number; payload: Buffer } | null {
    const buf = this.buf;
    if (buf.length < 2) return null;

    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset);
      offset += 8;
      if (big > BigInt(MAX_MESSAGE_BYTES)) {
        this.close(1009, 'message too large');
        return null;
      }
      len = Number(big);
    }
    if (len > MAX_MESSAGE_BYTES) {
      this.close(1009, 'message too large');
      return null;
    }
    // 客户端发往服务端的帧必须掩码
    if (!masked) {
      this.close(1002, 'unmasked client frame');
      return null;
    }
    if (buf.length < offset + 4 + len) return null;

    const mask = buf.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) payload[i] = buf[offset + i] ^ mask[i & 3];

    this.buf = Buffer.from(buf.subarray(offset + len));
    return { fin, opcode, payload };
  }

  private handleFrame(frame: { fin: boolean; opcode: number; payload: Buffer }): void {
    const { fin, opcode, payload } = frame;

    if (opcode === OP_CLOSE) {
      this.close(1000);
      return;
    }
    if (opcode === OP_PING) {
      try { this.socket.write(encodeFrame(OP_PONG, payload)); } catch { this.destroy(); }
      return;
    }
    if (opcode === OP_PONG) return;
    if (opcode === OP_BINARY) {
      this.close(1003, 'binary unsupported');
      return;
    }
    if (opcode !== OP_TEXT && opcode !== OP_CONTINUATION) {
      this.close(1002, `unsupported opcode ${opcode}`);
      return;
    }

    this.fragments.push(payload);
    this.fragmentsSize += payload.length;
    if (this.fragmentsSize > MAX_MESSAGE_BYTES) {
      this.close(1009, 'message too large');
      return;
    }
    if (!fin) return;

    const full = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments, this.fragmentsSize);
    this.fragments = [];
    this.fragmentsSize = 0;
    this.onMessage(full.toString('utf-8'));
  }
}

/**
 * 把 WebSocket 能力挂到已有 http.Server 上。
 * 非目标路径的 upgrade 请求直接断开 (避免连接悬挂)。
 */
export function attachWebSocketServer(
  server: Server,
  path: string,
  onConnection: (peer: WebSocketPeer) => void,
): void {
  server.on('upgrade', (req: IncomingMessage, stream, head: Buffer) => {
    // upgrade 回调拿到的是已握手的 TCP 连接 (http-proxy 的类型标注为通用 Duplex)
    const socket = stream as Socket;
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== path) {
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    const version = String(req.headers['sec-websocket-version'] || '');
    if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || typeof key !== 'string' || version !== '13') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    const peer = new WebSocketPeer(socket);
    if (head?.length) peer.push(head);
    onConnection(peer);
  });
}
