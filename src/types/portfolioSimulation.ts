/**
 * 股票池「共享资金逐日组合模拟」契约。
 *
 * 分工:
 *   - TS 策略引擎 (runBacktest) 只用截至当根的数据产出 BUY/SELL 信号;
 *   - Python backtrader 负责组合层逐日撮合 (共享现金、仓位上限、T+1、涨跌停、费用)。
 */
import type { BacktestDiagnostic } from './strategy';
import type { IndexId } from './scan';
import type { ExcludableBoard } from '../utils/symbols';

export type PortfolioSimulationPhase =
  | 'queued'
  | 'fetching'
  | 'generating-signals'
  | 'simulating'
  | 'done'
  | 'error'
  | 'cancelled';

/** 组合基准: 沪深300全收益 (默认) / 沪深300 / 池内等权买入持有 */
export type PortfolioBenchmarkId = 'hs300_tr' | 'hs300' | 'equal_weight';

export interface PortfolioBenchmarkInfo {
  id: PortfolioBenchmarkId;
  name: string;
}

/** 内置市场环境指标 (默认随每次模拟拉取, 不参与选股) */
export interface PortfolioMarketIndicator {
  id: string;
  name: string;
  unit: string;
  source: string;
  kind: 'index' | 'yield' | 'valuation' | 'derived';
  lastDate: string;
  lastValue: number;
  /** 最近一个交易日变化: 指数为 %, 利率/估值/派生为绝对值 (百分点或倍数) */
  change1d: number | null;
  /** 近 20 个交易日变化: 指数为 %, 利率/估值/派生为绝对值 */
  change20d: number | null;
  /** 近 120 个交易日的迷你走势 */
  spark: { date: string; value: number }[];
}

export interface PortfolioSimulationInput {
  indexes: IndexId[];
  /** 附加自定义标的 (6 位代码或带后缀) */
  custom?: string[];
  /**
   * 从股票池中排除的板块 (在 limit 之前生效):
   * 'chinext' = 创业板 300/301, 'star' = 科创板 688/689, 'bse' = 北交所。
   * 不传 / 空数组表示不排除。
   */
  excludeBoards?: ExcludableBoard[];
  /** 只取股票池前 N 只 (调试/小样本验证), 不传为全池 */
  limit?: number;
  adjust?: 'forward' | 'backward' | '';
  /** 组合初始资金 (CNY) */
  initialCash?: number;
  /** 佣金费率, 默认 0.00025 */
  commissionRate?: number;
  /** 单笔最低佣金, 默认 5 */
  minCommission?: number;
  /** 最大同时持仓数, 默认 10 */
  maxPositions?: number;
  /** 单只建仓占组合权益百分比, 默认 10 */
  positionPercent?: number;
  /** 固定止损百分比, 可选 (由 backtrader 按盘中触发价成交) */
  stopLossPercent?: number;
  /** 是否启用轮动换仓: 持仓已满时, 用更强的候选替换最弱的持仓 */
  rotationEnabled?: boolean;
  /** 轮动所需的最小分数优势 (分数与策略 score 同量纲), 默认 1 */
  rotationMinScoreDelta?: number;
  /** 每个交易日最多轮动换仓多少只, 默认 2 */
  rotationMaxPerDay?: number;
  /** 组合基准, 默认沪深300全收益 (H00300) */
  benchmark?: PortfolioBenchmarkId;
  rangeStart?: string;
  rangeEnd?: string;
  force?: boolean;
  strategyId: string;
  params?: Record<string, unknown>;
  selectedIndicatorIds?: string[];
}

export interface PortfolioSignalRow {
  date: string;
  symbol: string;
  code: string;
  name?: string;
  action: 'BUY' | 'SELL';
  reason?: string;
  confidence?: number;
  /** 信号当根收盘价 */
  price: number;
  /** 组合层执行结果 */
  status: 'filled' | 'skipped' | 'rejected';
  skipReason?: string;
  shares?: number;
  fee?: number;
  pnl?: number;
}

export interface PortfolioTradeRow {
  date: string;
  symbol: string;
  code?: string;
  name?: string;
  side: 'BUY' | 'SELL';
  price: number;
  shares: number;
  value: number;
  fee: number;
  reason?: string;
  pnl?: number;
  pnlPercent?: number;
  holdDays?: number;
  entryDate?: string;
}

export interface PortfolioEquityPoint {
  date: string;
  value: number;
  cash: number;
  positionValue: number;
  positions: number;
  /** 等权买入持有基准 (同一初始资金) */
  benchmark: number;
}

export interface PortfolioOpenPosition {
  symbol: string;
  code?: string;
  name?: string;
  shares: number;
  avgCost: number;
  price: number;
  marketValue: number;
  weightPercent: number;
  pnl: number;
  pnlPercent: number;
  entryDate: string;
}

export interface PortfolioSymbolStat {
  symbol: string;
  code?: string;
  name?: string;
  industry?: string;
  buys: number;
  sells: number;
  closedTrades: number;
  winRate: number;
  realizedPnl: number;
  realizedReturnPercent: number;
  fees: number;
}

export interface PortfolioSimulationStats {
  initialCash: number;
  finalEquity: number;
  totalReturnPercent: number;
  annualizedReturnPercent: number;
  benchmarkReturnPercent: number;
  excessReturnPercent: number;
  maxDrawdownPercent: number;
  sharpeRatio: number;
  /** 全部成交笔数 (买 + 卖) */
  fills: number;
  /** 已平仓交易笔数 (按卖出笔数计) */
  closedTrades: number;
  winningTrades: number;
  winRate: number;
  totalFees: number;
  avgPositions: number;
  exposurePercent: number;
  tradingDays: number;
}

export interface PortfolioSimulationResult {
  engine: { name: string; version: string; python: string };
  stats: PortfolioSimulationStats;
  /** 本次使用的基准 (默认沪深300全收益) */
  benchmark: PortfolioBenchmarkInfo;
  /** 内置市场环境指标: 中证全债 / 10Y 国债 / 沪深300 PE / ERP 等 */
  marketContext: PortfolioMarketIndicator[];
  dateRange: { start: string; end: string };
  equity: PortfolioEquityPoint[];
  trades: PortfolioTradeRow[];
  /** 主报告不带信号账本 (单独分页接口), 仅 CLI/调试结果可能包含 */
  signals?: PortfolioSignalRow[];
  symbolStats: PortfolioSymbolStat[];
  openPositions: PortfolioOpenPosition[];
  diagnostics: BacktestDiagnostic[];
  failures: { symbol: string; error: string }[];
  universeSize: number;
  tested: number;
  signalCount: number;
  /** 本次实际排除的板块 (未排除时为空/缺省) */
  excludedBoards?: ExcludableBoard[];
  /** 因板块排除而被剔除的标的数量 */
  excludedCount?: number;
  /** 逐日信号缓存: 整段命中 / 增量续算 / 新计算的标的数 */
  signalCacheHits?: number;
  signalCacheIncremental?: number;
  signalCacheMisses?: number;
}

export interface PortfolioSimulationProgress {
  phase: PortfolioSimulationPhase;
  message: string;
  total: number;
  done: number;
  fetched: number;
  cached: number;
  failed: number;
  signals: number;
  /** 「生成逐日信号」阶段命中磁盘缓存的标的数 (整段复用) */
  signalCached: number;
  /** 「生成逐日信号」阶段命中旧区间、只续算新增 K 线的标的数 */
  signalExtended: number;
  /** 「生成逐日信号」阶段实际从头重算的标的数 */
  signalComputed: number;
  simulationDay: number;
  simulationTotalDays: number;
  startedAt: number;
  updatedAt: number;
}

export interface PortfolioSimulationJobView {
  id: string;
  state: 'running' | 'done' | 'error' | 'cancelled';
  progress: PortfolioSimulationProgress;
  input: PortfolioSimulationInput;
  result?: PortfolioSimulationResult;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface PortfolioSignalQuery {
  limit?: number;
  offset?: number;
  action?: 'ALL' | 'BUY' | 'SELL' | 'SKIPPED';
  symbol?: string;
}

export interface PortfolioSignalPage {
  rows: PortfolioSignalRow[];
  total: number;
  offset: number;
  limit: number;
}

export interface SimulationEngineHealth {
  ready: boolean;
  python: string;
  engine?: string;
  version?: string;
  error?: string;
}
