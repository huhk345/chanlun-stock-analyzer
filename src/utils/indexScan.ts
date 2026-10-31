/**
 * 缠论买卖点扫描 —— 纯浏览器实现 (不依赖分析后端)
 *
 * 链路:
 *   成分股名单 (public/index-members.*.json)
 *     -> 腾讯行情前复权 K 线 (浏览器直连, 支持 CORS; 双域名互备)
 *     -> 本地缠论计算 (utils/chanlun.ts 的笔 + 三类买卖点)
 *     -> 最近 90 天窗口内的信号行
 *
 * 结果按周期缓存在 localStorage: 再次扫描时, 数据日期已达最新交易日的标的
 * 直接复用缓存 (不计入下载), 只重新拉取落后的标的。
 */
import type { Kline } from '../types/stock';
import { computeStrokesAndBSPoints } from './chanlun';
import { resolveSymbol } from './symbols';
import { daysBetween, expectedTradeDay, sanitizeKlines } from './klineUtils';
import {
  INDEX_META,
  SIGNAL_WINDOW_DAYS,
  type IndexId,
  type ScanCacheInfo,
  type ScanProgress,
  type ScanSignalRow,
  type ScanTimeframe,
} from '../types/scan';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * 行情源按顺序尝试, 一个被限流就整体切到下一个 (域名不同, 封禁互不影响)。
 *
 * 只用腾讯的两套等价接口 (不使用东方财富):
 *   - proxy.finance.qq.com/ifzqgtimg/...  网页端 CDN, 返回 newfqkline (带成交额, 单位万元)
 *   - web.ifzq.gtimg.cn/appstock/...      老接口, 只有 6 列 (无成交额, 需估算)
 * 两者对突发请求都可能返回 501 + HTML 反爬页, 所以互为备份。
 */
type KlineSourceId = 'qq-proxy' | 'qq-ifzq';

interface QqSource {
  url: string;
  /** 第 9 列成交额的单位换算 (proxy 为万元, 老接口没有该列) */
  amountScale: number;
}

const QQ_SOURCES: Record<KlineSourceId, QqSource> = {
  'qq-proxy': {
    url: 'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get',
    amountScale: 1e4,
  },
  'qq-ifzq': {
    url: 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get',
    amountScale: 1,
  },
};

const SOURCE_ORDER: KlineSourceId[] = ['qq-proxy', 'qq-ifzq'];


/** 日线取 400 根 (约 1.6 年), 足够笔/中枢成型 + 90 天信号窗口 */
const DAILY_BARS = 400;
/** 周线取 300 根 (约 6 年) */
const WEEKLY_BARS = 300;
/** 并发上限: 压到 2 路, 宁可慢也不触发反爬 */
const CONCURRENCY = 2;
/** 每个 worker 两次请求之间的最小间隔 (ms), 峰值约 3 次/秒 */
const REQUEST_GAP_MS = 500;
/** 连续失败达到该数量即判定接口被限流, 停止剩余标的 */
const FAILURE_BREAKER = 15;
/** 少于该根数无法形成有意义的笔 */
const MIN_BARS = 60;

const CACHE_VERSION = 1;
const CACHE_PREFIX = 'chanlun_scan_local';

// ---------------------------------------------------------------------------
// 数据结构
// ---------------------------------------------------------------------------

interface StockMeta {
  name?: string;
  industry?: string;
}

type MetaMap = Record<string, StockMeta>;

/** 单个标的的缓存: 数据日期 + 该标的的窗口内信号行 */
interface CachedSymbol {
  d: string;            // dataDate
  rows: ScanSignalRow[];
}

interface CacheFile {
  v: number;
  latestDate: string;
  symbols: Record<string, CachedSymbol>;
}

export interface ScanRequest {
  timeframe: ScanTimeframe;
  indexes: IndexId[];
  custom: string[];
  /** 忽略本地缓存, 全部重新拉取 */
  force?: boolean;
}

export interface ScanEvents {
  onProgress: (p: ScanProgress) => void;
  onRows: (rows: ScanSignalRow[]) => void;
  onDone: (info: ScanCacheInfo) => void;
  onError: (message: string) => void;
}

// ---------------------------------------------------------------------------
// 行情 / 名单 / 元数据
// ---------------------------------------------------------------------------

function baseUrl(): string {
  const base = (import.meta.env?.BASE_URL as string | undefined) || '/';
  return base.endsWith('/') ? base : `${base}/`;
}

interface FetchedKlines {
  klines: Kline[];
  /** 腾讯 qt 字段里的中文名 (自定义标的/ETF/指数可用) */
  name: string;
}

/**
 * 腾讯前复权 K 线 (两个域名接口结构一致, 只有成交额列的有无/单位不同)。
 * 行格式: [日期, 开, 收, 高, 低, 量(手), ...], 第 9 列 (index 8) 可能是成交额。
 * 缺成交额时用 收盘价 × 量 × 100 估算 (量单位为手)。
 */
async function fetchTencentKlines(
  txSymbol: string,
  timeframe: ScanTimeframe,
  signal: AbortSignal,
  source: QqSource,
): Promise<FetchedKlines> {
  const granularity = timeframe === 'weekly' ? 'week' : 'day';
  const bars = timeframe === 'weekly' ? WEEKLY_BARS : DAILY_BARS;
  const param = `${txSymbol},${granularity},,,${bars},qfq`;
  const resp = await fetch(`${source.url}?param=${encodeURIComponent(param)}`, { signal });
  if (!resp.ok) {
    // 501/403 是反爬响应 (返回 HTML 而非 JSON), 重试无意义, 交给上层换源
    if (resp.status === 501 || resp.status === 403 || resp.status === 429) {
      throw new KlineSourceError(`行情接口限流 (HTTP ${resp.status})`, true);
    }
    throw new KlineSourceError(`行情接口 HTTP ${resp.status}`, true);
  }

  const json = await resp.json();
  const node = json?.data?.[txSymbol];
  const rows: unknown[] =
    node?.[timeframe === 'weekly' ? 'qfqweek' : 'qfqday'] ??
    node?.[granularity] ??
    node?.qfqday ??
    node?.day ??
    [];
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new KlineSourceError('未返回K线', false);
  }

  const klines: Kline[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const date = String(row[0]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const close = parseFloat(String(row[2])) || 0;
    const volume = parseFloat(String(row[5])) || 0;
    if (close <= 0) continue;
    const amountField = parseFloat(String(row[8])) * source.amountScale;
    klines.push({
      date,
      open: parseFloat(String(row[1])) || close,
      close,
      high: parseFloat(String(row[3])) || close,
      low: parseFloat(String(row[4])) || close,
      volume,
      amount: amountField > 0 ? amountField : close * volume * 100,
    });
  }

  const qtName = String(node?.qt?.[txSymbol]?.[1] ?? '').trim();
  return { klines: sanitizeKlines(klines), name: qtName };
}

/**
 * 行情源错误。
 * `fatal` 表示这个源本身不可用 (限流 / 网络 / 5xx), 应当在本轮扫描里剔除;
 * 非 fatal (该标的没有数据、停牌等) 只影响当前标的, 换下一个源再试即可。
 */
class KlineSourceError extends Error {
  constructor(message: string, readonly fatal: boolean) {
    super(message);
    this.name = 'KlineSourceError';
  }
}

/**
 * 本次扫描的行情源池。
 * 请求在存活源之间轮转 (每个源只承担一部分流量, 不容易触发限流),
 * 某个源出现 fatal 错误就剔除; 下一轮扫描会重新尝试全部源, 因为封禁会解除。
 */
class SourcePool {
  private alive: KlineSourceId[] = [...SOURCE_ORDER];
  private cursor = 0;

  /** 本轮可用的源 (从 cursor 开始轮转), 同时推进指针 */
  candidates(): KlineSourceId[] {
    if (this.alive.length === 0) return [];
    const start = this.cursor % this.alive.length;
    this.cursor++;
    return [...this.alive.slice(start), ...this.alive.slice(0, start)];
  }

  kill(source: KlineSourceId): void {
    this.alive = this.alive.filter(s => s !== source);
  }
}

async function fetchBySource(
  source: KlineSourceId,
  symbolKey: string,
  timeframe: ScanTimeframe,
  signal: AbortSignal,
): Promise<FetchedKlines> {
  try {
    const { txSymbol } = resolveSymbol(symbolKey);
    return await fetchTencentKlines(txSymbol, timeframe, signal, QQ_SOURCES[source]);
  } catch (err) {
    if (err instanceof KlineSourceError || signal.aborted) throw err;
    // fetch 自身抛错 (断连 / DNS / TLS) 一律视为该源不可用
    throw new KlineSourceError(err instanceof Error ? err.message : '行情请求失败', true);
  }
}

/**
 * 按源池轮转拉 K 线: 一个源拿不到就换下一个源试同一个标的,
 * 全部源都失败才抛错 (调用方计入 failed)。
 */
async function fetchKlines(
  symbolKey: string,
  timeframe: ScanTimeframe,
  signal: AbortSignal,
  pool: SourcePool,
): Promise<FetchedKlines> {
  const candidates = pool.candidates();
  if (candidates.length === 0) {
    throw new KlineSourceError('所有行情源均不可用', true);
  }

  let lastError: unknown = null;
  for (const source of candidates) {
    try {
      return await fetchBySource(source, symbolKey, timeframe, signal);
    } catch (err) {
      if (signal.aborted) throw err;
      lastError = err;
      if (err instanceof KlineSourceError && err.fatal) pool.kill(source);
    }
  }
  throw lastError ?? new KlineSourceError('行情源均不可用', true);
}

/** 成分股名单 (public/index-members.*.json) */
async function loadMembers(indexes: IndexId[]): Promise<string[]> {
  const lists = await Promise.all(
    indexes.map(async (id) => {
      const resp = await fetch(`${baseUrl()}${INDEX_META[id].file}`);
      if (!resp.ok) throw new Error(`${INDEX_META[id].label}成分股名单加载失败 (HTTP ${resp.status})`);
      const arr = await resp.json();
      return Array.isArray(arr) ? (arr as string[]) : [];
    }),
  );
  return lists.flat();
}

/** 名称/行业字典 (public/merged_stock_data.json), 失败不阻塞扫描 */
let metaPromise: Promise<MetaMap> | null = null;
function loadMeta(): Promise<MetaMap> {
  if (!metaPromise) {
    metaPromise = (async () => {
      try {
        const resp = await fetch(`${baseUrl()}merged_stock_data.json`);
        if (!resp.ok) return {};
        const raw = (await resp.json()) as Record<string, { stock_name?: string; industry?: string }>;
        const map: MetaMap = {};
        for (const [code, v] of Object.entries(raw)) {
          if (!v) continue;
          map[code] = { name: v.stock_name || undefined, industry: v.industry || undefined };
        }
        return map;
      } catch {
        return {};
      }
    })();
  }
  return metaPromise;
}

/** 最新交易日: 以上证指数末根日K为准 (比"忽略节假日的预期交易日"准确) */
async function fetchLatestTradeDate(signal: AbortSignal, pool: SourcePool): Promise<string> {
  try {
    const { klines } = await fetchKlines('000001.SH', 'daily', signal, pool);
    const last = klines[klines.length - 1];
    if (last) return last.date;
  } catch {
    /* 失败时退回本地推算 */
  }
  // 不能用"今天": 周末/盘前会把所有缓存都判成过期, 触发全量重拉
  return expectedTradeDay();
}

// ---------------------------------------------------------------------------
// 单标的计算
// ---------------------------------------------------------------------------

function volRatioOf(klines: Kline[]): number | undefined {
  if (klines.length < 7) return undefined;
  const last = klines[klines.length - 1];
  if (!(last.volume > 0)) return undefined;
  const prev = klines.slice(-6, -1);
  const avg = prev.reduce((s, k) => s + k.volume, 0) / prev.length;
  if (!(avg > 0)) return undefined;
  return last.volume / avg;
}

/** 近5日日均成交额 (亿元) */
function amount5Of(klines: Kline[]): number | undefined {
  if (klines.length < 5) return undefined;
  const last5 = klines.slice(-5);
  const avg = last5.reduce((s, k) => s + (k.amount || 0), 0) / last5.length;
  return avg > 0 ? avg / 1e8 : undefined;
}

function buildRows(
  symbolKey: string,
  klines: Kline[],
  meta: MetaMap,
  fallbackName: string,
): ScanSignalRow[] {
  const { strokes, bsPoints } = computeStrokesAndBSPoints(klines);
  if (bsPoints.length === 0) return [];

  const last = klines[klines.length - 1];
  const code = symbolKey.split('.')[0];
  const info = meta[code];
  const name = info?.name || fallbackName || undefined;
  const volRatio = volRatioOf(klines);
  const amount5 = amount5Of(klines);
  const rows: ScanSignalRow[] = [];

  for (const bp of bsPoints) {
    const daysAgo = daysBetween(bp.date, last.date);
    if (daysAgo < 0 || daysAgo > SIGNAL_WINDOW_DAYS) continue;
    rows.push({
      id: `${symbolKey}-${bp.type}-${bp.date}`,
      symbolKey,
      code,
      name,
      industryPath: info?.industry || undefined,
      type: bp.type,
      label: bp.label,
      date: bp.date,
      price: bp.price,
      lastClose: last.close,
      dataDate: last.date,
      daysAgo,
      changeSincePct: bp.price > 0 ? ((last.close - bp.price) / bp.price) * 100 : 0,
      strokeUp: strokes[bp.strokeIndex]?.direction === 'up',
      volRatio,
      amount5,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 缓存
// ---------------------------------------------------------------------------

function cacheKey(timeframe: ScanTimeframe): string {
  return `${CACHE_PREFIX}_${timeframe}`;
}

function readCache(timeframe: ScanTimeframe): CacheFile {
  const empty: CacheFile = { v: CACHE_VERSION, latestDate: '', symbols: {} };
  try {
    const raw = localStorage.getItem(cacheKey(timeframe));
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as CacheFile;
    if (parsed?.v !== CACHE_VERSION || typeof parsed.symbols !== 'object') return empty;
    return { v: CACHE_VERSION, latestDate: parsed.latestDate || '', symbols: parsed.symbols || {} };
  } catch {
    return empty;
  }
}

function writeCache(timeframe: ScanTimeframe, file: CacheFile): void {
  try {
    localStorage.setItem(cacheKey(timeframe), JSON.stringify(file));
  } catch {
    /* 配额不足时放弃持久化, 不影响本次结果 */
  }
}

function rowsOf(file: CacheFile): ScanSignalRow[] {
  const out: ScanSignalRow[] = [];
  for (const entry of Object.values(file.symbols)) {
    if (entry?.rows?.length) out.push(...entry.rows);
  }
  out.sort((a, b) => b.date.localeCompare(a.date));
  return out;
}

function infoOf(file: CacheFile, timeframe: ScanTimeframe, latestDate: string): ScanCacheInfo {
  const count = Object.keys(file.symbols).length;
  return {
    timeframe,
    count,
    latestDate: file.latestDate,
    stale: count > 0 && !!latestDate && file.latestDate < latestDate,
  };
}

// ---------------------------------------------------------------------------
// 扫描引擎
// ---------------------------------------------------------------------------

export class IndexScanEngine {
  private running = false;
  private abort: AbortController | null = null;
  /** 最近一次扫描的缓存 (避免重复解析 localStorage) */
  private files = new Map<ScanTimeframe, CacheFile>();

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * 读取本地缓存快照 (页面挂载 / 切换周期时秒开)。
   * `stale` 用本地推算的预期交易日做粗判: 只用于决定是否自动跑一次增量扫描,
   * 真正是否重新下载由扫描时与上证指数末根日期比对决定。
   */
  load(timeframe: ScanTimeframe): { rows: ScanSignalRow[]; info: ScanCacheInfo } {
    const file = this.cacheFile(timeframe);
    return { rows: rowsOf(file), info: infoOf(file, timeframe, expectedTradeDay()) };
  }

  cancel(): void {
    this.abort?.abort();
  }

  async start(req: ScanRequest, events: ScanEvents): Promise<void> {
    if (this.running) return;
    this.running = true;
    const ac = new AbortController();
    this.abort = ac;
    const tf = req.timeframe;
    const progress: ScanProgress = { total: 0, done: 0, ok: 0, failed: 0, cached: 0, signalCount: 0 };

    try {
      const source = new SourcePool();
      const [meta, members, latestDate] = await Promise.all([
        loadMeta(),
        loadMembers(req.indexes),
        fetchLatestTradeDate(ac.signal, source),
      ]);

      const universe = this.buildUniverse(members, req.custom);
      if (universe.length === 0) {
        throw new Error('扫描范围为 0 个标的, 请勾选指数成分或添加自定义标的');
      }

      progress.total = universe.length;
      events.onProgress({ ...progress });

      const file = this.cacheFile(tf);
      const previous = file.symbols;
      const fresh: Record<string, CachedSymbol> = {};
      const queue = [...universe];
      /** 连续失败计数 / 是否判定为接口限流 */
      let consecutiveFailures = 0;
      let blocked = false;
      /** 是否出现过限流响应 (决定最终提示语) */
      let rateLimited = false;

      const worker = async (): Promise<void> => {
        while (queue.length > 0 && !blocked) {
          if (ac.signal.aborted) return;
          const symbolKey = queue.shift()!;
          const cached = previous[symbolKey];
          const reusable = !req.force && cached && cached.d >= latestDate;

          if (reusable) {
            fresh[symbolKey] = cached;
            progress.cached++;
            progress.done++;
            progress.ok++;
            if (cached.rows.length > 0) {
              progress.signalCount += cached.rows.length;
              events.onRows(cached.rows);
            }
            events.onProgress({ ...progress });
            continue;
          }

          try {
            const { klines, name } = await fetchKlines(symbolKey, tf, ac.signal, source);
            if (klines.length < MIN_BARS) throw new Error('历史数据不足');

            const rows = buildRows(symbolKey, klines, meta, name);
            fresh[symbolKey] = { d: klines[klines.length - 1].date, rows };
            progress.ok++;
            consecutiveFailures = 0;
            if (rows.length > 0) {
              progress.signalCount += rows.length;
              events.onRows(rows);
            }
          } catch (err) {
            if (ac.signal.aborted) return;
            progress.failed++;
            // fatal 的源错误 = 限流 / 断网 (不是「这个标的没数据」)
            if (err instanceof KlineSourceError && err.fatal) rateLimited = true;
            // 连续失败说明所有源都不可用, 继续请求只会让封禁更久
            if (++consecutiveFailures >= FAILURE_BREAKER) blocked = true;
          } finally {
            progress.done++;
            events.onProgress({ ...progress });
          }

          if (REQUEST_GAP_MS > 0 && !blocked) {
            await new Promise(r => setTimeout(r, REQUEST_GAP_MS));
          }
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, universe.length) }, () => worker()),
      );

      // 合并: 本次扫描覆盖的标的 + 缓存里其他仍未过期的标的 (仅保留当前范围内)
      const symbols: Record<string, CachedSymbol> = {};
      for (const key of universe) {
        const entry = fresh[key] ?? previous[key];
        if (entry) symbols[key] = entry;
      }
      // "数据至" 取实际存在的最大数据日期 (而不是参考指数的交易日):
      // 这样限流/中断时也如实反映缓存里到底有多新
      const dataDate = Object.values(symbols).reduce((max, e) => (e.d > max ? e.d : max), '');
      const next: CacheFile = { v: CACHE_VERSION, latestDate: dataDate, symbols };
      this.files.set(tf, next);
      writeCache(tf, next);

      // 补齐: 缓存命中的、拉取失败的标的也一并回填, 表格不会因为限流变空
      // (UI 按信号 id 去重, 重复推送无副作用)
      events.onRows(rowsOf(next));

      events.onDone(infoOf(next, tf, latestDate));

      if (progress.failed > 0 && progress.ok === 0) {
        events.onError(
          blocked || rateLimited
            ? '行情接口暂时限流, 已回退到本地缓存结果, 请稍后重试'
            : '本次扫描全部标的拉取失败, 已回退到本地缓存结果, 请检查网络后重试',
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : '扫描失败';
      if (!ac.signal.aborted) events.onError(message);
    } finally {
      if (this.abort === ac) this.abort = null;
      this.running = false;
    }
  }

  private cacheFile(timeframe: ScanTimeframe): CacheFile {
    let file = this.files.get(timeframe);
    if (!file) {
      file = readCache(timeframe);
      this.files.set(timeframe, file);
    }
    return file;
  }

  private buildUniverse(members: string[], custom: string[]): string[] {
    const set = new Set<string>();
    for (const key of members) {
      if (/^\d{6}\.(SH|SZ)$/.test(key)) set.add(key);
    }
    for (const raw of custom) {
      const key = raw.trim().toUpperCase();
      if (/^\d{6}\.(SH|SZ)$/.test(key)) set.add(key);
    }
    return [...set];
  }
}
