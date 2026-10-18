/**
 * 选股池组合回测引擎 (服务端)。
 *
 * 单只回测 (server/backtest.ts) 回答「这只票上策略表现如何」;
 * 本模块回答「这套策略在整个股票池上表现如何」:
 *   1. 解析股票池 (沪深300 / 中证500 成分股 + 自定义标的, 复用扫描的宇宙构建)
 *   2. 对每只标的用同一策略、同一名义本金独立回测 (K 线走本地缓存 + 增量更新)
 *   3. 等权汇总: 组合收益 = 各标的策略收益的等权平均;
 *      组合权益曲线 = 各标的归一化权益曲线 (以名义本金为 1) 的逐日平均,
 *      区间不一致的标的在缺失日按「现金」处理 (上市前/停牌期等价于持币)
 *   4. 产出组合级 KPI + 逐标的摘要排行榜, 前端轮询获取进度与结果
 *
 * 任务模型: 全局同一时间只跑一个池回测任务 (与扫描一致), 重复发起会挂到
 * 正在运行的同参数任务上; 完成后结果在内存中保留一段时间, 供前端反复查看。
 */

import { installLocalStorageShim } from './localStorageShim.ts';
// 回测引擎间接依赖 localStorage (用户指标/策略本地存储), 必须在调用 runBacktest 前安装 shim
installLocalStorageShim();

import { runBacktest } from '../src/utils/backtestRunner.ts';
import { sharpeFromEquityCurve, maxDrawdownFromEquityCurve } from '../src/utils/backtestUtils.ts';
import { getKlines } from './klines.ts';
import { buildUniverse, loadStockMeta, type StockMeta } from './universe.ts';
import { loadStrategies } from '../src/strategies/user/index.ts';
import type { KlinePeriod } from '../src/utils/klineUtils.ts';
import type { BacktestResult, Kline } from '../src/types/stock.ts';
import type { BacktestDiagnostic, UserStrategyDefinition } from '../src/types/strategy.ts';
import type { IndexId } from '../src/types/scan.ts';
import type {
  PoolBacktestInput,
  PoolBacktestJobView,
  PoolBacktestProgress,
  PoolBacktestSummary,
  PoolJobState,
  PoolPeriod,
  PoolSymbolDetailView,
  PoolSymbolResult,
  PoolTradeLogRow,
  PoolTradeLogView,
} from '../src/types/poolBacktest.ts';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * 并发回测的标的数。腾讯行情全局限速 15 次/秒 (tencentKlines.ts),
 * 与扫描使用同一限速器, 这里取 8 与扫描保持一致, 控制内存/连接并发。
 */
const CONCURRENCY = 8;
/** 池模式默认拉取根数 (400 根 ≈ 1.6 年日线, 与扫描缓存对齐, 命中率高) */
const DEFAULT_COUNT = 400;
/** 单只标的名义本金 */
const DEFAULT_PER_SYMBOL_CASH = 100_000;
/** 失败明细最多保留条数 */
const MAX_FAILURES = 50;
/** 完成任务保留时长 (ms), 超时从内存清除 */
const JOB_TTL_MS = 30 * 60 * 1000;
/** 同时最多保留的历史任务数 */
const MAX_JOBS = 3;

const MAX_FETCH_FAILURES_BEFORE_ABORT = 40;

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const periodOf = (p: PoolPeriod): KlinePeriod => (p === '1w' ? '1w' : '1d');

function clampCount(count: unknown): number {
  const n = typeof count === 'number' && Number.isFinite(count) ? Math.floor(count) : DEFAULT_COUNT;
  return Math.min(Math.max(n, 30), 5000);
}

function rowFromResult(
  symbol: string,
  meta: StockMeta,
  result: BacktestResult,
  klinesCount: number,
): PoolSymbolResult {
  const code = symbol.split('.')[0];
  return {
    symbol,
    code,
    name: meta.names[code],
    industry: meta.industries[code],
    initialBalance: result.initialBalance,
    finalBalance: result.finalBalance,
    returnPercent: result.totalReturnPercent,
    buyHoldPercent: result.buyHoldReturnPercent,
    excessPercent: result.totalReturnPercent - result.buyHoldReturnPercent,
    trades: result.totalTrades,
    winRate: result.winRate,
    sharpeRatio: result.sharpeRatio,
    maxDrawdownPercent: result.maxDrawdownPercent ?? 0,
    fees: result.totalFees,
    klinesCount,
    dateRange: { start: result.startDate, end: result.endDate },
  };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * 等权组合权益曲线: 各标的归一化权益 (÷ 名义本金) 逐日平均。
 * 按日期并集展开, 标的缺失的日期沿用其最近一次权益 (上市前/停牌 ≈ 现金)。
 */
function buildPortfolioCurve(
  series: { dates: string[]; fractions: number[] }[],
  initialCash: number,
): { equityCurve: number[]; equityDates: string[] } {
  if (series.length === 0) return { equityCurve: [], equityDates: [] };

  const dateSet = new Set<string>();
  for (const s of series) for (const d of s.dates) dateSet.add(d);
  const equityDates = [...dateSet].sort();

  const pointers = new Array(series.length).fill(0);
  const lastFraction = new Array(series.length).fill(1); // 首个数据日之前视作持币
  const equityCurve: number[] = [];

  for (const date of equityDates) {
    let sum = 0;
    for (let i = 0; i < series.length; i++) {
      const { dates, fractions } = series[i];
      while (pointers[i] < dates.length && dates[pointers[i]] <= date) {
        lastFraction[i] = fractions[pointers[i]];
        pointers[i]++;
      }
      sum += lastFraction[i];
    }
    equityCurve.push((initialCash * sum) / series.length);
  }

  return { equityCurve, equityDates };
}

// ---------------------------------------------------------------------------
// 任务
// ---------------------------------------------------------------------------

interface SymbolRun {
  result: BacktestResult;
  diagnostics: readonly BacktestDiagnostic[];
  equityCurve: number[];
  /** 回测实际使用的 K 线 (过滤区间后), 供前端绘制价格图并标注每笔成交 */
  klines: Kline[];
}

export class PoolBacktestJob {
  readonly id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  readonly startedAt = Date.now();
  readonly input: PoolBacktestInput;

  state: PoolJobState = 'running';
  error?: string;
  finishedAt?: number;

  readonly progress: PoolBacktestProgress = { total: 0, done: 0, ok: 0, failed: 0, traded: 0, cached: 0 };
  readonly updatedAt = { value: Date.now() };

  private readonly controller = new AbortController();
  private readonly runs = new Map<string, SymbolRun>();
  private readonly rows: PoolSymbolResult[] = [];
  private readonly failures: { symbol: string; error: string }[] = [];
  /** 并发窗口内正在处理的标的 (按开始顺序), 通过 view() 暴露给前端 */
  private readonly active = new Set<string>();
  private summary: PoolBacktestSummary | null = null;
  /** 全池逐笔成交缓存 (首次请求时构建, 按 日期 -> 标的 排序) */
  private tradeLog: PoolTradeLogRow[] | null = null;

  constructor(
    input: PoolBacktestInput,
    private readonly strategy: UserStrategyDefinition,
    private readonly meta: StockMeta,
  ) {
    this.input = input;
  }

  get cancelled(): boolean {
    return this.controller.signal.aborted;
  }

  cancel(): void {
    if (this.state !== 'running') return;
    this.controller.abort();
    this.state = 'cancelled';
    this.finishedAt = Date.now();
  }

  /** 前端轮询视图 (done 时附带完整组合报告) */
  view(): PoolBacktestJobView {
    this.updatedAt.value = Date.now();
    return {
      id: this.id,
      state: this.state,
      progress: { ...this.progress },
      active: [...this.active],
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      input: this.input,
      error: this.error,
      result: this.summary ?? undefined,
    };
  }

  /** 单只标的高亮明细 (排行榜行点击) */
  symbolDetail(symbol: string): PoolSymbolDetailView | null {
    const run = this.runs.get(symbol);
    if (!run) return null;
    return {
      symbol,
      period: this.input.period ?? '1d',
      adjust: this.input.adjust ?? 'forward',
      klinesCount: run.klines.length,
      dateRange: {
        start: run.result.startDate,
        end: run.result.endDate,
      },
      result: run.result,
      diagnostics: [...run.diagnostics],
      equityCurve: run.equityCurve,
      equityDates: run.klines.map((k) => k.date),
      klines: run.klines,
    };
  }

  /**
   * 全池逐笔成交明细: 合并所有标的的成交记录, 按 日期 -> 标的 升序。
   * 任务结束后构建一次并缓存; 运行中则每次实时构建 (成交仍在追加, 不能缓存)。
   */
  allTrades(): PoolTradeLogView {
    const build = (): PoolTradeLogRow[] => {
      const rows: PoolTradeLogRow[] = [];
      for (const [symbol, run] of this.runs) {
        const code = symbol.split('.')[0];
        const name = this.meta.names[code];
        for (const t of run.result.trades) {
          rows.push({
            symbol,
            code,
            name,
            date: t.date,
            type: t.type,
            signalType: t.signalType,
            reason: t.reason,
            price: t.price,
            shares: t.shares,
            value: t.value,
            fee: t.fee ?? 0,
            pnl: t.pnl,
            pnlPercent: t.pnlPercent,
          });
        }
      }
      // 稳定排序: 同日同标的保持原始成交顺序 (与回测执行顺序一致)
      rows.sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        if (a.symbol !== b.symbol) return a.symbol < b.symbol ? -1 : 1;
        return 0;
      });
      return rows;
    };

    if (this.state === 'running') {
      const rows = build();
      return { trades: rows, total: rows.length };
    }
    if (!this.tradeLog) this.tradeLog = build();
    return { trades: this.tradeLog, total: this.tradeLog.length };
  }

  async run(): Promise<void> {
    const { period = '1d', count = DEFAULT_COUNT, adjust = 'forward', force = false } = this.input;
    const initialCash = this.input.initialCash && this.input.initialCash > 0
      ? this.input.initialCash
      : DEFAULT_PER_SYMBOL_CASH;

    try {
      const universe = await buildUniverse(this.input.indexes as IndexId[], this.input.custom ?? []);
      this.progress.total = universe.length;

      let cursor = 0;
      const signal = this.controller.signal;
      const totalCash = initialCash;

      const worker = async () => {
        while (!signal.aborted && cursor < universe.length) {
          const symbol = universe[cursor++];
          this.active.add(symbol);
          let cached = false;
          try {
            const query = await getKlines(symbol, periodOf(period), count, adjust, force);
            cached = query.cached;

            let klines: Kline[] = query.klines;
            if (this.input.rangeStart || this.input.rangeEnd) {
              klines = klines.filter(
                (k) =>
                  (!this.input.rangeStart || k.date >= this.input.rangeStart) &&
                  (!this.input.rangeEnd || k.date <= this.input.rangeEnd),
              );
            }
            if (klines.length < 2) {
              throw new Error('区间内 K 线不足');
            }

            const { result, diagnostics, equityCurve } = runBacktest({
              klines,
              symbol,
              userId: 'pool',
              initialCash: totalCash,
              currency: 'CNY',
              stopLossPercent: this.input.stopLossPercent,
              commissionRate: this.input.commissionRate,
              minCommission: this.input.minCommission,
              strategy: this.strategy,
              params: this.input.params,
            });

            this.runs.set(symbol, {
              result,
              diagnostics,
              equityCurve: equityCurve ?? [],
              klines,
            });
            this.rows.push(rowFromResult(symbol, this.meta, result, klines.length));
            this.progress.ok++;
            if (result.totalTrades > 0) this.progress.traded++;
          } catch (err) {
            if (signal.aborted) break;
            this.progress.failed++;
            if (this.failures.length < MAX_FAILURES) {
              this.failures.push({ symbol, error: err instanceof Error ? err.message : String(err) });
            }
            // 上游整体不可用 (网络断/被墙) 时快速失败, 避免无意义的长时间等待
            if (this.progress.failed >= MAX_FETCH_FAILURES_BEFORE_ABORT && this.progress.ok === 0) {
              this.controller.abort();
              throw new Error(`连续 ${this.progress.failed} 只标的拉取失败, 已终止任务 (请检查行情源或稍后重试)`);
            }
          } finally {
            this.active.delete(symbol);
            if (!signal.aborted) {
              this.progress.done++;
              if (cached) this.progress.cached++;
            }
          }
        }
      };

      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, universe.length) }, () => worker()));

      if (!this.cancelled) {
        this.summary = this.aggregate(initialCash, universe.length);
        this.state = 'done';
      }
    } catch (err) {
      if (this.state === 'running') {
        this.state = 'error';
        this.error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      this.finishedAt = Date.now();
    }
  }

  /** 等权汇总: 组合 KPI + 权益曲线 + 排行榜 */
  private aggregate(initialCash: number, universeSize: number): PoolBacktestSummary {
    const rows = [...this.rows].sort((a, b) => b.returnPercent - a.returnPercent);

    const series = [...this.runs.values()].map((run) => ({
      dates: run.klines.map((k) => k.date),
      fractions: run.equityCurve.map((v) => v / initialCash),
    }));
    const { equityCurve, equityDates } = buildPortfolioCurve(series, initialCash);

    const returns = rows.map((r) => r.returnPercent);
    const profitable = rows.filter((r) => r.returnPercent > 0).length;
    const beatBuyHold = rows.filter((r) => r.excessPercent > 0).length;
    const finalEquity = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1] : initialCash;

    let start = '';
    let end = '';
    for (const r of rows) {
      if (!start || r.dateRange.start < start) start = r.dateRange.start;
      if (!end || r.dateRange.end > end) end = r.dateRange.end;
    }

    return {
      universeSize,
      tested: rows.length,
      failed: this.progress.failed,
      traded: rows.filter((r) => r.trades > 0).length,
      profitable,
      beatBuyHold,
      initialCash,
      finalEquity,
      totalReturnPercent: initialCash > 0 ? ((finalEquity - initialCash) / initialCash) * 100 : 0,
      buyHoldReturnPercent: mean(rows.map((r) => r.buyHoldPercent)),
      maxDrawdownPercent: maxDrawdownFromEquityCurve(equityCurve),
      sharpeRatio: sharpeFromEquityCurve(equityCurve),
      symbolWinRate: rows.length > 0 ? (profitable / rows.length) * 100 : 0,
      beatBuyHoldRate: rows.length > 0 ? (beatBuyHold / rows.length) * 100 : 0,
      meanReturnPercent: mean(returns),
      medianReturnPercent: median(returns),
      totalTrades: rows.reduce((s, r) => s + r.trades, 0),
      totalFees: rows.reduce((s, r) => s + r.fees, 0),
      equityCurve,
      equityDates,
      dateRange: { start, end },
      rows,
      failures: [...this.failures],
    };
  }
}

// ---------------------------------------------------------------------------
// 任务调度: 全局同一时间只跑一个池回测
// ---------------------------------------------------------------------------

const jobs = new Map<string, PoolBacktestJob>();
let activeJob: PoolBacktestJob | null = null;

function pruneJobs(): void {
  const now = Date.now();
  const completed: PoolBacktestJob[] = [];
  for (const job of jobs.values()) {
    if (job.state !== 'running' && job.finishedAt && now - job.finishedAt > JOB_TTL_MS) {
      jobs.delete(job.id);
    } else if (job.state !== 'running') {
      completed.push(job);
    }
  }
  // 超额的历史任务按完成时间淘汰
  completed.sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
  while (completed.length > MAX_JOBS) {
    const job = completed.shift()!;
    jobs.delete(job.id);
  }
}

/** 归一化输入 (去空白/去重/裁剪), 同时生成同参数任务的指纹 */
function normalizeInput(raw: PoolBacktestInput): PoolBacktestInput {
  const indexes = [...new Set((raw.indexes ?? []).filter((v): v is IndexId => v === 'hs300' || v === 'zz500'))];
  const custom = [...new Set((raw.custom ?? []).map((s) => String(s).trim().toUpperCase()).filter(Boolean))];
  const input: PoolBacktestInput = {
    ...raw,
    strategyId: String(raw.strategyId ?? '').trim(),
    indexes,
    custom,
    period: raw.period === '1w' ? '1w' : '1d',
    count: clampCount(raw.count),
    adjust: raw.adjust === 'backward' ? 'backward' : raw.adjust === '' ? '' : 'forward',
    initialCash: raw.initialCash && raw.initialCash > 0 ? raw.initialCash : DEFAULT_PER_SYMBOL_CASH,
    commissionRate: typeof raw.commissionRate === 'number' && raw.commissionRate >= 0 ? raw.commissionRate : 0.00025,
    minCommission: typeof raw.minCommission === 'number' && raw.minCommission >= 0 ? raw.minCommission : 5,
    stopLossPercent:
      typeof raw.stopLossPercent === 'number' && Number.isFinite(raw.stopLossPercent)
        ? raw.stopLossPercent
        : undefined,
    params: raw.params && typeof raw.params === 'object' ? raw.params : {},
    rangeStart: raw.rangeStart || undefined,
    rangeEnd: raw.rangeEnd || undefined,
    force: raw.force === true,
  };
  if (indexes.length === 0 && custom.length === 0) {
    throw Object.assign(new Error('请至少选择一个股票池 (沪深300 / 中证500) 或添加自定义标的'), { statusCode: 400 });
  }
  return input;
}

function sameConfig(a: PoolBacktestInput, b: PoolBacktestInput): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface PoolRequestResult {
  job: PoolBacktestJob;
  /** true = 挂到了已在运行的同参数任务上 */
  attached: boolean;
}

/**
 * 发起池回测; 全局只允许一个任务同时在跑。
 * 同参数任务在跑时直接复用 (多个页面共享一次回测)。
 */
export async function requestPoolBacktest(raw: PoolBacktestInput): Promise<PoolRequestResult> {
  pruneJobs();

  const input = normalizeInput(raw);
  if (!input.strategyId) {
    throw Object.assign(new Error('strategyId is required'), { statusCode: 400 });
  }

  const strategies = await loadStrategies();
  const strategy = strategies.find((s) => s.id === input.strategyId);
  if (!strategy) {
    const available = strategies.map((s) => `${s.id} (${s.name})`).join(', ');
    throw Object.assign(new Error(`策略未找到: ${input.strategyId}. 可用策略: ${available}`), { statusCode: 400 });
  }

  const current = activeJob;
  if (current && current.state === 'running') {
    if (sameConfig(current.input, input)) return { job: current, attached: true };
    throw Object.assign(
      new Error(`已有池回测任务在进行中 (${current.progress.done}/${current.progress.total}), 请等待完成或先中断`),
      { statusCode: 409, jobId: current.id },
    );
  }

  const meta = await loadStockMeta();
  const job = new PoolBacktestJob(input, strategy, meta);
  jobs.set(job.id, job);
  activeJob = job;
  void job.run().finally(() => {
    if (activeJob === job) activeJob = null;
    pruneJobs();
  });
  return { job, attached: false };
}

export function getPoolBacktestJob(id: string): PoolBacktestJob | null {
  return jobs.get(id) ?? null;
}
