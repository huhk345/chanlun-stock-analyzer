/**
 * 选股池组合回测 —— 前后端共享契约。
 *
 * 单标的回测 (server/backtest.ts) 回答「这只票上策略表现如何」;
 * 选股池回测 (server/poolBacktest.ts) 回答「这套策略在整个股票池上表现如何」:
 * 对池内每只标的用同一策略、同一名义本金独立回测, 再等权汇总成组合报告。
 *
 * 前端 (SimulationView) 通过 HTTP 轮询获取任务进度与最终结果:
 *   POST /api/backtest/pool              -> 发起任务, 返回 jobId
 *   GET  /api/backtest/pool/:id          -> 任务进度 / 最终组合报告
 *   GET  /api/backtest/pool/:id/symbol/:symbol -> 单只标的高亮明细
 *   GET  /api/backtest/pool/:id/trades   -> 全池逐笔成交 (按日期升序, 全部成交明细视图)
 *   POST /api/backtest/pool/:id/cancel   -> 中断任务
 */
import type { BacktestDiagnostic } from './strategy';
import type { BacktestResult, Kline } from './stock';

export type PoolPeriod = '1d' | '1w';

export interface PoolBacktestInput {
  /** 策略 ID (从 /api/strategies 获取), 必填 */
  strategyId: string;
  /** 股票池: 沪深300 / 中证500 (可多选, 两者都选 = 全部) */
  indexes: ('hs300' | 'zz500')[];
  /** 附加自定义标的 (可选) */
  custom?: string[];
  /** K 线周期: '1d' | '1w', 默认 '1d' */
  period?: PoolPeriod;
  /** 每只标的拉取根数, 默认 400 (命中本地缓存更快) */
  count?: number;
  /** 复权口径: 'forward' | 'backward' | '', 默认 'forward' */
  adjust?: string;
  /**
   * 单只标的名义本金 (CNY), 默认 100,000。
   * 每只标的都以同一名义本金独立回测, 组合绩效按等权平均计算,
   * 因此该值只影响手续费/整手取整等微观行为, 不影响对比口径。
   */
  initialCash?: number;
  /** 佣金费率, 默认 0.00025 (万分之 2.5) */
  commissionRate?: number;
  /** 最低佣金 per 笔 (CNY), 默认 5 */
  minCommission?: number;
  /** 固定止损百分比, 可选 */
  stopLossPercent?: number;
  /** 策略参数覆盖 */
  params?: Record<string, unknown>;
  /** 回测区间起始日 (YYYY-MM-DD), 可选 */
  rangeStart?: string;
  /** 回测区间结束日 (YYYY-MM-DD), 可选 */
  rangeEnd?: string;
  /** 强制刷新 K 线缓存, 默认 false */
  force?: boolean;
}

export interface PoolBacktestProgress {
  /** 股票池标的数 */
  total: number;
  /** 已处理 */
  done: number;
  /** 成功 */
  ok: number;
  /** 失败 */
  failed: number;
  /** 成功且产生过交易的标的数 */
  traded: number;
  /** 其中命中本地 K 线缓存的数量 */
  cached: number;
}

/** 池内单只标的的回测摘要行 */
export interface PoolSymbolResult {
  symbol: string;
  code: string;
  name?: string;
  industry?: string;
  initialBalance: number;
  finalBalance: number;
  /** 策略收益 % */
  returnPercent: number;
  /** 买入持有收益 % */
  buyHoldPercent: number;
  /** 相对买入持有的超额 % */
  excessPercent: number;
  /** 已平仓口径的累计交易笔数 */
  trades: number;
  winRate: number;
  sharpeRatio: number;
  maxDrawdownPercent: number;
  fees: number;
  klinesCount: number;
  dateRange: { start: string; end: string };
}

/** 组合级汇总报告 (等权) */
export interface PoolBacktestSummary {
  universeSize: number;
  /** 成功完成回测的标的数 */
  tested: number;
  failed: number;
  /** 产生过交易的标的数 */
  traded: number;
  /** 策略收益为正的标的数 */
  profitable: number;
  /** 跑赢买入持有的标的数 */
  beatBuyHold: number;
  /** 单只标的名义本金 */
  initialCash: number;
  /** 组合期末权益 (等权平均口径) */
  finalEquity: number;
  /** 组合总收益 % (各标的策略收益的等权平均) */
  totalReturnPercent: number;
  /** 等权买入持有收益 % */
  buyHoldReturnPercent: number;
  /** 组合权益曲线最大回撤 % */
  maxDrawdownPercent: number;
  /** 组合权益曲线夏普比率 */
  sharpeRatio: number;
  /** 盈利标的占比 % */
  symbolWinRate: number;
  /** 跑赢买入持有的标的占比 % */
  beatBuyHoldRate: number;
  meanReturnPercent: number;
  medianReturnPercent: number;
  totalTrades: number;
  totalFees: number;
  /** 组合权益曲线 (等权平均, 起点 = initialCash) */
  equityCurve: number[];
  equityDates: string[];
  dateRange: { start: string; end: string };
  /** 逐标的摘要, 按收益从高到低 */
  rows: PoolSymbolResult[];
  /** 失败标的及原因 (最多保留前 50 条) */
  failures: { symbol: string; error: string }[];
}

export type PoolJobState = 'running' | 'done' | 'cancelled' | 'error';

/** 任务视图: 前端轮询拿到的完整任务状态 */
export interface PoolBacktestJobView {
  id: string;
  state: PoolJobState;
  progress: PoolBacktestProgress;
  /** 并发窗口内正在回测的标的 (按开始顺序, 最多 = 服务端并发数) */
  active: string[];
  startedAt: number;
  finishedAt?: number;
  /** 发起任务时的输入 (附带在响应上, 便于前端确认参数) */
  input: PoolBacktestInput;
  error?: string;
  /** state === 'done' 时存在 */
  result?: PoolBacktestSummary;
}

/** 单只标的明细 (点击池排行榜某一行时按需拉取) */
export interface PoolSymbolDetailView {
  symbol: string;
  period: PoolPeriod;
  adjust: string;
  klinesCount: number;
  dateRange: { start: string; end: string };
  result: BacktestResult;
  diagnostics: BacktestDiagnostic[];
  equityCurve: number[];
  equityDates: string[];
  /** 回测实际使用的 K 线 (过滤区间后), 供前端绘制价格图并标注每笔成交 */
  klines: Kline[];
}

/**
 * 全池逐笔成交 (合并所有标的, 按 日期 -> 标的 升序)。
 * 仅包含实际成交记录 (策略买卖 + 止损平仓), 未产生交易的标的不会出现。
 */
export interface PoolTradeLogRow {
  symbol: string;
  code: string;
  name?: string;
  date: string;
  type: 'BUY' | 'SELL';
  signalType: string;
  reason?: string;
  price: number;
  shares: number;
  value: number;
  fee: number;
  pnl?: number;
  pnlPercent?: number;
}

/** GET /api/backtest/pool/:id/trades 返回体 */
export interface PoolTradeLogView {
  /** 全部成交 (日期升序; 同日按标的代码升序) */
  trades: PoolTradeLogRow[];
  /** 总笔数 (== trades.length) */
  total: number;
}
