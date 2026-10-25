/**
 * 股票池「共享资金逐日组合模拟」服务端编排。
 *
 * 分工:
 *   1. TypeScript 策略引擎 (src/utils/backtestRunner) 逐标的、逐日生成 BUY/SELL 信号,
 *      只使用「截至当根」的 K 线与缠论结构;
 *   2. 信号写入临时 bundle, 交给 Python backtrader 逐日撮合:
 *      共享现金、最大持仓数、单只仓位上限、T+1、涨跌停、A 股费用、可选止损;
 *   3. 服务端把组合结果 (权益/基准/成交/信号账本/持仓/标的表现) 返回前端。
 *
 * 与旧的「池内等权汇总」不同: 这里只有一个资金账户, 同一天多个买点会竞争现金与仓位,
 * 买入会真实占用资金, 卖出才释放, 因此组合收益不是单标的收益的平均。
 *
 * 任务模型: 全局同一时间只跑一个组合模拟; 同参数任务自动复用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';

import { runBacktest } from './engine/backtestRunner.ts';
import { buildStrategyParams } from './engine/strategyAdapter.ts';
import { getKlines } from './klines.ts';
import {
  barsFingerprint,
  findSignalCache,
  pruneSignalCache,
  SIGNAL_CACHE_VERSION,
  signalCacheConfigKey,
  strategyFingerprint,
  writeSignalCache,
} from './signalCache.ts';
import { BENCHMARKS, DEFAULT_BENCHMARK, buildMarketContext, getMarketBaselines, isPortfolioBenchmarkId, type MarketBaselineBundle } from './marketBaselines.ts';
import { buildUniverse, loadStockMeta, type StockMeta } from './universe.ts';
import { loadStrategies } from './strategies/index.ts';
import {
  describeExcludedBoards,
  EXCLUDABLE_BOARDS,
  isAshareSymbol,
  isBoardExcluded,
  resolveSymbol,
  type ExcludableBoard,
} from '../src/utils/symbols.ts';
import type { IndexId } from '../src/types/scan.ts';
import type { BacktestDiagnostic, UserStrategyDefinition } from '../src/types/strategy.ts';
import type { Kline } from '../src/types/stock.ts';
import type {
  PortfolioEquityPoint,
  PortfolioMarketIndicator,
  PortfolioOpenPosition,
  PortfolioSimulationInput,
  PortfolioSimulationJobView,
  PortfolioSimulationPhase,
  PortfolioSimulationResult,
  PortfolioSignalPage,
  PortfolioSignalQuery,
  PortfolioSignalRow,
  PortfolioSymbolStat,
  PortfolioTradeRow,
  SimulationEngineHealth,
} from '../src/types/portfolioSimulation.ts';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const CACHE_DIR = process.env.KLINE_CACHE_DIR
  ? path.resolve(process.env.KLINE_CACHE_DIR)
  : path.join(ROOT_DIR, '.cache');
const SIM_DIR = path.join(CACHE_DIR, 'simulation');
const PY_SCRIPT = path.join(ROOT_DIR, 'scripts', 'backtrader', 'runner.py');
const VENV_PY = path.join(ROOT_DIR, 'scripts', 'backtrader', '.venv', 'bin', 'python');

/** K 线拉取并发 (与扫描一致, 腾讯行情全局限速 15 次/秒) */
const FETCH_CONCURRENCY = 8;
/** 单标的信号生成的样本下限 (少于 2 根无法决策) */
const MIN_BARS = 2;
/** 信号生成用的名义本金: 只影响策略内部仓位判断, 组合层会重新分配资金 */
const SIGNAL_NOMINAL_CASH = 1_000_000;
/** 任务保留时长 / 最大历史任务数 */
const JOB_TTL_MS = 30 * 60 * 1000;
const MAX_JOBS = 3;
/** 连续拉取失败且无任何成功时提前终止 */
const MAX_FETCH_FAILURES_BEFORE_ABORT = 40;
/** Python 执行超时 */
const PY_TIMEOUT_MS = 20 * 60 * 1000;
/** 诊断信息最多保留条数 */
const MAX_DIAGNOSTICS = 40;

const DEFAULT_COUNT = 800;

// ---------------------------------------------------------------------------
// Python 引擎定位
// ---------------------------------------------------------------------------

function pythonBin(): string {
  if (process.env.BACKTRADER_PYTHON) return process.env.BACKTRADER_PYTHON;
  return fs.existsSync(VENV_PY) ? VENV_PY : 'python3';
}

let healthCache: { at: number; value: SimulationEngineHealth } | null = null;

/** 组合执行层健康检查 (backtrader 是否可用), 结果缓存 60s */
export function simulationEngineHealth(): SimulationEngineHealth {
  if (healthCache && Date.now() - healthCache.at < 60_000) return healthCache.value;

  const python = pythonBin();
  const probe = spawnSync(
    python,
    ['-c', 'import backtrader, sys; print(backtrader.__version__); print(sys.version.split()[0])'],
    { encoding: 'utf-8', timeout: 15_000 },
  );
  const lines = (probe.stdout || '').trim().split('\n').filter(Boolean);
  const value: SimulationEngineHealth =
    probe.status === 0 && lines.length >= 2
      ? { ready: true, python, engine: 'backtrader', version: lines[0] }
      : {
          ready: false,
          python,
          error:
            (probe.stderr || probe.error?.message || '').trim() ||
            'backtrader 不可用, 请先运行 npm run sim:setup',
        };
  healthCache = { at: Date.now(), value };
  return value;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/** A 股涨跌幅限制: ST 5%, 创业板/科创板 20%, 北交所 30%, 其余 10% */
function limitPctFor(code: string, name?: string): number {
  if (name && /ST/i.test(name)) return 0.05;
  if (/^(688|689|300|301)/.test(code)) return 0.2;
  if (/^(43|83|87|88|92)/.test(code)) return 0.3;
  return 0.1;
}

function isPortfolioSignalRow(row: PortfolioSignalRow): boolean {
  return row.action === 'BUY' || row.action === 'SELL';
}

function normalizeCustom(list: string[] | undefined, meta: StockMeta): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list ?? []) {
    const clean = String(raw ?? '').trim().toUpperCase();
    if (!clean) continue;
    const { resolved } = resolveSymbol(clean);
    if (!isAshareSymbol(resolved)) continue;
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const code = resolved.split('.')[0];
    if (!meta.names[code]) {
      // 允许代码存在但名称缺失, 照常纳入股票池
    }
    out.push(resolved);
  }
  return out;
}

/** 归一化输入 + 生成同参数任务指纹 */
function normalizeInput(raw: PortfolioSimulationInput): PortfolioSimulationInput {
  const indexes = [...new Set((raw.indexes ?? []).filter((v): v is IndexId => v === 'hs300' || v === 'zz500'))];
  const custom = [...new Set((raw.custom ?? []).map((s) => String(s).trim().toUpperCase()).filter(Boolean))];
  const validBoards = new Set<ExcludableBoard>(EXCLUDABLE_BOARDS.map((b) => b.id));
  // 排序 + 去重: 保证同一组排除板块的任务指纹稳定
  const excludeBoards = [
    ...new Set(
      (Array.isArray(raw.excludeBoards) ? raw.excludeBoards : []).filter(
        (v): v is ExcludableBoard => typeof v === 'string' && validBoards.has(v as ExcludableBoard),
      ),
    ),
  ].sort();
  const input: PortfolioSimulationInput = {
    strategyId: String(raw.strategyId ?? '').trim(),
    indexes,
    custom,
    excludeBoards,
    limit:
      typeof raw.limit === 'number' && raw.limit > 0 ? Math.min(Math.floor(raw.limit), 5000) : undefined,
    adjust: raw.adjust === 'backward' ? 'backward' : raw.adjust === '' ? '' : 'forward',
    initialCash: raw.initialCash && raw.initialCash > 0 ? raw.initialCash : 100_000,
    commissionRate:
      typeof raw.commissionRate === 'number' && raw.commissionRate >= 0 ? raw.commissionRate : 0.00025,
    minCommission:
      typeof raw.minCommission === 'number' && raw.minCommission >= 0 ? raw.minCommission : 5,
    maxPositions:
      typeof raw.maxPositions === 'number' && raw.maxPositions > 0 ? Math.floor(raw.maxPositions) : 10,
    positionPercent:
      typeof raw.positionPercent === 'number' && raw.positionPercent > 0
        ? Math.min(raw.positionPercent, 100)
        : 10,
    stopLossPercent:
      typeof raw.stopLossPercent === 'number' && raw.stopLossPercent > 0 && raw.stopLossPercent < 100
        ? raw.stopLossPercent
        : undefined,
    rotationEnabled: raw.rotationEnabled === true,
    rotationMinScoreDelta:
      typeof raw.rotationMinScoreDelta === 'number' && Number.isFinite(raw.rotationMinScoreDelta)
        ? raw.rotationMinScoreDelta
        : 1,
    rotationMaxPerDay:
      typeof raw.rotationMaxPerDay === 'number' && raw.rotationMaxPerDay > 0
        ? Math.floor(raw.rotationMaxPerDay)
        : 2,
    benchmark: isPortfolioBenchmarkId(raw.benchmark) ? raw.benchmark : DEFAULT_BENCHMARK,
    rangeStart: raw.rangeStart || undefined,
    rangeEnd: raw.rangeEnd || undefined,
    force: raw.force === true,
    params: raw.params && typeof raw.params === 'object' ? { ...raw.params } : {},
    selectedIndicatorIds: Array.isArray(raw.selectedIndicatorIds)
      ? raw.selectedIndicatorIds.filter((v): v is string => typeof v === 'string')
      : undefined,
  };
  if (indexes.length === 0 && custom.length === 0) {
    throw Object.assign(new Error('请至少选择一个股票池 (沪深300 / 中证500) 或添加自定义标的'), {
      statusCode: 400,
    });
  }
  if (!input.strategyId) {
    throw Object.assign(new Error('strategyId is required'), { statusCode: 400 });
  }
  return input;
}

function sameConfig(a: PortfolioSimulationInput, b: PortfolioSimulationInput): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// 任务
// ---------------------------------------------------------------------------

interface SymbolSignals {
  symbol: string;
  klines: Kline[];
  signals: { date: string; action: 'BUY' | 'SELL'; reason?: string; confidence?: number; price: number }[];
  /** date -> 吸引力分数 (含 HOLD 日), 组合层轮动比较用 */
  scores: { date: string; score: number }[];
}

export class PortfolioSimulationJob {
  readonly id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  readonly startedAt = Date.now();
  readonly input: PortfolioSimulationInput;

  state: 'running' | 'done' | 'error' | 'cancelled' = 'running';
  error?: string;
  finishedAt?: number;

  readonly progress: {
    phase: PortfolioSimulationPhase;
    message: string;
    total: number;
    done: number;
    fetched: number;
    cached: number;
    failed: number;
    signals: number;
    signalCached: number;
    signalComputed: number;
    /** 命中旧区间并只续算新增 K 线的标的数 */
    signalExtended: number;
    simulationDay: number;
    simulationTotalDays: number;
    startedAt: number;
    updatedAt: number;
  };

  private readonly controller = new AbortController();
  private readonly diagnostics: BacktestDiagnostic[] = [];
  private readonly failures: { symbol: string; error: string }[] = [];
  private readonly bundle: string;
  private signalRows: PortfolioSignalRow[] = [];
  private result: PortfolioSimulationResult | null = null;
  /** 因板块排除被剔除的标的数 */
  private excludedCount = 0;
  /** 内置市场环境快照 (中证全债/10Y/PE/ERP 等), 与 K 线拉取并行获取 */
  private marketContext: PortfolioMarketIndicator[] = [];
  private child: ChildProcessWithoutNullStreams | null = null;

  constructor(
    input: PortfolioSimulationInput,
    private readonly strategy: UserStrategyDefinition,
    private readonly meta: StockMeta,
  ) {
    this.input = input;
    this.bundle = path.join(SIM_DIR, this.id);
    this.progress = {
      phase: 'queued',
      message: '任务已创建',
      total: 0,
      done: 0,
      fetched: 0,
      cached: 0,
      failed: 0,
      signals: 0,
      signalCached: 0,
      signalComputed: 0,
      signalExtended: 0,
      simulationDay: 0,
      simulationTotalDays: 0,
      startedAt: this.startedAt,
      updatedAt: this.startedAt,
    };
  }

  get cancelled(): boolean {
    return this.controller.signal.aborted;
  }

  cancel(): void {
    if (this.state !== 'running') return;
    this.controller.abort();
    try {
      this.child?.kill('SIGTERM');
    } catch { /* 进程可能已退出 */ }
    this.state = 'cancelled';
    this.finishedAt = Date.now();
    this.touch({ phase: 'cancelled', message: '任务已中断' });
  }

  /** 前端轮询视图: 信号账本单独分页接口, 不随主报告下发 */
  view(): PortfolioSimulationJobView {
    this.touch({});
    const result = this.result ? { ...this.result, signals: undefined } : undefined;
    return {
      id: this.id,
      state: this.state,
      progress: { ...this.progress },
      input: this.input,
      result,
      error: this.error,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
    };
  }

  /** 信号账本分页 (按日期 -> 标的排序, 已成交/被跳过都可查) */
  signalPage(query: PortfolioSignalQuery = {}): PortfolioSignalPage {
    const limit = Math.min(Math.max(Math.floor(query.limit ?? 200), 1), 1000);
    const offset = Math.max(Math.floor(query.offset ?? 0), 0);
    const action = query.action ?? 'ALL';
    const symbol = query.symbol?.trim();

    let rows = this.signalRows;
    if (action === 'BUY' || action === 'SELL') rows = rows.filter((r) => r.action === action);
    else if (action === 'SKIPPED') rows = rows.filter((r) => r.status !== 'filled');
    if (symbol) rows = rows.filter((r) => r.symbol === symbol);

    return {
      rows: rows.slice(offset, offset + limit),
      total: rows.length,
      offset,
      limit,
    };
  }

  symbolStats(): PortfolioSymbolStat[] {
    return this.result?.symbolStats ?? [];
  }

  private touch(patch: Partial<PortfolioSimulationJob['progress']>): void {
    Object.assign(this.progress, patch);
    this.progress.updatedAt = Date.now();
  }

  private noteDiagnostics(list: readonly BacktestDiagnostic[]): void {
    for (const d of list) {
      if (this.diagnostics.length >= MAX_DIAGNOSTICS) break;
      if (d.level === 'error') this.diagnostics.push(d);
      else if (this.diagnostics.length < MAX_DIAGNOSTICS / 2) this.diagnostics.push(d);
    }
  }

  async run(): Promise<void> {
    try {
      fs.rmSync(this.bundle, { recursive: true, force: true });
      fs.mkdirSync(this.bundle, { recursive: true });
      // 顺手清理过期/超量的信号缓存 (节流, 失败不影响任务)
      try {
        pruneSignalCache();
      } catch { /* ignore */ }
      this.touch({ phase: 'fetching', message: '构建股票池…' });

      const fullUniverse = await buildUniverse(this.input.indexes, this.input.custom ?? []);
      const excludeBoards = this.input.excludeBoards ?? [];
      const boardFiltered = excludeBoards.length
        ? fullUniverse.filter((s) => !isBoardExcluded(s, excludeBoards))
        : fullUniverse;
      this.excludedCount = fullUniverse.length - boardFiltered.length;
      if (excludeBoards.length && this.excludedCount > 0) {
        this.diagnostics.push({
          level: 'warning',
          message: `已排除 ${describeExcludedBoards(excludeBoards)}: 剔除 ${this.excludedCount} 只, 剩余 ${boardFiltered.length} 只`,
        });
      }
      if (boardFiltered.length === 0) {
        throw Object.assign(
          new Error(`排除 ${describeExcludedBoards(excludeBoards)} 后股票池为空, 请调整排除范围或股票池`),
          { statusCode: 400 },
        );
      }
      const universe = this.input.limit ? boardFiltered.slice(0, this.input.limit) : boardFiltered;
      this.progress.total = universe.length;
      this.touch({
        message: excludeBoards.length
          ? `股票池 ${universe.length} 只 (已排除 ${describeExcludedBoards(excludeBoards)} ${this.excludedCount} 只), 开始拉取历史数据`
          : `股票池 ${universe.length} 只, 开始拉取历史数据`,
      });

      // 默认市场基准 (沪深300全收益/中证全债/国债收益率/PE/ERP) 与 K 线并行准备,
      // 失败不影响主流程, 只降级为「无基准」并在结果诊断中提示。
      const baselinePromise: Promise<MarketBaselineBundle | null> = getMarketBaselines(
        this.input.force === true,
      ).catch((err) => {
        this.failures.push({
          symbol: 'market-baseline',
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      });

      const klinesMap = await this.fetchAll(universe);
      if (this.cancelled) return;
      const usable = [...klinesMap.entries()].filter(([, bars]) => bars.length >= MIN_BARS);
      if (usable.length === 0) {
        throw Object.assign(new Error('所有标的均无可用 K 线, 请检查数据源或区间'), { statusCode: 400 });
      }

      this.touch({
        phase: 'generating-signals',
        total: usable.length,
        done: 0,
        message: `生成逐日信号 (0/${usable.length})${this.input.force === true ? ' · 已强制刷新, 跳过信号缓存' : ' · 优先读信号缓存'}`,
      });
      const runs = await this.generateSignals(usable);
      if (this.cancelled) return;

      const baseline = await baselinePromise;
      if (baseline) {
        this.marketContext = buildMarketContext(baseline);
        if (baseline.warnings.length > 0) {
          this.diagnostics.push({
            level: 'warning',
            message: `市场基准数据部分缺失: ${baseline.warnings.slice(0, 3).join('; ')}`,
          });
        }
      }

      const payload = this.writeBundle(runs, baseline);
      this.touch({
        phase: 'simulating',
        message: `backtrader 逐日撮合 (${payload.calendarDays} 个交易日, ${payload.symbolCount} 只标的)`,
        simulationTotalDays: payload.calendarDays,
        simulationDay: 0,
      });

      const outPath = path.join(this.bundle, 'result.json');
      await this.runPython(outPath);
      if (this.cancelled) return;

      this.result = this.buildResult(outPath, usable.length, universe.length);
      this.state = 'done';
      this.touch({
        phase: 'done',
        message: `组合模拟完成: ${this.result.stats.tradingDays} 个交易日, ${this.result.stats.fills} 笔成交`,
      });
    } catch (err) {
      if (this.cancelled) return;
      this.state = 'error';
      this.error = err instanceof Error ? err.message : String(err);
      this.touch({ phase: 'error', message: this.error });
      console.error('[simulation] 任务失败:', err);
    } finally {
      this.finishedAt = Date.now();
      this.child = null;
    }
  }

  // ------------------------------------------------------------------
  // 1) 拉取 K 线 (保留历史数据下载/缓存/增量更新链路)
  // ------------------------------------------------------------------

  private async fetchAll(universe: string[]): Promise<Map<string, Kline[]>> {
    const out = new Map<string, Kline[]>();
    const signal = this.controller.signal;
    let cursor = 0;

    const worker = async () => {
      while (!signal.aborted && cursor < universe.length) {
        const symbol = universe[cursor++];
        try {
          const query = await getKlines(symbol, '1d', DEFAULT_COUNT, this.input.adjust ?? 'forward', this.input.force === true);
          let bars = query.klines;
          if (this.input.rangeStart || this.input.rangeEnd) {
            bars = bars.filter(
              (k) =>
                (!this.input.rangeStart || k.date >= this.input.rangeStart) &&
                (!this.input.rangeEnd || k.date <= this.input.rangeEnd),
            );
          }
          if (bars.length >= MIN_BARS) out.set(symbol, bars);
          if (query.cached) this.progress.cached++;
          else this.progress.fetched++;
        } catch (err) {
          if (signal.aborted) break;
          this.progress.failed++;
          if (this.failures.length < 50) {
            this.failures.push({ symbol, error: err instanceof Error ? err.message : String(err) });
          }
          if (this.progress.failed >= MAX_FETCH_FAILURES_BEFORE_ABORT && out.size === 0) {
            this.controller.abort();
            throw new Error(`连续 ${this.progress.failed} 只标的拉取失败, 请检查行情源或稍后重试`);
          }
        } finally {
          if (!signal.aborted) {
            this.progress.done++;
            this.touch({ message: `拉取历史数据 ${this.progress.done}/${this.progress.total}` });
          }
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, universe.length) }, () => worker()));
    return out;
  }

  // ------------------------------------------------------------------
  // 2) 逐标的生成信号 (只用截至当根的数据)
  // ------------------------------------------------------------------

  private async generateSignals(entries: [string, Kline[]][]): Promise<SymbolSignals[]> {
    const runs: SymbolSignals[] = [];
    let done = 0;
    // 策略代码指纹只算一次; 缓存键不含组合层参数 (资金/仓位/止损/费用/基准)
    const strategyFp = strategyFingerprint(this.strategy);
    const useCache = this.input.force !== true;
    // 缓存键用「合并默认值后的实际参数」: 策略默认参数调整也应让旧信号失效
    const params = buildStrategyParams(this.strategy, this.input.params);
    const indicatorIds = this.input.selectedIndicatorIds ?? [];

    for (const [symbol, klines] of entries) {
      if (this.cancelled) break;
      try {
        const config = {
          symbol,
          adjust: this.input.adjust,
          strategyId: this.strategy.id,
          strategyFingerprint: strategyFp,
          params,
          selectedIndicatorIds: indicatorIds,
        };
        const configKey = signalCacheConfigKey(config);

        // 同配置下找覆盖「本次 K 线前缀」的旧条目: 整段命中直接复用, 前缀命中只续算新增 K 线
        const cached = useCache ? findSignalCache({ ...config, bars: klines }) : null;

        // 1) 整段命中: 直接复用上次算好的逐日信号
        if (cached && cached.bars === klines.length) {
          this.progress.signals += cached.signals.length;
          this.progress.signalCached++;
          runs.push({ symbol, klines, signals: cached.signals, scores: cached.scores });
          continue;
        }

        // 2) 前缀命中: 用旧区间末态恢复账户/持仓/成交, 只对新增 K 线调用策略
        const extendFrom = cached && cached.finalState ? cached : null;
        const out = runBacktest({
          klines,
          symbol,
          userId: 'portfolio-simulation',
          initialCash: SIGNAL_NOMINAL_CASH,
          currency: 'CNY',
          // 止损、仓位、T+1 全部由组合层执行; 这里只要策略原始观点
          strategy: this.strategy,
          params,
          selectedIndicatorIds: this.input.selectedIndicatorIds,
          recordSignals: true,
          resume: extendFrom
            ? {
                barCount: extendFrom.bars,
                signals: extendFrom.signals,
                scores: extendFrom.scores,
                account: extendFrom.finalState!.account,
                position: extendFrom.finalState!.position,
                trades: extendFrom.finalState!.trades,
              }
            : undefined,
        });
        this.noteDiagnostics(out.diagnostics);
        const seen = new Set<string>();
        const signals = (out.signals ?? [])
          .filter((s) => {
            if (!s.date || (s.action !== 'BUY' && s.action !== 'SELL')) return false;
            if (seen.has(s.date)) return false;
            seen.add(s.date);
            return true;
          })
          .map((s) => ({
            date: s.date,
            action: s.action,
            reason: s.reason,
            confidence: s.confidence,
            price: s.price,
          }));
        this.progress.signals += signals.length;
        if (extendFrom) this.progress.signalExtended++;
        else this.progress.signalComputed++;
        const scores = (out.dailyScores ?? [])
          .filter((s) => s.date && Number.isFinite(s.score))
          .map((s) => ({ date: s.date, score: s.score }));
        runs.push({ symbol, klines, signals, scores });

        writeSignalCache({
          version: SIGNAL_CACHE_VERSION,
          configKey,
          symbol,
          createdAt: new Date().toISOString(),
          bars: klines.length,
          firstDate: klines[0]?.date ?? '',
          lastDate: klines[klines.length - 1]?.date ?? '',
          barsFingerprint: barsFingerprint(klines),
          signals,
          scores,
          finalState: out.finalState,
        });
      } catch (err) {
        this.progress.failed++;
        if (this.failures.length < 50) {
          this.failures.push({ symbol, error: err instanceof Error ? err.message : String(err) });
        }
      } finally {
        done++;
        const cacheNotes = [
          this.progress.signalCached > 0 ? `整段命中 ${this.progress.signalCached}` : '',
          this.progress.signalExtended > 0 ? `增量续算 ${this.progress.signalExtended}` : '',
        ].filter(Boolean);
        const cacheNote = cacheNotes.length > 0 ? ` · ${cacheNotes.join(' / ')}` : '';
        this.touch({
          phase: 'generating-signals',
          done,
          message: `生成逐日信号 ${done}/${entries.length} · 已产生 ${this.progress.signals} 条${cacheNote}`,
        });
        // 让出事件循环, 保证轮询接口不被长任务完全阻塞
        await new Promise((r) => setImmediate(r));
      }
    }
    return runs;
  }

  // ------------------------------------------------------------------
  // 3) 写 bundle → 调用 backtrader
  // ------------------------------------------------------------------

  private writeBundle(
    runs: SymbolSignals[],
    baseline: MarketBaselineBundle | null,
  ): { calendarDays: number; symbolCount: number } {
    const barsDir = path.join(this.bundle, 'bars');
    fs.mkdirSync(barsDir, { recursive: true });

    const dateSet = new Set<string>();
    const symbols: {
      symbol: string;
      code: string;
      name?: string;
      industry?: string;
      limitPct: number;
      file: string;
    }[] = [];
    const signalMap: Record<string, Record<string, unknown>> = {};
    const scoreMap: Record<string, Record<string, number>> = {};

    for (const run of runs) {
      const code = run.symbol.split('.')[0];
      const name = this.meta.names[code];
      const file = `bars/${run.symbol.replace(/[^A-Za-z0-9._-]/g, '_')}.csv`;
      const lines = ['date,open,high,low,close,volume'];
      for (const k of run.klines) {
        dateSet.add(k.date);
        lines.push(`${k.date},${k.open},${k.high},${k.low},${k.close},${k.volume}`);
      }
      fs.writeFileSync(path.join(this.bundle, file), lines.join('\n') + '\n');

      symbols.push({
        symbol: run.symbol,
        code,
        name,
        industry: this.meta.industries[code],
        limitPct: limitPctFor(code, name),
        file,
      });

      if (run.signals.length > 0) {
        const days: Record<string, unknown> = {};
        for (const s of run.signals) {
          days[s.date] = {
            action: s.action,
            reason: s.reason,
            confidence: s.confidence,
            price: s.price,
          };
        }
        signalMap[run.symbol] = days;
      }
      if (run.scores.length > 0) {
        const scores: Record<string, number> = {};
        for (const s of run.scores) scores[s.date] = s.score;
        scoreMap[run.symbol] = scores;
      }
    }

    const calendar = [...dateSet].sort();
    fs.writeFileSync(path.join(this.bundle, 'calendar.csv'), 'date,open,high,low,close,volume\n' + calendar.map((d) => `${d},1,1,1,1,0`).join('\n') + '\n');
    fs.writeFileSync(path.join(this.bundle, 'symbols.json'), JSON.stringify(symbols));
    fs.writeFileSync(path.join(this.bundle, 'signals.json'), JSON.stringify(signalMap));
    fs.writeFileSync(path.join(this.bundle, 'scores.json'), JSON.stringify(scoreMap));

    const cfg = {
      initialCash: this.input.initialCash,
      commissionRate: this.input.commissionRate,
      minCommission: this.input.minCommission,
      stampDutyRate: 0.001,
      transferFeeRate: 0.00001,
      maxPositions: this.input.maxPositions,
      positionPercent: this.input.positionPercent,
      stopLossPercent: this.input.stopLossPercent ?? null,
      rotationEnabled: this.input.rotationEnabled === true,
      rotationMinScoreDelta: this.input.rotationMinScoreDelta ?? 1,
      rotationMaxPerDay: this.input.rotationMaxPerDay ?? 2,
    };
    fs.writeFileSync(path.join(this.bundle, 'config.json'), JSON.stringify(cfg));

    // 默认市场基准: 组合基准 (default 沪深300全收益) + 市场环境面板原始序列
    fs.writeFileSync(
      path.join(this.bundle, 'baselines.json'),
      JSON.stringify({
        benchmark: this.input.benchmark ?? DEFAULT_BENCHMARK,
        series: baseline?.series ?? {},
      }),
    );

    return { calendarDays: calendar.length, symbolCount: symbols.length };
  }

  private runPython(outPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.cancelled) return reject(new Error('cancelled'));
      const python = pythonBin();
      const child = spawn(python, [PY_SCRIPT, '--bundle', this.bundle, '--out', outPath], {
        cwd: ROOT_DIR,
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.child = child;

      let stderr = '';
      const timer = setTimeout(() => {
        stderr += `\n[simulation] backtrader 超时 (${PY_TIMEOUT_MS / 1000}s), 已终止`;
        child.kill('SIGKILL');
      }, PY_TIMEOUT_MS);

      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        const text = line.trim();
        if (!text.startsWith('{')) return;
        let msg: any;
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        if (msg.type === 'progress') {
          this.touch({
            phase: 'simulating',
            message: String(msg.message ?? 'backtrader 逐日撮合中'),
            simulationDay: Number(msg.day ?? 0),
            simulationTotalDays: Number(msg.total ?? this.progress.simulationTotalDays),
          });
        } else if (msg.type === 'error') {
          stderr += `\n${msg.message ?? 'backtrader error'}`;
        }
      });

      child.stderr.on('data', (buf) => {
        stderr += buf.toString();
        if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`无法启动组合执行引擎 (${python}): ${err.message}. 请先运行 npm run sim:setup`));
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        this.child = null;
        if (this.cancelled) return reject(new Error('cancelled'));
        if (code !== 0) {
          return reject(new Error(`backtrader 退出码 ${code}: ${stderr.trim().split('\n').slice(-6).join(' | ')}`));
        }
        if (!fs.existsSync(outPath)) {
          return reject(new Error(`backtrader 未生成结果文件: ${stderr.trim().split('\n').slice(-6).join(' | ')}`));
        }
        resolve();
      });
    });
  }

  // ------------------------------------------------------------------
  // 4) 结果整形
  // ------------------------------------------------------------------

  private buildResult(outPath: string, tested: number, universeSize: number): PortfolioSimulationResult {
    const raw = JSON.parse(fs.readFileSync(outPath, 'utf-8')) as PortfolioSimulationResult;

    const signals: PortfolioSignalRow[] = (raw.signals ?? [])
      .filter(isPortfolioSignalRow)
      .map((s) => {
        const code = String(s.symbol ?? '').split('.')[0];
        return {
          ...s,
          code: s.code ?? code,
          name: s.name ?? this.meta.names[code],
          status: s.status ?? 'skipped',
        };
      })
      .sort((a, b) => (a.date === b.date ? a.symbol.localeCompare(b.symbol) : a.date.localeCompare(b.date)));
    this.signalRows = signals;

    const trades: PortfolioTradeRow[] = [...(raw.trades ?? [])].sort((a, b) =>
      a.date === b.date ? a.symbol.localeCompare(b.symbol) : a.date.localeCompare(b.date),
    );
    const openPositions: PortfolioOpenPosition[] = (raw.openPositions ?? []).map((p) => {
      const code = String(p.symbol ?? '').split('.')[0];
      return { ...p, code: p.code ?? code, name: p.name ?? this.meta.names[code] };
    });
    const symbolStats: PortfolioSymbolStat[] = (raw.symbolStats ?? []).map((s) => {
      const code = String(s.symbol ?? '').split('.')[0];
      return {
        ...s,
        code: s.code ?? code,
        name: s.name ?? this.meta.names[code],
        industry: s.industry ?? this.meta.industries[code],
      };
    });
    const equity: PortfolioEquityPoint[] = raw.equity ?? [];
    const benchmarkId = this.input.benchmark ?? DEFAULT_BENCHMARK;

    return {
      ...raw,
      signals: undefined,
      benchmark: { id: benchmarkId, name: BENCHMARKS[benchmarkId].name },
      marketContext: this.marketContext,
      equity,
      trades,
      openPositions,
      symbolStats,
      diagnostics: [...this.diagnostics],
      failures: [...this.failures],
      universeSize,
      tested,
      signalCount: signals.length,
      excludedBoards: this.input.excludeBoards ?? [],
      excludedCount: this.excludedCount,
      signalCacheHits: this.progress.signalCached,
      signalCacheIncremental: this.progress.signalExtended,
      signalCacheMisses: this.progress.signalComputed,
    };
  }
}

// ---------------------------------------------------------------------------
// 任务调度: 全局同一时间只跑一个组合模拟
// ---------------------------------------------------------------------------

const jobs = new Map<string, PortfolioSimulationJob>();
let activeJob: PortfolioSimulationJob | null = null;

function pruneJobs(): void {
  const now = Date.now();
  const completed: PortfolioSimulationJob[] = [];
  for (const job of jobs.values()) {
    if (job.state !== 'running' && job.finishedAt && now - job.finishedAt > JOB_TTL_MS) {
      jobs.delete(job.id);
    } else if (job.state !== 'running') {
      completed.push(job);
    }
  }
  completed.sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
  while (completed.length > MAX_JOBS) {
    jobs.delete(completed.shift()!.id);
  }
}

export interface PortfolioSimulationRequestResult {
  job: PortfolioSimulationJob;
  attached: boolean;
}

export async function requestPortfolioSimulation(
  raw: PortfolioSimulationInput,
): Promise<PortfolioSimulationRequestResult> {
  pruneJobs();

  const meta = await loadStockMeta();
  const input = normalizeInput(raw);
  input.custom = normalizeCustom(input.custom, meta);

  if (input.indexes.length === 0 && input.custom.length === 0) {
    throw Object.assign(new Error('股票池为空: 自定义代码需为 6 位 A 股代码'), { statusCode: 400 });
  }

  const strategies = await loadStrategies();
  const strategy = strategies.find((s) => s.id === input.strategyId);
  if (!strategy) {
    const available = strategies.map((s) => `${s.id} (${s.name})`).join(', ');
    throw Object.assign(new Error(`策略未找到: ${input.strategyId}. 可用策略: ${available}`), { statusCode: 400 });
  }

  const health = simulationEngineHealth();
  if (!health.ready) {
    throw Object.assign(
      new Error(`组合执行引擎不可用: ${health.error}. 请运行 npm run sim:setup 安装 backtrader`),
      { statusCode: 503 },
    );
  }

  const current = activeJob;
  if (current && current.state === 'running') {
    if (sameConfig(current.input, input)) return { job: current, attached: true };
    throw Object.assign(
      new Error(`已有组合模拟任务在进行中 (${current.progress.phase}), 请等待完成或先中断`),
      { statusCode: 409, jobId: current.id },
    );
  }

  const job = new PortfolioSimulationJob(input, strategy, meta);
  jobs.set(job.id, job);
  activeJob = job;
  void job.run().finally(() => {
    if (activeJob === job) activeJob = null;
    pruneJobs();
  });
  return { job, attached: false };
}

export function getPortfolioSimulationJob(id: string): PortfolioSimulationJob | null {
  return jobs.get(id) ?? null;
}
