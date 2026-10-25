import type { Kline, Stroke, Segment, Hub, Fraction, BacktestTrade } from './stock';

// ---------------------------------------------------------------------------
// Strategy timeframe & parameter types
// ---------------------------------------------------------------------------

type StrategyTimeframe = 'daily';

export type StrategyParamValue = string | number | boolean;

// ---------------------------------------------------------------------------
// Account, Position, and Trade Snapshot contracts
// ---------------------------------------------------------------------------

export interface BacktestAccountState {
  initialCash: number;
  cash: number;
  equity: number;
  currency: string;
}

export interface BacktestPositionState {
  shares: number;
  averageCost: number;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
}

export interface BacktestTradeSnapshot {
  id: string;
  date: string;
  action: 'BUY' | 'SELL';
  price: number;
  shares: number;
  value: number;
  fee?: number;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Indicator Cache contract
// ---------------------------------------------------------------------------

interface IndicatorCache {
  byId: Readonly<Record<string, IndicatorData>>;
}

interface IndicatorData {
  id: string;
  name: string;
  series: readonly IndicatorSeries[];
}

interface IndicatorSeries {
  id: string;
  name: string;
  type: 'line' | 'histogram';
  data: readonly IndicatorPoint[];
}

interface IndicatorPoint {
  time: string;
  value: number | null;
}

// ---------------------------------------------------------------------------
// ChanLun Cache contract
// ---------------------------------------------------------------------------

interface ChanLunCache {
  mergedKlines: readonly import('../types/stock').MergedKline[];
  fractions: readonly Fraction[];
  strokes: readonly Stroke[];
  segments: readonly Segment[];
  hubs: readonly Hub[];
}

// ---------------------------------------------------------------------------
// Strategy Input contract
// ---------------------------------------------------------------------------

export interface UserStrategyInput {
  symbol: string;
  timeframe: StrategyTimeframe;
  klines: readonly Kline[];
  currentIndex: number;
  currentKline: Kline;
  account: Readonly<BacktestAccountState>;
  position: Readonly<BacktestPositionState>;
  trades: readonly BacktestTradeSnapshot[];
  params: Readonly<Record<string, StrategyParamValue>>;
  indicators?: Readonly<IndicatorCache>;
  chanlun?: Readonly<ChanLunCache>;
  currency: string;
  initialCash: number;
}

// ---------------------------------------------------------------------------
// Strategy Decision contract
// ---------------------------------------------------------------------------

export type UserStrategyAction = 'BUY' | 'SELL' | 'HOLD';

export type UserStrategyAmountUnit = 'cash' | 'shares' | 'percent';

interface UserStrategyAmount {
  unit: UserStrategyAmountUnit;
  value: number;
}

export interface UserStrategyDecision {
  action: UserStrategyAction;
  amount?: UserStrategyAmount;
  reason?: string;
  confidence?: number;
  /**
   * 横截面吸引力分数 (越大越值得持有)。组合执行层用它比较「候选」与「已持仓」,
   * 决定是否轮动换仓; 同一天不同标的之间必须可比 (同一量纲)。
   */
  score?: number;
}

/**
 * 策略在某一根 K 线收盘时给出的可执行信号 (不含 HOLD)。
 * 组合模拟用它在 backtrader 中按当日收盘价撮合; price 为信号当根收盘价。
 */
export interface StrategySignalRecord {
  date: string;
  action: 'BUY' | 'SELL';
  reason?: string;
  confidence?: number;
  price: number;
}

/** 逐日吸引力分数 (含 HOLD 日), 供组合层做轮动比较 */
export interface StrategyScoreRecord {
  date: string;
  score: number;
}

// ---------------------------------------------------------------------------
// Strategy Function & Definition contracts
// ---------------------------------------------------------------------------

type UserStrategyFunction = (
  input: UserStrategyInput
) => UserStrategyDecision;

interface UserStrategyParamDefinition {
  key: string;
  label: string;
  type: 'number' | 'string' | 'boolean';
  defaultValue: StrategyParamValue;
  min?: number;
  max?: number;
  step?: number;
  /** type='string' 时给出可选项: 前端渲染为下拉, 避免手输拼写错误被静默回退到默认值 */
  options?: readonly string[];
}

interface AvailableIndicator {
  id: string;
  name: string;
  description?: string;
  defaultSelected?: boolean;
  params?: readonly UserStrategyParamDefinition[];
}

interface RequiredIndicator {
  id: string;
  params?: Readonly<Record<string, StrategyParamValue>>;
}

export interface UserStrategyDefinition {
  id: string;
  name: string;
  description?: string;
  defaultSelected?: boolean;
  params?: readonly UserStrategyParamDefinition[];
  availableIndicators?: readonly AvailableIndicator[];
  requiredIndicators?: readonly RequiredIndicator[];
  requiresChanLun?: boolean;
  decide: UserStrategyFunction;
}

// ---------------------------------------------------------------------------
// Backtest Runner contracts
// ---------------------------------------------------------------------------

/**
 * 增量续算种子: 复用一段已算好的前缀信号与末端状态, 引擎只对种子之后的
 * K 线重新调用策略。仅适用于「信号生成」场景 (recordSignals=true, 未启用
 * 引擎级止损), 且种子里的成交必须与原始运行完全一致, 否则策略看到的
 * 持仓/成交会漂移, 续算信号也会跟着变。
 */
export interface BacktestResumeSeed {
  /** 已复用的前缀 K 线根数 */
  barCount: number;
  /** 前缀区间的逐日买卖信号 (引擎直接并入输出) */
  signals: readonly StrategySignalRecord[];
  /** 前缀区间的逐日吸引力分数 */
  scores: readonly StrategyScoreRecord[];
  /** 前缀末端账户状态 */
  account: BacktestAccountState;
  /** 前缀末端持仓状态 */
  position: BacktestPositionState;
  /** 前缀区间已产生的成交 (策略会据此判断是否已减仓等) */
  trades: readonly BacktestTrade[];
}

export interface RunBacktestInput {
  klines: readonly Kline[];
  symbol: string;
  userId: string;
  initialCash: number;
  currency: string;
  stopLossPercent?: number;
  commissionRate?: number;   // 佣金费率 (e.g. 0.00025 for 万分之二点五)
  minCommission?: number;    // 最低佣金 per trade (default 5 CNY)
  strategy: UserStrategyDefinition;
  params?: Readonly<Record<string, unknown>>;
  selectedIndicatorIds?: readonly string[];
  /**
   * 指标定义 (由调用方注入, 引擎不读取任何本地存储)。
   * 服务端从请求携带的指标代码解析后传入; 不传等价于「没有自定义指标」。
   */
  indicators?: readonly import('./indicator').UserIndicatorDefinition[];
  /** 是否额外输出逐日 BUY/SELL 信号 (组合模拟使用), 默认 false */
  recordSignals?: boolean;
  /** 增量续算种子 (仅信号生成场景使用); 不传等价于从头计算 */
  resume?: BacktestResumeSeed;
}

export interface BacktestDiagnostic {
  date?: string;
  level: 'warning' | 'error';
  message: string;
}

export interface RunBacktestOutput {
  result: import('./stock').BacktestResult;
  diagnostics: readonly BacktestDiagnostic[];
  /** 每日收盘时的权益曲线 (用于绘制权益曲线图 / 计算回撤) */
  equityCurve?: number[];
  /** recordSignals=true 时输出, 只含 BUY/SELL */
  signals?: StrategySignalRecord[];
  /** recordSignals=true 且策略给出 score 时输出, 逐日一条 (含 HOLD 日) */
  dailyScores?: StrategyScoreRecord[];
  /** 记录到最后一根 K 线的引擎状态, 供下次增量续算使用 */
  finalState?: {
    account: BacktestAccountState;
    position: BacktestPositionState;
    trades: BacktestTrade[];
  };
}

// ---------------------------------------------------------------------------
// Indicator Selection UI contract
// ---------------------------------------------------------------------------

export interface IndicatorSelectionState {
  strategyId: string;
  selectedIndicatorIds: readonly string[];
  indicatorParams: Readonly<Record<string, Record<string, StrategyParamValue>>>;
}

// ---------------------------------------------------------------------------
// AI-Assisted Strategy Creation contracts
// ---------------------------------------------------------------------------

export interface StrategyDialogResponse {
  success: boolean;
  strategy?: UserStrategyDefinition;
  code?: string;
  explanation?: string;
  errors?: readonly string[];
  suggestions?: readonly string[];
  savedToStorage?: boolean;
  storageId?: string;
}

/** A single entry in the strategy chat history (prompt + generated code) */
export interface ChatEntry {
  id: string;
  /** The user's natural-language prompt */
  prompt: string;
  /** The generated code for this prompt */
  code: string;
  /** The AI model used */
  model?: string;
  /** Timestamp of this entry */
  createdAt: string;
}

export interface StoredStrategy {
  id: string;
  name: string;
  description?: string;
  code: string;
  /** The user's natural-language prompt that generated this strategy */
  prompt?: string;
  /** The AI model used for generation */
  model?: string;
  /** Chat history of all prompt→code generations for this strategy */
  chatHistory?: ChatEntry[];
  createdAt: string;
  updatedAt: string;
  defaultSelected?: boolean;
  params?: readonly UserStrategyParamDefinition[];
  availableIndicators?: readonly AvailableIndicator[];
  requiredIndicators?: readonly RequiredIndicator[];
  requiresChanLun?: boolean;
}

// ---------------------------------------------------------------------------
// Server strategy registry (GET /api/strategies)
// ---------------------------------------------------------------------------

/**
 * 服务端策略元数据 —— 不含 `decide` 函数 (策略代码只在服务端执行)。
 * 前端只用它渲染下拉框、参数表单与「查看源码」。
 */
export interface StrategySummary {
  id: string;
  name: string;
  description?: string;
  defaultSelected?: boolean;
  requiresChanLun?: boolean;
  params: readonly UserStrategyParamDefinition[];
  availableIndicators: readonly AvailableIndicator[];
  requiredIndicators: readonly RequiredIndicator[];
  /** 'builtin' = 仓库内置 (server/strategies), 'user' = 服务端保存的自建策略 */
  source: 'builtin' | 'user';
}

// ---------------------------------------------------------------------------
// Day-by-Day Backtest Stepping contracts
// ---------------------------------------------------------------------------

export interface BacktestStepState {
  currentStepIndex: number;
  totalSteps: number;
  currentKline: Kline;
  decision: UserStrategyDecision | null;
  accountBefore: BacktestAccountState;
  accountAfter: BacktestAccountState;
  positionBefore: BacktestPositionState;
  positionAfter: BacktestPositionState;
  /** 当根 K 线产生的全部成交 (盘中止损先行, 随后是 BUY/SELL 决策的成交) */
  tradesExecuted: BacktestTradeSnapshot[];
  indicatorSnapshot: Readonly<IndicatorCache> | null;
  chanlunSnapshot: Readonly<ChanLunCache> | null;
  diagnostics: readonly BacktestDiagnostic[];
  isFinished: boolean;
}

export interface BacktestStepperInput {
  klines: readonly Kline[];
  symbol: string;
  userId: string;
  initialCash: number;
  currency: string;
  stopLossPercent?: number;
  commissionRate?: number;   // 佣金费率 (e.g. 0.00025 for 万分之二点五)
  minCommission?: number;    // 最低佣金 per trade (default 5 CNY)
  strategy: UserStrategyDefinition;
  params?: Readonly<Record<string, unknown>>;
  selectedIndicatorIds?: readonly string[];
  /** 指标定义 (同 RunBacktestInput.indicators: 由调用方注入) */
  indicators?: readonly import('./indicator').UserIndicatorDefinition[];
}

export type BacktestStepper = {
  start(): BacktestStepState;
  stepForward(): BacktestStepState;
  stepBackward(): BacktestStepState;
  jumpTo(index: number): BacktestStepState;
  runAll(): RunBacktestOutput;
  getCurrentState(): BacktestStepState;
  /** 当前已成交的全部交易 (与批量回测 runBacktest 同一账本) */
  getTrades(): BacktestTrade[];
  isStarted: boolean;
};
