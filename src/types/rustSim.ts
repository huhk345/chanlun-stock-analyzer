/**
 * Rust 逐日模拟 —— 前端契约。
 *
 * 引擎在 Rust 服务 (barter-rs) 里跑, 浏览器只发一次请求拿回整段录制,
 * 之后前进 / 后退 / 拖动都是本地索引查找。
 */

export interface RustParamSpec {
  key: string;
  label: string;
  kind: 'number' | 'string' | 'boolean';
  default: number | string | boolean;
  min?: number;
  max?: number;
  step?: number;
}

export interface RustStrategy {
  id: string;
  name: string;
  description: string;
  params: RustParamSpec[];
}

export interface RustPool {
  id: string;
  label: string;
  size: number;
}

export interface RustDecision {
  symbol: string;
  action: 'BUY' | 'SELL';
  amount_unit: 'cash' | 'shares' | 'percent' | null;
  amount_value: number | null;
  reason: string | null;
  close: number;
  score: number | null;
  filled_shares: number;
  fill_price: number | null;
  fee: number;
  rejected: string | null;
}

export interface RustTrade {
  date: string;
  symbol: string;
  action: 'BUY' | 'SELL';
  price: number;
  shares: number;
  value: number;
  fee: number;
  pnl: number | null;
  reason: string | null;
}

/** 当日收盘后的持仓快照 (引擎逐日录制) */
export interface RustHolding {
  symbol: string;
  shares: number;
  /** 加权平均成本 (含买入费用) */
  avg_cost: number;
  /** 当日收盘价 */
  close: number;
  value: number;
  /** 浮动盈亏 (close - avg_cost) * shares */
  pnl: number;
  pnl_percent: number;
  /** 建仓日, 老仓位可能为空 */
  opened_on: string | null;
}

export interface RustDay {
  index: number;
  date: string;
  equity: number;
  cash: number;
  position_value: number;
  positions: number;
  /** 当日有 K 线的标的数 (= 策略被调用的次数) */
  evaluated: number;
  buys: number;
  sells: number;
  holds: number;
  trades: number;
  decisions: RustDecision[];
  /** 当日收盘后的持仓明细 (按市值降序) */
  holdings: RustHolding[];
}

/** 单只标的的日线（GET /api/rust/kline/:symbol） */
export interface RustKlineBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
}

export interface RustSymbolRow {
  symbol: string;
  buy_hold_percent: number;
  realized_pnl: number;
  trades: number;
  win_rate: number;
  max_drawdown: number;
  fees: number;
  last_close: number;
  days: number;
  /** barter 自己的 PositionManager 在期末报告的持仓股数 */
  framework_shares: number;
}

export interface RustMetrics {
  initial_cash: number;
  final_equity: number;
  total_return_percent: number;
  buy_hold_return_percent: number;
  excess_return_percent: number;
  annualized_percent: number;
  max_drawdown_percent: number;
  sharpe: number;
  volatility_percent: number;
  trades: number;
  win_rate_percent: number;
  profit_factor: number;
  total_fees: number;
  exposure_percent: number;
  trading_days: number;
}

/** 模拟前自动更新数据的结果 (POST /api/rust/sim 的 refresh 字段) */
export interface RustAutoRefresh {
  checked: number;
  refreshed: number;
  appended: number;
  rebased: number;
  failed: number;
  skipped: boolean;
  reason: string | null;
  rebased_symbols: string[];
  errors: string[];
  elapsed_ms: number;
}

export interface RustSimResult {
  run_id: string;
  framework: string;
  strategy_id: string;
  strategy_name: string;
  pools: string[];
  start: string;
  end: string;
  universe: number;
  /** 按「可交易范围」从股票池里剔除的标的数 */
  filtered_out?: number;
  /** 当前资金在「典型一手成本」下能持有的标的数 */
  max_positions: number;
  /** 等权仓位上限 (资金 ÷ max_positions) */
  slot_cash: number;
  /** 每次开仓的金额下限 (0 = 关闭该规则) */
  min_position_value: number;
  tested: number;
  missing: string[];
  metrics: RustMetrics;
  equity: number[];
  /** 等权买入持有基准曲线 (与 equity 同日对齐) */
  bh_equity: number[];
  equity_dates: string[];
  days: RustDay[];
  trades: RustTrade[];
  symbols: RustSymbolRow[];
  elapsed_ms: number;
  /** 本次模拟前自动更新数据的结果 */
  refresh?: RustAutoRefresh;
}

/** 池数据覆盖情况 (GET /api/rust/pool/coverage) */
export interface RustPoolCoverage {
  id: string;
  label: string;
  size: number;
  cached: number;
  missing: number;
  /** 历史起点晚于分析窗口的标的数 (新股上市或数据被截断) */
  incomplete: number;
  first: string | null;
  last: string | null;
}

export type RustUpdateOutcome = 'appended' | 'rebased' | 'unchanged' | 'failed';

export interface RustSymbolUpdate {
  symbol: string;
  outcome: RustUpdateOutcome;
  added: number;
  bars: number;
  note: string | null;
}

export interface RustUpdateProgress {
  id: string;
  state: 'running' | 'done' | 'failed';
  total: number;
  done: number;
  /** 增量追加的标的数 */
  appended: number;
  /** 触发全量刷新 (除权 / 复权基准变化 / 首次缓存) 的标的数 */
  rebased: number;
  unchanged: number;
  failed: number;
  current: string | null;
  started_at: number;
  finished_at: number | null;
  elapsed_ms: number;
  rebased_symbols: string[];
  errors: string[];
  results: RustSymbolUpdate[];
}

export interface RustSimInput {
  strategyId: string;
  params?: Record<string, unknown>;
  pools: string[];
  custom?: string[];
  start?: string;
  end?: string;
  limit?: number;
  initialCash?: number;
  commissionRate?: number;
  minCommission?: number;
  stampDutyRate?: number;
  transferFeeRate?: number;
  lotSize?: number;
  /** 每次开仓的金额下限, 默认 5000 */
  minPositionValue?: number;
  /** 从股票池里剔除的板块 ('chinext' | 'star' | 'bse'); ST/退市 由引擎恒定剔除 */
  excludeBoards?: string[];
  tPlus1?: boolean;
  stopLossPercent?: number;
}
