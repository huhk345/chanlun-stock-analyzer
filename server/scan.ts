/**
 * 缠论买卖点扫描引擎 (服务端)。
 *
 * 前端不再自己下载 K 线 / 计算缠论, 只通过 WebSocket 下发一次扫描请求;
 * 本模块负责整条链路:
 *   1. 解析扫描宇宙 (沪深300 / 中证500 成分股 + 用户自定义标的)
 *   2. 逐只拉取 K 线 (klines.ts: TickFlow + 本地磁盘缓存 + 增量更新)
 *   3. 计算缠论买卖点 (合并K线 -> 分型 -> 笔 -> 一/二/三类买卖点)
 *   4. 按 90 天窗口生成信号行, 边算边通过扫描事件推送给前端
 *   5. 结果落盘到 .cache/scan/{周期}.json, 下次扫描可直接复用 (替代原前端 localStorage 缓存)
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Kline, BSPointType } from '../src/types/stock.ts';
import { computeStrokesAndBSPoints } from '../src/utils/chanlun.ts';
import { daysBetween, expectedTradeDay, isFresh } from '../src/utils/klineUtils.ts';
import { getKlines } from './klines.ts';
import { fetchStockFlowBatch } from './flows.ts';
import { buildUniverse, loadStockMeta, type StockMeta } from './universe.ts';
import {
  SIGNAL_WINDOW_DAYS,
  TYPE_LABELS,
  type IndexId,
  type ScanCacheInfo,
  type ScanProgress,
  type ScanServerMessage,
  type ScanSignalRow,
  type ScanTimeframe,
  type StockFlow,
} from '../src/types/scan.ts';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');

const SCAN_CACHE_DIR = process.env.SCAN_CACHE_DIR
  ? path.resolve(process.env.SCAN_CACHE_DIR)
  : path.join(ROOT_DIR, '.cache', 'scan');

/**
 * 每周期同时拉取的标的数。
 * 上游腾讯行情免 Key 且无公开限流, 这里主要控制内存/连接并发。
 * 实测 (沪深300+中证500 800 只, 强制全量):
 *   TickFlow 限流 60/分钟 约需 13 分钟 -> 腾讯约 55 秒 (受 15 次/秒 限速约束)
 */
const CONCURRENCY = 8;
/** 每只标的取用的 K 线根数 (近 1 年日线 / 约 400 周线) */
const KLINE_COUNT = 400;
/** 每新算完多少只标的落盘一次扫描缓存 */
const CACHE_FLUSH_EVERY = 20;
/** 进度推送节流间隔 (ms), 避免高频刷屏 */
const PROGRESS_INTERVAL_MS = 200;

const periodOf = (tf: ScanTimeframe): '1d' | '1w' => (tf === 'weekly' ? '1w' : '1d');

// ---------------------------------------------------------------------------
// 扫描缓存 (.cache/scan/{daily,weekly}.json)
// ---------------------------------------------------------------------------

/** [type, date, price, strokeUp] */
type CachedSignal = [BSPointType, string, number, 0 | 1];

interface CacheEntry {
  d: string;            // 末根 K 线日期 (数据新鲜度)
  c: number;            // 末根收盘价
  s: CachedSignal[];    // 全部三类买卖点
  v?: number;           // 量比: 最新收盘成交量 / 前5日均量
  a?: number;           // 近5日日均成交额 (亿元)
}

type ScanCache = Record<string, CacheEntry>;

interface CacheFile {
  updatedAt: number;
  entries: ScanCache;
}

/** 缓存条目是否覆盖预期最新交易日 (按内容判断, 不依赖扫描时间戳) */
function entryFresh(entry: CacheEntry | undefined, tf: ScanTimeframe): boolean {
  if (!entry) return false;
  return isFresh(entry.d, tf === 'weekly' ? '1w' : '1d');
}

/** 进程内常驻缓存对象: 扫描任务直接原地更新, 落盘只写快照 */
const cacheByTimeframe = new Map<ScanTimeframe, ScanCache>();

function cacheFile(tf: ScanTimeframe): string {
  return path.join(SCAN_CACHE_DIR, `${tf}.json`);
}

function loadCache(tf: ScanTimeframe): ScanCache {
  const cached = cacheByTimeframe.get(tf);
  if (cached) return cached;
  let entries: ScanCache = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile(tf), 'utf-8')) as CacheFile;
    if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
      entries = parsed.entries;
    }
  } catch {
    /* 无缓存文件 (首次扫描) */
  }
  cacheByTimeframe.set(tf, entries);
  return entries;
}

function saveCache(tf: ScanTimeframe, entries: ScanCache): void {
  const payload: CacheFile = { updatedAt: Date.now(), entries };
  try {
    fs.mkdirSync(SCAN_CACHE_DIR, { recursive: true });
    // 先写临时文件再重命名, 避免中断留下半截 JSON
    const target = cacheFile(tf);
    const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, target);
  } catch (err) {
    console.warn(`[scan] 写入 ${tf} 缓存失败:`, err);
  }
}

function cacheInfoFor(tf: ScanTimeframe, entries: ScanCache): ScanCacheInfo {
  let latestDate = '';
  for (const e of Object.values(entries)) if (e.d > latestDate) latestDate = e.d;
  return {
    timeframe: tf,
    count: Object.keys(entries).length,
    latestDate,
    stale: latestDate === '' ? false : tf === 'weekly' ? daysBetween(latestDate, expectedTradeDay()) > 7 : latestDate < expectedTradeDay(),
  };
}

// ---------------------------------------------------------------------------
// 扫描宇宙: 成分股 / 名称 / 板块 (仅供本扫描使用)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 单只标的: K 线 -> 缠论买卖点 -> 缓存条目 -> 信号行
// ---------------------------------------------------------------------------

/** 完整缠论流水线, 只保留笔与买卖点 (线段/中枢不参与买卖点判定, 省去两遍计算) */
async function analyzeSymbol(symbol: string, tf: ScanTimeframe, force: boolean): Promise<CacheEntry> {
  const { klines } = await getKlines(symbol, periodOf(tf), KLINE_COUNT, 'forward', force);
  return computeEntry(klines);
}

function computeEntry(klines: Kline[]): CacheEntry {
  const { strokes, bsPoints } = computeStrokesAndBSPoints(klines);
  const strokeUpByIndex = new Map<number, boolean>(strokes.map((s, i) => [i, s.direction === 'up']));

  // 量能指标: 量比 (最新收盘量 / 前5日均量) 与 近5日日均成交额
  const n = klines.length;
  let volRatio = 0;
  if (n >= 2) {
    const prev5 = klines.slice(Math.max(0, n - 6), n - 1);
    const avgVol5 = prev5.reduce((s, k) => s + k.volume, 0) / prev5.length;
    volRatio = avgVol5 > 0 ? klines[n - 1].volume / avgVol5 : 0;
  }
  const last5 = klines.slice(-5);
  const amount5 = last5.reduce((s, k) => s + k.amount, 0) / last5.length / 1e8;

  return {
    d: klines[klines.length - 1].date,
    c: klines[klines.length - 1].close,
    s: bsPoints.map(p => [p.type, p.date, p.price, strokeUpByIndex.get(p.strokeIndex) ? 1 : 0]),
    v: Math.round(volRatio * 100) / 100,
    a: Math.round(amount5 * 100) / 100,
  };
}

/** 缓存条目 -> 最近 90 天内的信号行 (无信号返回空数组) */
function rowsFromEntry(symbol: string, entry: CacheEntry, meta: StockMeta): ScanSignalRow[] {
  if (entry.s.length === 0) return [];
  const code = symbol.split('.')[0];
  const industryPath = meta.industries[code];
  const out: ScanSignalRow[] = [];
  for (const [type, date, price, strokeUp] of entry.s) {
    const daysAgo = daysBetween(date, entry.d);
    if (daysAgo > SIGNAL_WINDOW_DAYS) continue;
    out.push({
      id: `${symbol}-${type}-${date}`,
      symbolKey: symbol,
      code,
      name: meta.names[code],
      industryPath,
      type,
      label: TYPE_LABELS[type],
      date,
      price,
      lastClose: entry.c,
      dataDate: entry.d,
      daysAgo,
      changeSincePct: price > 0 ? ((entry.c - price) / price) * 100 : 0,
      strokeUp: strokeUp === 1,
      volRatio: entry.v,
      amount5: entry.a,
    });
  }
  return out;
}

function allRows(entries: ScanCache, meta: StockMeta): ScanSignalRow[] {
  const out: ScanSignalRow[] = [];
  for (const [sym, entry] of Object.entries(entries)) out.push(...rowsFromEntry(sym, entry, meta));
  return out;
}

/** 缓存快照: 页面挂载时秒开上次结果, 不触发任何 K 线上游请求 */
export async function getCacheSnapshot(tf: ScanTimeframe): Promise<{
  rows: ScanSignalRow[];
  info: ScanCacheInfo;
  flows: Record<string, StockFlow>;
}> {
  const entries = loadCache(tf);
  const meta = await loadStockMeta();
  const rows = allRows(entries, meta);
  const info = cacheInfoFor(tf, entries);
  return { rows, info, flows: await snapshotFlows(rows) };
}

/** 资金流按天变化, 60 秒内复用上一次结果, 避免频繁打开页面反复打上游 */
const FLOW_TTL_MS = 60_000;
let flowSnapshot: { at: number; data: Record<string, StockFlow> } | null = null;

async function snapshotFlows(rows: ScanSignalRow[]): Promise<Record<string, StockFlow>> {
  const keys = [...new Set(rows.map(r => r.symbolKey))];
  if (keys.length === 0) return {};
  if (flowSnapshot && Date.now() - flowSnapshot.at < FLOW_TTL_MS) return flowSnapshot.data;
  try {
    const data = await fetchStockFlowBatch(keys);
    flowSnapshot = { at: Date.now(), data };
    return data;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// 扫描任务
// ---------------------------------------------------------------------------

export interface ScanJobOptions {
  timeframe: ScanTimeframe;
  indexes: IndexId[];
  custom: string[];
  force: boolean;
}

type ScanListener = (msg: ScanServerMessage) => void;

export class ScanJob {
  readonly id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  readonly timeframe: ScanTimeframe;
  readonly force: boolean;

  private readonly listeners = new Set<ScanListener>();
  private readonly controller = new AbortController();
  private readonly progressState: ScanProgress = { total: 0, done: 0, ok: 0, failed: 0, cached: 0, signalCount: 0 };
  private readonly rowsBuffer: ScanSignalRow[] = [];
  private readonly signaled = new Set<string>();
  private readonly entries: ScanCache;
  private cursor = 0;
  private computedSinceFlush = 0;
  private lastProgressAt = 0;
  private started = false;
  private finished = false;
  cancelled = false;

  constructor(private readonly options: ScanJobOptions) {
    this.timeframe = options.timeframe;
    this.force = options.force;
    this.entries = loadCache(options.timeframe);
  }

  get done(): boolean {
    return this.finished;
  }

  /** 订阅进度/结果; 中途接入会立刻收到当前进度与已产出的信号行 */
  subscribe(listener: ScanListener): void {
    this.listeners.add(listener);
    if (this.started && !this.cancelled) {
      listener(this.startMessage());
      if (this.progressState.signalCount > 0) listener({ type: 'rows', rows: [...this.rowsBuffer] });
    }
  }

  unsubscribe(listener: ScanListener): void {
    this.listeners.delete(listener);
  }

  /**
   * 中断扫描: 已完成部分立即落盘, 订阅者马上收到 done(cancelled),
   * 后台并发的在途请求自然结束 (上游限流等待无法强行打断)。
   */
  cancel(): void {
    if (this.finished || this.cancelled) return;
    this.cancelled = true;
    this.controller.abort();
    saveCache(this.timeframe, this.entries);

    const listeners = [...this.listeners];
    this.listeners.clear();
    const done: ScanServerMessage = {
      type: 'done',
      scanId: this.id,
      cancelled: true,
      info: cacheInfoFor(this.timeframe, this.entries),
    };
    for (const l of listeners) l(done);
  }

  private startMessage(): ScanServerMessage {
    return {
      type: 'scan-start',
      scanId: this.id,
      timeframe: this.timeframe,
      force: this.force,
      progress: { ...this.progressState },
    };
  }

  private emit(msg: ScanServerMessage): void {
    for (const l of [...this.listeners]) l(msg);
  }

  private flushProgress(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastProgressAt < PROGRESS_INTERVAL_MS) return;
    this.lastProgressAt = now;
    this.emit({ type: 'progress', progress: { ...this.progressState } });
  }

  private publishRows(symbol: string, entry: CacheEntry, meta: StockMeta): void {
    const rows = rowsFromEntry(symbol, entry, meta);
    if (rows.length === 0) return;
    this.signaled.add(symbol);
    this.progressState.signalCount += rows.length;
    this.rowsBuffer.push(...rows);
    this.emit({ type: 'rows', rows });
  }

  async run(): Promise<void> {
    this.started = true;
    try {
      const universe = await buildUniverse(this.options.indexes, this.options.custom);
      const meta = await loadStockMeta();
      this.progressState.total = universe.length;
      this.emit(this.startMessage());
      console.log(
        `[scan] 开始 ${this.timeframe} 扫描: ${universe.length} 只 (${this.force ? '强制刷新' : '增量'}), 任务 ${this.id}`,
      );
      await this.scanUniverse(universe, meta);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[scan] 任务 ${this.id} 失败:`, message);
      this.emit({ type: 'error', code: 'scan-failed', message });
    } finally {
      this.finished = true;
      saveCache(this.timeframe, this.entries);
      if (!this.cancelled) {
        this.flushProgress(true);
        if (this.signaled.size > 0) {
          try {
            this.emit({ type: 'flows', flows: await fetchStockFlowBatch([...this.signaled]) });
          } catch (err) {
            console.warn('[scan] 主力资金流获取失败:', err);
          }
        }
        this.emit({ type: 'done', scanId: this.id, cancelled: false, info: cacheInfoFor(this.timeframe, this.entries) });
        this.listeners.clear();
      }
    }
  }

  private async scanUniverse(universe: string[], meta: StockMeta): Promise<void> {
    const signal = this.controller.signal;
    const worker = async () => {
      while (!signal.aborted && this.cursor < universe.length) {
        const symbol = universe[this.cursor++];
        try {
          const cached = this.entries[symbol];
          // 缓存命中条件: 非强制 && 条目已达预期最新交易日; 过期条目重新下载计算
          if (!this.force && entryFresh(cached, this.timeframe)) {
            this.progressState.ok++;
            this.progressState.cached++;
            this.publishRows(symbol, cached!, meta);
          } else {
            const entry = await analyzeSymbol(symbol, this.timeframe, this.force);
            this.entries[symbol] = entry;
            this.progressState.ok++;
            if (++this.computedSinceFlush >= CACHE_FLUSH_EVERY) {
              this.computedSinceFlush = 0;
              saveCache(this.timeframe, this.entries);
            }
            this.publishRows(symbol, entry, meta);
          }
        } catch (err) {
          if (signal.aborted) break; // 用户主动停止, 不计入失败
          this.progressState.failed++;
          console.warn(`[scan] ${symbol} ${this.timeframe} 失败:`, err instanceof Error ? err.message : err);
        } finally {
          this.progressState.done++;
          this.flushProgress();
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  }
}

// ---------------------------------------------------------------------------
// 任务调度: 全局同一时间只跑一个扫描, 第二个客户端可挂到同一个任务上
// ---------------------------------------------------------------------------

let activeJob: ScanJob | null = null;

export interface ScanRequestResult {
  job: ScanJob | null;   // null = 被拒绝 (原因已通过 listener 回传)
  attached: boolean;     // true = 挂到了已在运行的同周期任务上 (非本次新建)
}

/**
 * 发起扫描; 返回挂上的任务。
 * 同周期非强制的请求会挂到正在跑的任务上, 多个标签页共享一次扫描。
 */
export function requestScan(options: ScanJobOptions, listener: ScanListener): ScanRequestResult {
  const current = activeJob;
  const running = current !== null && !current!.done && !current!.cancelled;
  if (running && current!.timeframe === options.timeframe && !options.force) {
    current!.subscribe(listener);
    return { job: current!, attached: true };
  }
  if (running) {
    listener({
      type: 'error',
      code: 'scan-busy',
      message: current!.force
        ? '已有强制重扫在进行中, 请等待完成或先停止'
        : `已有${current!.timeframe === 'weekly' ? '周线' : '日线'}扫描在进行中, 请等待完成或先停止`,
    });
    return { job: null, attached: false };
  }

  const job = new ScanJob(options);
  activeJob = job;
  job.subscribe(listener);
  void job.run().then(() => {
    if (activeJob === job) activeJob = null;
  });
  return { job, attached: false };
}

/** 页面请求中断时: 只中断自己挂着的那次扫描 */
export function cancelScan(job: ScanJob | null): void {
  job?.cancel();
}
