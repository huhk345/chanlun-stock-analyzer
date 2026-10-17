/**
 * 缠论买卖点 K 线服务端数据层。
 *
 * 前端不再直连上游, 而是请求后端 `/api/klines`;
 * 由本模块负责:
 *   - 调用 K 线数据源获取 K 线 (默认腾讯, 无频率限制; TickFlow 作为兜底)
 *   - 将结果缓存到本地磁盘 (默认 .cache/klines/)
 *   - 增量获取: 缓存已存在时, 只按缺口拉取少量最新 K 线, 与缓存按日期合并
 *
 * 缓存新鲜度按"末根 K 线日期 vs 预期最新交易日"判断 (节假日忽略),
 * 未过期直接返回本地缓存, 过期才发起增量请求。
 *
 * 数据源优先级 (环境变量 KLINE_SOURCE 可强制指定 tencent / tickflow):
 *   - tencent  (默认): 腾讯行情 newfqkline, 免 Key, 免公开限流, 单只约 0.25s;
 *                     限速与域名轮换见 tencentKlines.ts (默认 15 次/秒)
 *   - tickflow (兜底) : 免费接口硬顶 60 次/分钟, 仅在腾讯失败时兜底
 * 两者字段口径一致 (成交量均为"手"), 切换数据源无需清空本地缓存。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Kline } from '../src/types/stock.ts';
import { acquireTickFlowSlot } from '../src/utils/rateLimiter.ts';
import { sleep } from '../src/utils/async.ts';
import {
  daysBetween,
  expectedTradeDay,
  extractRateLimitDelay,
  isFresh,
  mergeKlinesByDate,
  parseTickflowColumns,
  type KlinePeriod,
} from '../src/utils/klineUtils.ts';
import { fetchTencentKlines } from './tencentKlines.ts';

const TICKFLOW_API_KEY = process.env.TICKFLOW_API_KEY || process.env.VITE_TICKFLOW_API_KEY || '';
const TICKFLOW_BASE_URL = TICKFLOW_API_KEY ? 'https://api.tickflow.org' : 'https://free-api.tickflow.org';

const CACHE_DIR = process.env.KLINE_CACHE_DIR
  ? path.resolve(process.env.KLINE_CACHE_DIR)
  : path.resolve(import.meta.dirname, '..', '.cache', 'klines');

interface CacheFile {
  symbol: string;
  period: KlinePeriod;
  adjust: string;
  updatedAt: number;
  klines: Kline[];
}

export interface KlineQueryResult {
  symbol: string;
  period: KlinePeriod;
  adjust: string;
  klines: Kline[];
  /** 是否整段来自本地缓存 (未发起 TickFlow 请求) */
  cached: boolean;
  /** 本地缓存最后写入时间 (毫秒) */
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// 本地缓存读写
// ---------------------------------------------------------------------------

function cacheFile(symbol: string, period: KlinePeriod, adjust: string): string {
  const safe = `${symbol}_${period}_${adjust}`.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(CACHE_DIR, `${safe}.json`);
}

function readCache(symbol: string, period: KlinePeriod, adjust: string): CacheFile | null {
  try {
    const raw = fs.readFileSync(cacheFile(symbol, period, adjust), 'utf-8');
    const parsed = JSON.parse(raw) as CacheFile;
    if (!parsed || !Array.isArray(parsed.klines) || parsed.klines.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(symbol: string, period: KlinePeriod, adjust: string, klines: Kline[]): number {
  const updatedAt = Date.now();
  const payload: CacheFile = { symbol, period, adjust, updatedAt, klines };
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    // 先写临时文件再重命名, 避免并发/中断留下半截 JSON
    const target = cacheFile(symbol, period, adjust);
    const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, target);
  } catch (err) {
    console.warn(`[klines] 写入缓存失败 ${symbol} ${period}:`, err);
  }
  return updatedAt;
}

// ---------------------------------------------------------------------------
// TickFlow 请求
// ---------------------------------------------------------------------------

/** 调用 TickFlow 并解析列式返回为 Kline[] (与前端旧逻辑一致, 北京时间归一化日期) */
async function fetchFromTickFlow(
  symbol: string,
  period: KlinePeriod,
  count: number,
  adjust: string,
): Promise<Kline[]> {
  const url = `${TICKFLOW_BASE_URL}/v1/klines?symbol=${encodeURIComponent(symbol)}&period=${period}&count=${count}&adjust=${encodeURIComponent(adjust)}`;

  const headers: Record<string, string> = {};
  if (TICKFLOW_API_KEY) headers['x-api-key'] = TICKFLOW_API_KEY;

  const MAX_RETRIES = 4;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // 主动限流到 55/min, 低于免费接口 60/min 硬顶
    await acquireTickFlowSlot();

    let resp: Response;
    try {
      resp = await fetch(url, { headers });
    } catch (err: any) {
      lastError = new Error(err?.message || 'TickFlow 网络请求失败');
      if (attempt < MAX_RETRIES) {
        await sleep(1200);
        continue;
      }
      throw lastError;
    }

    if (resp.ok) {
      const json = await resp.json();
      const data = json?.data;
      const length = data?.timestamp?.length || 0;
      if (!data || length === 0) throw new Error(`TickFlow 未返回 ${symbol} 的K线数据`);

      return parseTickflowColumns(data);
    }

    const errorText = await resp.text();
    if (resp.status === 429) {
      const delayMs = extractRateLimitDelay(errorText) ?? attempt * 2000 + 1000;
      if (attempt < MAX_RETRIES) {
        await sleep(delayMs);
        continue;
      }
      throw new Error(`TickFlow 免费接口请求频率超限 (60/min), 请稍后重试`);
    }

    throw new Error(`TickFlow 接口错误 (${resp.status})${errorText ? ` - ${errorText.slice(0, 200)}` : ''}`);
  }

  throw lastError ?? new Error(`获取 ${symbol} K线失败`);
}

// ---------------------------------------------------------------------------
// 数据源路由: 腾讯优先 (无限流), TickFlow 兜底
// ---------------------------------------------------------------------------

/** KLINE_SOURCE=tickflow 可强制走旧数据源排障; 默认腾讯优先 */
const PREFER_TICKFLOW = (process.env.KLINE_SOURCE || '').toLowerCase() === 'tickflow';

/**
 * 拉取 K 线 (腾讯优先, 失败自动回退 TickFlow)。
 * 两只上游的返回值口径一致, 因此调用方无需关心实际数据源。
 */
async function fetchKlines(
  symbol: string,
  period: KlinePeriod,
  count: number,
  adjust: string,
): Promise<Kline[]> {
  if (PREFER_TICKFLOW) return fetchFromTickFlow(symbol, period, count, adjust);
  try {
    return await fetchTencentKlines(symbol, period, count, adjust);
  } catch (err) {
    console.warn(
      `[klines] 腾讯获取 ${symbol} ${period} 失败, 回退 TickFlow:`,
      err instanceof Error ? err.message : err,
    );
    return fetchFromTickFlow(symbol, period, count, adjust);
  }
}

// ---------------------------------------------------------------------------
// 增量合并
// ---------------------------------------------------------------------------

/**
 * 计算本次需要向 TickFlow 拉取的 K 线条数。
 * - 无缓存 / 缓存不足目标窗口 / 强制刷新: 直接取满 count
 * - 增量: 按距预期交易日的缺口估算需要的条数, 再叠少量缓冲
 */
function computeFetchCount(prev: Kline[], period: KlinePeriod, count: number, force: boolean): number {
  if (force || prev.length === 0 || prev.length < count) return count;
  const last = prev[prev.length - 1].date;
  const gapDays = daysBetween(last, expectedTradeDay());
  if (gapDays <= 0) return Math.min(count, 30); // 已最新, 仍取少量以捕捉当日收盘更新
  const bars = period === '1w' ? Math.ceil(gapDays / 7) + 5 : Math.ceil((gapDays * 5) / 7) + 5;
  return Math.max(20, Math.min(count, bars));
}

// 同一标的并发请求去重: 扫描时多路请求相同 symbol 只发一次上游请求
const inflight = new Map<string, Promise<{ klines: Kline[]; updatedAt: number }>>();

/**
 * 获取 K 线 (带本地缓存 + 增量更新)。
 * @param count 目标返回条数 (取合并后最近的 count 根)
 * @param force 忽略新鲜度, 强制重新拉取
 */
export async function getKlines(
  symbol: string,
  period: KlinePeriod,
  count: number,
  adjust = 'forward',
  force = false,
): Promise<KlineQueryResult> {
  const cached = readCache(symbol, period, adjust);
  const lastDate = cached?.klines[cached.klines.length - 1]?.date;

  // 缓存既新鲜又已覆盖目标窗口时才直接返回; 窗口不足则继续拉取补齐
  if (!force && cached && cached.klines.length >= count && isFresh(lastDate, period)) {
    return {
      symbol,
      period,
      adjust,
      klines: cached.klines.slice(-count),
      cached: true,
      updatedAt: cached.updatedAt,
    };
  }

  const key = `${symbol}|${period}|${adjust}`;
  let pending = inflight.get(key);
  if (!pending) {
    pending = (async () => {
      const prev = cached?.klines ?? [];
      const fetchCount = computeFetchCount(prev, period, count, force);
      console.log(
        `[klines] ${symbol} ${period}: ${PREFER_TICKFLOW ? 'TickFlow' : '腾讯'} · ${force ? '强制刷新' : prev.length ? `增量拉取 ${fetchCount} 根` : `首次全量 ${fetchCount} 根`}`,
      );
      const fresh = await fetchKlines(symbol, period, fetchCount, adjust);
      const merged = mergeKlinesByDate(prev, fresh);
      const updatedAt = writeCache(symbol, period, adjust, merged);
      return { klines: merged, updatedAt };
    })();
    inflight.set(key, pending);
    pending.catch(() => {}).finally(() => {
      if (inflight.get(key) === pending) inflight.delete(key);
    });
  }

  const { klines, updatedAt } = await pending;
  return { symbol, period, adjust, klines: klines.slice(-count), cached: false, updatedAt };
}
