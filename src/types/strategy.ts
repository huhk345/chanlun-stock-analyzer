import type { Kline, Stroke, Segment, Hub, Fraction } from './stock';

// ---------------------------------------------------------------------------
// Strategy timeframe & parameter types
// ---------------------------------------------------------------------------

export type StrategyTimeframe = 'daily';

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

export interface IndicatorCache {
  byId: Readonly<Record<string, IndicatorData>>;
}

export interface IndicatorData {
  id: string;
  name: string;
  series: readonly IndicatorSeries[];
}

export interface IndicatorSeries {
  id: string;
  name: string;
  type: 'line' | 'histogram';
  data: readonly IndicatorPoint[];
}

export interface IndicatorPoint {
  time: string;
  value: number | null;
}

// ---------------------------------------------------------------------------
// ChanLun Cache contract
// ---------------------------------------------------------------------------

export interface ChanLunCache {
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

export interface UserStrategyAmount {
  unit: UserStrategyAmountUnit;
  value: number;
}

export interface UserStrategyDecision {
  action: UserStrategyAction;
  amount?: UserStrategyAmount;
  reason?: string;
  confidence?: number;
}

// ---------------------------------------------------------------------------
// Strategy Function & Definition contracts
// ---------------------------------------------------------------------------

export type UserStrategyFunction = (
  input: UserStrategyInput
) => UserStrategyDecision;

export interface UserStrategyParamDefinition {
  key: string;
  label: string;
  type: 'number' | 'string' | 'boolean';
  defaultValue: StrategyParamValue;
  min?: number;
  max?: number;
  step?: number;
}

export interface AvailableIndicator {
  id: string;
  name: string;
  description?: string;
  defaultSelected?: boolean;
  params?: readonly UserStrategyParamDefinition[];
}

export interface RequiredIndicator {
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
}

export interface BacktestDiagnostic {
  date?: string;
  level: 'warning' | 'error';
  message: string;
}

export interface RunBacktestOutput {
  result: import('./stock').BacktestResult;
  diagnostics: readonly BacktestDiagnostic[];
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

export interface StrategyDialogRequest {
  userDescription: string;
  context?: {
    symbol?: string;
    existingStrategyIds?: readonly string[];
    availableIndicatorIds?: readonly string[];
  };
}

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

export interface StoredStrategy {
  id: string;
  name: string;
  description?: string;
  code: string;
  createdAt: string;
  updatedAt: string;
  defaultSelected?: boolean;
  params?: readonly UserStrategyParamDefinition[];
  availableIndicators?: readonly AvailableIndicator[];
  requiredIndicators?: readonly RequiredIndicator[];
  requiresChanLun?: boolean;
}

export interface StrategyStorageData {
  version: number;
  strategies: StoredStrategy[];
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
  tradeExecuted: BacktestTradeSnapshot | null;
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
}

export type BacktestStepper = {
  start(): BacktestStepState;
  stepForward(): BacktestStepState;
  stepBackward(): BacktestStepState;
  jumpTo(index: number): BacktestStepState;
  runAll(): RunBacktestOutput;
  getCurrentState(): BacktestStepState;
  isStarted: boolean;
};
