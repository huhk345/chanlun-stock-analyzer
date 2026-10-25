/**
 * 缠论买卖点 K 线服务端数据层。
 *
 * 前端不再直连上游, 而是请求后端 `/api/klines`;
 * 由本模块负责:
 *   - 调用 K 线数据源获取 K 线 (默认腾讯, 无频率限制; TickFlow 作为兜底)
 *   - 将结果缓存到本地磁盘 (默认 .cache/klines/)
 *   - 统一数据窗口: 只保留 2023-01-01 (KLINE_START_DATE) 至今的 K 线,
 *     扫描、回测与 HTTP 接口使用的区间完全一致
 *   - 增量获取: 缓存已存在时, 只按缺口拉取少量最新 K 线, 并额外多取几根
 *     与缓存重叠; 若重叠日的价格不一致 (除权除息会让前复权历史价整体变化),
 *     自动改为全量刷新, 避免新旧复权口径混在同一份缓存里
 *
 * 缓存新鲜度按"末根 K 线日期 vs 预期最新交易日"判断 (节假日忽略),
 * 未过期直接返回本地缓存, 过期才发起增量请求。
 * 若某次成功拉取后末根日期仍未前进 (停牌/退市/上游暂无新数据), 则以
 * 该次写缓存的时间作为"已核验到该预期交易日"的依据, 当日不再重复请求,
 * 避免停牌股在每次扫描时被反复拉取。
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
  estimateBarsSince,
  expectedTradeDay,
  expectedTradeDayAt,
  extractRateLimitDelay,
  isFresh,
  KLINE_START_DATE,
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
  /**
   * 是否已确认拉到了该标的可用的最早历史 (或已覆盖 KLINE_START_DATE)。
   * 旧缓存没有该字段: 若最早一根不晚于 KLINE_START_DATE 视为已覆盖,
   * 否则首次读取时触发一次全量回补。
   */
  historyComplete?: boolean;
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

function writeCache(
  symbol: string,
  period: KlinePeriod,
  adjust: string,
  klines: Kline[],
  historyComplete: boolean,
): number {
  const updatedAt = Date.now();
  const payload: CacheFile = { symbol, period, adjust, updatedAt, klines, historyComplete };
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

/** 缓存是否已覆盖统一起始日 (或该标的的上市起点) */
function cacheCoversWindow(cache: CacheFile): boolean {
  if (cache.historyComplete === true) return true;
  const first = cache.klines[0]?.date;
  return !!first && first <= KLINE_START_DATE;
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
// 增量合并 / 复权校验
// ---------------------------------------------------------------------------

/**
 * 增量拉取时额外多取的根数, 与缓存尾部重叠。
 * 前复权价以最新价为锚点, 除权除息会让全部历史价格按同一比例变化,
 * 仅靠"按日期覆盖合并"发现不了, 必须用重叠 bar 对比才能识别。
 */
const INCREMENTAL_OVERLAP_BARS = 10;

/**
 * 重叠 bar 收盘价的相对偏差阈值 (默认 0.05%)。
 * 除权除息通常让价格变化 0.1% 以上; 阈值太小会被数据源四舍五入误伤,
 * 另加 0.005 元绝对容差覆盖 2 位小数的取整误差。
 * 可用 KLINE_ADJUST_TOLERANCE 环境变量覆盖。
 */
const ADJUST_MISMATCH_TOLERANCE = (() => {
  const raw = parseFloat(process.env.KLINE_ADJUST_TOLERANCE || '');
  return Number.isFinite(raw) && raw > 0 ? raw : 0.0005;
})();

/**
 * 计算本次需要向上游拉取的 K 线条数。
 * - 无缓存 / 缓存未覆盖统一起始日 / 强制刷新: 直接取满窗口
 * - 增量: 按距预期交易日的缺口估算需要的条数, 再叠加重叠根数
 */
function computeFetchCount(
  prev: Kline[],
  period: KlinePeriod,
  windowCount: number,
  force: boolean,
  historyComplete: boolean,
): number {
  if (force || prev.length === 0 || !historyComplete) return windowCount;
  const last = prev[prev.length - 1].date;
  const gapDays = daysBetween(last, expectedTradeDay());
  const gapBars =
    gapDays <= 0
      ? 0
      : period === '1w'
        ? Math.ceil(gapDays / 7)
        : Math.ceil((gapDays * 5) / 7);
  // 已最新时也取少量, 既刷新最后一根未收盘 K 线, 又与缓存留出对比窗口。
  return Math.min(windowCount, Math.max(30, gapBars + INCREMENTAL_OVERLAP_BARS));
}

/**
 * 判断本次拉取是否已覆盖到 2023-01-01 (或该标的可用历史起点)。
 * 上游返回根数少于请求根数, 说明上市较晚/长期停牌, 没有更早的数据了。
 */
function isFetchComplete(fresh: Kline[], requested: number): boolean {
  if (fresh.length === 0) return false;
  return fresh[0].date <= KLINE_START_DATE || fresh.length < requested;
}

/**
 * 对比增量数据与缓存的重叠区间。
 * @returns true  = 价格不一致 (大概率除权/拆股, 需全量刷新缓存)
 *          false = 价格一致
 *          null  = 没有重叠日期, 无法判断
 */
function adjustmentChanged(prev: Kline[], fresh: Kline[]): boolean | null {
  const prevByDate = new Map(prev.map((k) => [k.date, k]));
  let compared = 0;
  for (const bar of fresh) {
    const old = prevByDate.get(bar.date);
    if (!old) continue;
    compared++;
    const diff = Math.abs(bar.close - old.close);
    const tolerance =
      Math.max(Math.abs(old.close), Math.abs(bar.close)) * ADJUST_MISMATCH_TOLERANCE + 0.005;
    if (diff > tolerance) return true;
  }
  return compared > 0 ? false : null;
}

// 同一标的并发请求去重: 扫描时多路请求相同 symbol 只发一次上游请求
const inflight = new Map<string, Promise<{ klines: Kline[]; updatedAt: number }>>();

/**
 * 获取 K 线 (带本地缓存 + 增量更新)。
 * 服务端数据窗口固定为 KLINE_START_DATE (2023-01-01) 至今,
 * 缓存、扫描、回测与 HTTP 接口拿到的时间区间保持一致。
 * @param count 兼容参数 (旧调用方仍会传入目标根数), 不再用于截断返回窗口
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
  const cachedWindow = cached ? cached.klines.filter((k) => k.date >= KLINE_START_DATE) : [];
  const lastDate = cachedWindow[cachedWindow.length - 1]?.date;
  const covered = cached ? cacheCoversWindow(cached) : false;

  // 末根 K 线落后于预期交易日, 但上次成功拉取本身已发生在该交易日之后:
  // 说明上游确实没有更新的数据 (停牌/退市等), 当日无需再次请求。
  const expected = expectedTradeDay();
  const syncedThrough = cached ? expectedTradeDayAt(cached.updatedAt) : '';
  const upToDate = isFresh(lastDate, period) || syncedThrough >= expected;

  // 缓存既新鲜又已覆盖统一起始日时才直接返回; 否则拉取/回补窗口
  if (!force && cached && covered && upToDate) {
    return {
      symbol,
      period,
      adjust,
      klines: cachedWindow,
      cached: true,
      updatedAt: cached.updatedAt,
    };
  }

  const windowCount = estimateBarsSince(KLINE_START_DATE, period);
  const key = `${symbol}|${period}|${adjust}`;
  let pending = inflight.get(key);
  if (!pending) {
    pending = (async () => {
      const prev = cached?.klines ?? [];
      const fetchCount = computeFetchCount(prev, period, windowCount, force, covered);
      const incremental = prev.length > 0 && covered && fetchCount < windowCount;
      console.log(
        `[klines] ${symbol} ${period}: ${PREFER_TICKFLOW ? 'TickFlow' : '腾讯'} · ${
          force
            ? `强制刷新 ${fetchCount} 根`
            : incremental
              ? `增量拉取 ${fetchCount} 根`
              : covered
                ? `全量拉取 ${fetchCount} 根`
                : `回补 2023-01-01 窗口 ${fetchCount} 根`
        }`,
      );

      let fresh = await fetchKlines(symbol, period, fetchCount, adjust);
      let replaceCache = false;
      let historyComplete = covered;

      if (incremental) {
        const changed = adjustmentChanged(prev, fresh);
        if (changed !== false) {
          // 除权除息后旧缓存的历史价仍是旧复权口径, 必须整段重取后替换,
          // 不能按日期覆盖合并; 无重叠时也保守刷新, 避免无法校验。
          const fullCount = Math.max(windowCount, prev.length);
          console.warn(
            `[klines] ${symbol} ${period}: ${changed ? '重叠区间价格不一致 (疑似除权除息)' : '增量数据与缓存无重叠'}, 改为全量刷新 ${fullCount} 根`,
          );
          fresh = await fetchKlines(symbol, period, fullCount, adjust);
          replaceCache = true;
          historyComplete = isFetchComplete(fresh, fullCount);
        }
      } else {
        historyComplete = isFetchComplete(fresh, fetchCount);
      }

      const mergedRaw = replaceCache ? fresh : mergeKlinesByDate(prev, fresh);
      // 统一起始日之前的历史价不再保留, 避免不同窗口/复权口径混用
      const merged = mergedRaw.filter((k) => k.date >= KLINE_START_DATE);
      const updatedAt = writeCache(symbol, period, adjust, merged, historyComplete);
      return { klines: merged, updatedAt };
    })();
    inflight.set(key, pending);
    pending.catch(() => {}).finally(() => {
      if (inflight.get(key) === pending) inflight.delete(key);
    });
  }

  const { klines, updatedAt } = await pending;
  return { symbol, period, adjust, klines, cached: false, updatedAt };
}
