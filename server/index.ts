/**
 * 缠论买卖点 / 选股 Node 后端
 *
 * 前端把 K 线数据 POST 到这里, 由服务端完成:
 *   - 缠论结构计算 (合并K线/分型/笔/线段/中枢)
 *   - 三类买卖点识别 (一买/二买/三买 + 一卖/二卖/三卖)
 *   - 选股信号评估 (用策略 decide() 对最新 K 线打 BUY/SELL/HOLD)
 *
 * 启动: pnpm server   (默认端口 8899, 可用 PORT 覆盖)
 */
import http from 'node:http';
import type { Kline } from '../src/types/stock.ts';
import type { StrategyParamValue, StoredStrategy, UserStrategyDefinition } from '../src/types/strategy.ts';
import {
  mergeKlines,
  findFractions,
  calculateStrokes,
  calculateSegments,
  calculateHubs,
  calculateBSPoints,
} from '../src/utils/chanlun.ts';
import { evaluateScreenerSignal } from '../src/utils/screener.ts';
import { loadStrategies } from '../src/strategies/user/index.ts';
import { parseStrategyCode } from '../src/utils/strategyLoader.ts';

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
// 缠论流水线
// ---------------------------------------------------------------------------

function analyzeChanlun(klines: Kline[]) {
  const mergedKlines = mergeKlines(klines);
  const fractions = findFractions(mergedKlines, klines);
  const strokes = calculateStrokes(fractions);
  const segments = calculateSegments(strokes);
  const hubs = calculateHubs(strokes);
  const bsPoints = calculateBSPoints(klines, strokes);
  return { mergedKlines, fractions, strokes, segments, hubs, bsPoints };
}

// ---------------------------------------------------------------------------
// 选股策略解析: 内建策略 id, 或 AI 创建策略的源码字符串
// ---------------------------------------------------------------------------

interface StrategyRequest {
  strategyId?: unknown;
  strategyCode?: unknown;
}

async function resolveStrategy(req: StrategyRequest): Promise<UserStrategyDefinition> {
  if (typeof req.strategyCode === 'string' && req.strategyCode.trim()) {
    return parseStrategyCode(req.strategyCode, {} as StoredStrategy);
  }
  if (typeof req.strategyId === 'string' && req.strategyId) {
    const strategies = await loadStrategies();
    const found = strategies.find((s) => s.id === req.strategyId);
    if (found) return found;
    throw Object.assign(new Error(`unknown strategyId: ${req.strategyId}`), { statusCode: 404 });
  }
  throw Object.assign(new Error('strategyId or strategyCode required'), { statusCode: 400 });
}

function asParams(v: unknown): Record<string, StrategyParamValue> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  return v as Record<string, StrategyParamValue>;
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

  if (req.method === 'POST' && path === '/api/chanlun/analyze') {
    const body = await readJson<{ klines?: unknown }>(req);
    if (!isKlineArray(body.klines)) throw Object.assign(new Error('klines: Kline[] required'), { statusCode: 400 });
    sendJson(res, 200, analyzeChanlun(body.klines));
    return;
  }

  if (req.method === 'POST' && path === '/api/chanlun/bspoints') {
    const body = await readJson<{ klines?: unknown }>(req);
    if (!isKlineArray(body.klines)) throw Object.assign(new Error('klines: Kline[] required'), { statusCode: 400 });
    // 买卖点只依赖 笔 (笔内部不依赖 线段/中枢), 跳过两遍计算保持扫描轻量
    const strokes = calculateStrokes(findFractions(mergeKlines(body.klines), body.klines));
    sendJson(res, 200, { strokes, bsPoints: calculateBSPoints(body.klines, strokes) });
    return;
  }

  if (req.method === 'POST' && path === '/api/screener/evaluate') {
    const body = await readJson<{ symbol?: unknown; klines?: unknown } & StrategyRequest>(req);
    if (!isKlineArray(body.klines)) throw Object.assign(new Error('klines: Kline[] required'), { statusCode: 400 });
    if (typeof body.symbol !== 'string' || !body.symbol) {
      throw Object.assign(new Error('symbol required'), { statusCode: 400 });
    }
    const strategy = await resolveStrategy(body);
    sendJson(res, 200, evaluateScreenerSignal(strategy, body.klines, body.symbol, asParams((body as { customParams?: unknown }).customParams)));
    return;
  }

  if (req.method === 'POST' && path === '/api/screener/batch') {
    const body = await readJson<{ stocks?: unknown } & StrategyRequest>(req);
    if (!Array.isArray(body.stocks)) throw Object.assign(new Error('stocks required'), { statusCode: 400 });
    const strategy = await resolveStrategy(body);
    const customParams = asParams((body as { customParams?: unknown }).customParams);
    const results = (body.stocks as Array<{ symbol?: unknown; klines?: unknown }>).map((s) => {
      if (typeof s.symbol !== 'string' || !isKlineArray(s.klines)) {
        return { symbol: String(s.symbol ?? ''), action: 'HOLD', error: 'bad-entry' };
      }
      return evaluateScreenerSignal(strategy, s.klines, s.symbol, customParams);
    });
    sendJson(res, 200, { results });
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

server.listen(PORT, () => {
  console.log(`[chanlun-server] listening on http://localhost:${PORT}`);
});
