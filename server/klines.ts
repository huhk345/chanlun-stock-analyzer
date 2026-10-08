/**
 * 缠论买卖点 K 线服务端数据层。
 *
 * 前端不再直连 TickFlow 免费接口, 而是请求后端 `/api/klines`;
 * 由本模块负责:
 *   - 调用 TickFlow API (免费接口或配置了 Key 的完整服务) 获取 K 线
 *   - 将结果缓存到本地磁盘 (默认 .cache/klines/)
 *   - 增量获取: 缓存已存在时, 只按缺口拉取少量最新 K 线, 与缓存按日期合并
 *
 * 缓存新鲜度按"末根 K 线日期 vs 预期最新交易日"判断 (节假日忽略),
 * 未过期直接返回本地缓存, 过期才发起增量请求。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Kline } from '../src/types/stock.ts';
import { acquireTickFlowSlot } from '../src/utils/rateLimiter.ts';

const TICKFLOW_API_KEY = process.env.TICKFLOW_API_KEY || process.env.VITE_TICKFLOW_API_KEY || '';
const TICKFLOW_BASE_URL = TICKFLOW_API_KEY ? 'https://api.tickflow.org' : 'https://free-api.tickflow.org';

const CACHE_DIR = process.env.KLINE_CACHE_DIR
  ? path.resolve(process.env.KLINE_CACHE_DIR)
  : path.resolve(import.meta.dirname, '..', '.cache', 'klines');

export type KlinePeriod = '1d' | '1w';

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
// 交易日 / 新鲜度
// ---------------------------------------------------------------------------

const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 86400000;

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
}

/**
 * 预期最新交易日 (北京时间 YYYY-MM-DD, 忽略节假日):
 * 16:00 前当日日 K 尚未生成, 回退到上一工作日; 周末再回退到周五。
 */
function expectedTradeDay(): string {
  const d = new Date(Date.now() + CHINA_OFFSET_MS);
  if (d.getUTCHours() < 16) d.setUTCDate(d.getUTCDate() - 1);
  const dow = d.getUTCDay();
  if (dow === 0) d.setUTCDate(d.getUTCDate() - 2);
  else if (dow === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** 缓存末根日期是否已覆盖预期最新交易日 */
function isFresh(lastDate: string | undefined, period: KlinePeriod): boolean {
  if (!lastDate) return false;
  const expected = expectedTradeDay();
  if (period === '1w') return daysBetween(lastDate, expected) <= 7;
  return lastDate >= expected;
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 解析限流提示里的重试等待时长 (ms), 如 "请 1500ms 后重试" */
function extractRateLimitDelay(text: string): number | null {
  const ms = text.match(/请\s*(\d+)\s*ms\s*后重试/);
  if (ms) return parseInt(ms[1], 10);
  const sec = text.match(/请\s*(\d+(?:\.\d+)?)\s*秒?\s*后重试/);
  if (sec) return Math.ceil(parseFloat(sec[1]) * 1000);
  return null;
}

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

      const klines: Kline[] = [];
      for (let i = 0; i < length; i++) {
        const date = new Date(data.timestamp[i] + CHINA_OFFSET_MS);
        const dateStr = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
        klines.push({
          date: dateStr,
          open: parseFloat(data.open[i].toFixed(2)),
          high: parseFloat(data.high[i].toFixed(2)),
          low: parseFloat(data.low[i].toFixed(2)),
          close: parseFloat(data.close[i].toFixed(2)),
          volume: data.volume[i] || 0,
          amount: data.amount[i] || 0,
        });
      }
      return klines;
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
// 增量合并
// ---------------------------------------------------------------------------

/** 按日期合并: 新数据覆盖同日期旧数据, 返回按日期升序的完整序列 */
function mergeKlines(prev: Kline[], next: Kline[]): Kline[] {
  const byDate = new Map<string, Kline>();
  for (const k of prev) byDate.set(k.date, k);
  for (const k of next) byDate.set(k.date, k);
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

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
        `[klines] ${symbol} ${period}: ${force ? '强制刷新' : prev.length ? `增量拉取 ${fetchCount} 根` : `首次全量 ${fetchCount} 根`}`,
      );
      const fresh = await fetchFromTickFlow(symbol, period, fetchCount, adjust);
      const merged = mergeKlines(prev, fresh);
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
