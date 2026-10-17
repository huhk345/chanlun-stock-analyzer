/**
 * 缠论 Node 后端
 *
 * 前端把 K 线数据 POST 到这里, 由服务端完成:
 *   - 缠论结构计算 (合并K线/分型/笔/线段/中枢)
 *   - 三类买卖点识别 (一买/二买/三买 + 一卖/二卖/三卖)
 *   - K 线拉取: GET /api/klines 由服务端访问腾讯行情 (默认, 免 Key) 并以
 *     TickFlow 作兜底, 本地磁盘缓存 + 增量更新 (前端不再直连免费接口)
 *   - 买卖点扫描: WebSocket /ws 前端只下发扫描请求, 数据拉取、
 *     缠论计算、信号行生成与资金流补充全部在服务端完成, 结果增量推送回前端
 *
 * 启动: pnpm server   (默认端口 8899, 可用 PORT 覆盖)
 */
import http from 'node:http';
import type { Kline } from '../src/types/stock.ts';
import { computeStrokesAndBSPoints, runChanlunPipeline } from '../src/utils/chanlun.ts';
import { loadStrategies } from '../src/strategies/user/index.ts';
import { getKlines } from './klines.ts';
import type { KlinePeriod } from '../src/utils/klineUtils.ts';
import { attachWebSocketServer } from './ws.ts';
import { handleScanConnection, WS_PATH } from './scanSocket.ts';
import { getCacheSnapshot } from './scan.ts';

const PORT = Number(process.env.PORT || 8899);

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

async function readJson<T = Record<string, unknown>>(req: http.IncomingMessage): Promise<T> {
  const raw = await readBody(req);
  if (!raw) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { statusCode: 400 });
  }
}

function isKlineArray(v: unknown): v is Kline[] {
  return (
    Array.isArray(v) &&
    v.every(
      (k) =>
        k &&
        typeof k === 'object' &&
        typeof (k as Kline).date === 'string' &&
        typeof (k as Kline).close === 'number' &&
        typeof (k as Kline).high === 'number' &&
        typeof (k as Kline).low === 'number' &&
        typeof (k as Kline).volume === 'number',
    )
  );
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }

  if (req.method === 'GET' && path === '/api/health') {
    sendJson(res, 200, { ok: true, uptime: process.uptime() });
    return;
  }

  if (req.method === 'GET' && path === '/api/klines') {
    const symbol = url.searchParams.get('symbol');
    if (!symbol) throw Object.assign(new Error('symbol required'), { statusCode: 400 });
    const period: KlinePeriod = url.searchParams.get('period') === '1w' ? '1w' : '1d';
    const rawCount = parseInt(url.searchParams.get('count') || '400', 10);
    const count = Math.min(Math.max(Number.isFinite(rawCount) ? rawCount : 400, 30), 5000);
    const adjust = url.searchParams.get('adjust') || 'forward';
    const force = url.searchParams.get('refresh') === '1' || url.searchParams.get('force') === '1';
    const result = await getKlines(symbol, period, count, adjust, force);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'GET' && path === '/api/strategies') {
    const strategies = await loadStrategies();
    sendJson(res, 200, {
      strategies: strategies.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        requiresChanLun: !!s.requiresChanLun,
        params: s.params ?? [],
      })),
    });
    return;
  }

  // 扫描缓存快照 (与 WebSocket `cache` 消息同源, 便于排障/脚本化读取)
  if (req.method === 'GET' && path === '/api/scan/cache') {
    const timeframe = url.searchParams.get('timeframe') === 'weekly' ? 'weekly' : 'daily';
    sendJson(res, 200, { timeframe, ...(await getCacheSnapshot(timeframe)) });
    return;
  }

  if (req.method === 'POST' && path === '/api/chanlun/analyze') {
    const body = await readJson<{ klines?: unknown }>(req);
    if (!isKlineArray(body.klines)) throw Object.assign(new Error('klines: Kline[] required'), { statusCode: 400 });
    sendJson(res, 200, runChanlunPipeline(body.klines));
    return;
  }

  if (req.method === 'POST' && path === '/api/chanlun/bspoints') {
    const body = await readJson<{ klines?: unknown }>(req);
    if (!isKlineArray(body.klines)) throw Object.assign(new Error('klines: Kline[] required'), { statusCode: 400 });
    // 买卖点只依赖 笔 (笔内部不依赖 线段/中枢), 跳过两遍计算保持扫描轻量
    sendJson(res, 200, computeStrokesAndBSPoints(body.klines));
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    const status = typeof err?.statusCode === 'number' ? err.statusCode : 500;
    console.error(`[server] ${req.method} ${req.url} -> ${status}:`, err?.message ?? err);
    sendJson(res, status, { error: err?.message ?? String(err) });
  });
});

// 缠论买卖点扫描: 浏览器只发扫描请求, 数据与计算都在服务端完成
attachWebSocketServer(server, WS_PATH, handleScanConnection);

server.listen(PORT, () => {
  console.log(`[chanlun-server] listening on http://localhost:${PORT} (scan websocket: ws://localhost:${PORT}${WS_PATH})`);
});
