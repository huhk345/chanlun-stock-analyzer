import type { Kline, BacktestTrade, BacktestResult } from '../../src/types/stock.ts';
import type {
  BacktestStepperInput,
  BacktestStepper,
  BacktestStepState,
  BacktestDiagnostic,
  BacktestAccountState,
  BacktestPositionState,
  BacktestTradeSnapshot,
  RunBacktestOutput,
  UserStrategyInput,
  UserStrategyDecision,
} from '../../src/types/strategy.ts';
import { buildStrategyParams, validateDecision } from './strategyAdapter.ts';
import { computeIndicatorValues } from './indicatorValues.ts';
import {
  createInitialAccount,
  createInitialPosition,
  executeDecisionAtClose,
  executeProtectiveStop,
} from './backtestExecution.ts';
import { computeChanlunStructures } from '../../src/utils/chanlun.ts';
import { tradesToSnapshots, sharpeFromReturns } from './backtestUtils.ts';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function cloneAccount(a: BacktestAccountState): BacktestAccountState {
  return { ...a };
}

function clonePosition(p: BacktestPositionState): BacktestPositionState {
  return { ...p };
}

function cloneTrades(trades: BacktestTrade[]): BacktestTrade[] {
  return trades.map((t) => ({ ...t }));
}

function tradeToStepSnapshot(trade: BacktestTrade): BacktestTradeSnapshot {
  return {
    id: trade.id,
    date: trade.date,
    action: trade.type,
    price: trade.price,
    shares: trade.shares,
    value: trade.value,
    fee: trade.fee,
    reason: trade.reason ?? trade.signalType,
  };
}

// ---------------------------------------------------------------------------
// Saved state for backward navigation
// history[i] = 「处理第 i 根 K 线之前」的完整状态
// ---------------------------------------------------------------------------

interface SavedState {
  stepIndex: number;
  account: BacktestAccountState;
  position: BacktestPositionState;
  trades: BacktestTrade[];
  strategyStopped: boolean;
  consecutiveErrors: number;
  hasDecidedOnce: boolean;
  diagnostics: BacktestDiagnostic[];
  totalFees: number;
}

// ---------------------------------------------------------------------------
// Factory: createBacktestStepper
//
// 成交模型与 runBacktest 完全一致 (见 backtestExecution.ts 顶部说明):
//   1) 策略只用截止当根的数据决策, 并以【当根收盘价】成交 (尾盘/收盘竞价模型);
//   2) 涨停收盘无法按收盘价买 / 跌停收盘无法按收盘价卖;
//   3) 固定止损 = 盘中止损单 (跳空按开盘, 一字跌停顺延);
//   4) T+1: 当日买入当日不可卖 (盘中止损在当日买入成交之前执行)。
// 因此: 第 i 步展示的 decision 与 tradesExecuted 都是「当根收盘」这一时点的
// 决策与成交 (止损先于买入执行, tradesExecuted 可能同时含止损与买卖成交)。
// ---------------------------------------------------------------------------

export function createBacktestStepper(input: BacktestStepperInput): BacktestStepper {
  const {
    klines,
    symbol,
    userId,
    initialCash,
    currency,
    stopLossPercent,
    commissionRate = 0.00025,
    minCommission = 5,
    strategy,
    params: customParams,
    selectedIndicatorIds,
  } = input;

  // Build strategy params once
  const params = buildStrategyParams(strategy, customParams as Record<string, unknown> | undefined);

  // Load indicator definitions once (outside the loop) — 由调用方注入
  const loadedIndicators = input.indicators ?? [];
  const selectedIndicators = selectedIndicatorIds
    ? loadedIndicators.filter(d => selectedIndicatorIds.includes(d.id))
    : [];

  // Mutable internal state
  let history: SavedState[] = [];
  let currentIndex = -1;
  let account = createInitialAccount(initialCash, currency);
  let position = createInitialPosition();
  let trades: BacktestTrade[] = [];
  /** 策略连续异常达到该次数后才判定为「不可用」, 之前按 HOLD 降级继续跑 */
  const MAX_CONSECUTIVE_ERRORS = 5;
  let strategyStopped = false;
  let consecutiveErrors = 0;
  /** 是否已成功评估过至少一次 (用于区分「数据不足」与「策略真的坏了」) */
  let hasDecidedOnce = false;
  let diagnostics: BacktestDiagnostic[] = [];
  let totalFees = 0;
  let isStarted = false;

  // The last computed step state (returned by start/stepForward/etc.)
  let lastStepState: BacktestStepState | null = null;

  // -----------------------------------------------------------------------
  // 重置到初始状态
  // -----------------------------------------------------------------------

  function resetToInitialState(): void {
    account = createInitialAccount(initialCash, currency);
    position = createInitialPosition();
    trades = [];
    strategyStopped = false;
    consecutiveErrors = 0;
    hasDecidedOnce = false;
    diagnostics = [];
    totalFees = 0;
    lastStepState = null;
  }

  // -----------------------------------------------------------------------
  // Core: process one kline at the given index, return BacktestStepState
  // -----------------------------------------------------------------------

  function processStep(i: number): BacktestStepState {
    const currentKline = klines[i];
    const prevClose = i > 0 ? klines[i - 1].close : null;

    // Snapshot "before" state
    const accountBefore = cloneAccount(account);
    const positionBefore = clonePosition(position);

    let decision: UserStrategyDecision | null = null;
    const stepDiagnostics: BacktestDiagnostic[] = [];
    const tradesExecuted: BacktestTradeSnapshot[] = [];

    // --- 1) 固定止损 (盘中止损单) ---
    // 在当日买入成交之前执行, 结构上不会卖出当日买入的股份 → 天然满足 T+1
    if (stopLossPercent !== undefined && position.shares > 0) {
      const exec = executeProtectiveStop({
        bar: currentKline,
        prevClose,
        symbol,
        stopLossPercent,
        sellableShares: position.shares,
        account,
        position,
        commissionRate,
        minCommission,
      });
      account = exec.account;
      position = exec.position;
      totalFees += exec.fee;
      if (exec.trade) {
        trades.push(exec.trade);
        tradesExecuted.push(tradeToStepSnapshot(exec.trade));
      }
      stepDiagnostics.push(...exec.diagnostics);
    }

    // --- 2) 策略决策: 只用截止当根的数据; 决策以当根收盘价成交 ---
    const klinesSlice = klines.slice(0, i + 1);
    const strategyInput: UserStrategyInput = {
      symbol,
      timeframe: 'daily',
      klines: klinesSlice,
      currentIndex: i,
      currentKline,
      account,
      position,
      trades: tradesToSnapshots(trades),
      params,
      currency,
      initialCash,
    };

    // Provide ChanLun analysis data
    strategyInput.chanlun = computeChanlunStructures(klinesSlice);

    // Compute indicator values and merge into params
    const indicatorValues = computeIndicatorValues(selectedIndicators, symbol, klinesSlice, i);
    Object.assign(params, indicatorValues);

    // --- Call strategy ---
    if (!strategyStopped) {
      try {
        decision = strategy.decide(strategyInput);
        consecutiveErrors = 0;
        hasDecidedOnce = true;
      } catch (err) {
        // 单根 K 线异常只降级为 HOLD, 不中断整段回测 —— 否则该根之后的全部买卖信号都会丢失。
        // 尚未成功评估过 (多为样本不足导致) 时一律继续跑; 已经跑通后再连续异常才判定不可用。
        consecutiveErrors++;
        const msg = err instanceof Error ? err.message : String(err);
        if (hasDecidedOnce && consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          strategyStopped = true;
          stepDiagnostics.push({
            date: currentKline.date,
            level: 'error',
            message: `Strategy threw ${consecutiveErrors} consecutive errors, last: ${msg}. Strategy will no longer be called.`,
          });
        } else {
          stepDiagnostics.push({
            date: currentKline.date,
            level: 'warning',
            message: `Strategy error (treated as HOLD, 后续信号继续评估): ${msg}`,
          });
        }
        decision = { action: 'HOLD', reason: `策略异常按 HOLD 处理: ${msg}` };
      }
    }

    if (strategyStopped || decision === null) {
      decision = { action: 'HOLD' };
    }

    // --- Validate decision ---
    const validationErrors = validateDecision(decision);
    if (validationErrors.length > 0) {
      for (const errMsg of validationErrors) {
        stepDiagnostics.push({
          date: currentKline.date,
          level: 'warning',
          message: `Invalid decision: ${errMsg}`,
        });
      }
      decision = { action: 'HOLD' };
    }

    // --- 3) BUY / SELL → 以当根收盘价立即成交 (尾盘/收盘竞价模型) ---
    if (decision.action !== 'HOLD') {
      const exec = executeDecisionAtClose({
        decision,
        bar: currentKline,
        prevClose,
        symbol,
        account,
        position,
        commissionRate,
        minCommission,
        strategyLabel: strategy.id || strategy.name,
      });
      account = exec.account;
      position = exec.position;
      totalFees += exec.fee;
      if (exec.trade) {
        trades.push(exec.trade);
        tradesExecuted.push(tradeToStepSnapshot(exec.trade));
      }
      stepDiagnostics.push(...exec.diagnostics);
    }

    diagnostics.push(...stepDiagnostics);

    const accountAfter = cloneAccount(account);
    const positionAfter = clonePosition(position);

    return {
      currentStepIndex: i,
      totalSteps: klines.length,
      currentKline,
      decision,
      accountBefore,
      accountAfter,
      positionBefore,
      positionAfter,
      tradesExecuted,
      indicatorSnapshot: null,
      chanlunSnapshot: null,
      diagnostics: stepDiagnostics,
      isFinished: i === klines.length - 1,
    };
  }

  // -----------------------------------------------------------------------
  // Save / restore state for history navigation
  // -----------------------------------------------------------------------

  function saveState(stepIndex: number): SavedState {
    return {
      stepIndex,
      account: cloneAccount(account),
      position: clonePosition(position),
      trades: cloneTrades(trades),
      strategyStopped,
      consecutiveErrors,
      hasDecidedOnce,
      diagnostics: [...diagnostics],
      totalFees,
    };
  }

  function restoreState(saved: SavedState): void {
    currentIndex = saved.stepIndex;
    account = cloneAccount(saved.account);
    position = clonePosition(saved.position);
    trades = cloneTrades(saved.trades);
    strategyStopped = saved.strategyStopped;
    consecutiveErrors = saved.consecutiveErrors;
    hasDecidedOnce = saved.hasDecidedOnce;
    diagnostics = [...saved.diagnostics];
    totalFees = saved.totalFees;
  }

  // -----------------------------------------------------------------------
  // Build final BacktestResult from current state
  // -----------------------------------------------------------------------

  function buildResult(): BacktestResult {
    const lastPrice = klines.length > 0 ? klines[klines.length - 1].close : 0;
    const firstPrice = klines.length > 0 ? klines[0].close : 0;
    const finalPositionMarketValue = position.shares * lastPrice;
    const finalBalance = account.cash + finalPositionMarketValue;
    const totalReturnPercent = initialCash > 0 ? ((finalBalance - initialCash) / initialCash) * 100 : 0;
    const totalTrades = trades.length;
    const winningTrades = trades.filter((t) => t.type === 'SELL' && (t.pnl ?? 0) > 0).length;
    const totalSells = trades.filter((t) => t.type === 'SELL').length;
    const winRate = totalSells > 0 ? (winningTrades / totalSells) * 100 : 0;
    const buyHoldReturnPercent = firstPrice > 0 ? ((lastPrice - firstPrice) / firstPrice) * 100 : 0;

    const closedTrades = trades.filter(t => t.type === 'SELL' && t.pnlPercent !== undefined);
    const sharpeRatio = sharpeFromReturns(closedTrades.map(t => (t.pnlPercent ?? 0) / 100));

    return {
      id: `backtest-${Date.now()}`,
      userId,
      symbol,
      startDate: klines.length > 0 ? klines[0].date : '',
      endDate: klines.length > 0 ? klines[klines.length - 1].date : '',
      initialBalance: initialCash,
      finalBalance,
      totalReturnPercent,
      totalTrades,
      winningTrades,
      winRate,
      totalFees,
      sharpeRatio,
      buyHoldReturnPercent,
      maxDrawdownPercent: 0,
      trades: cloneTrades(trades),
      createdAt: new Date().toISOString(),
    };
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  const stepper: BacktestStepper = {
    get isStarted(): boolean {
      return isStarted;
    },

    start(): BacktestStepState {
      // (重新)开始: 回到初始状态
      resetToInitialState();
      history = [];
      isStarted = true;

      if (klines.length === 0) {
        currentIndex = -1;
        const emptyState: BacktestStepState = {
          currentStepIndex: -1,
          totalSteps: 0,
          currentKline: null as unknown as Kline,
          decision: null,
          accountBefore: cloneAccount(account),
          accountAfter: cloneAccount(account),
          positionBefore: clonePosition(position),
          positionAfter: clonePosition(position),
          tradesExecuted: [],
          indicatorSnapshot: null,
          chanlunSnapshot: null,
          diagnostics: [{ level: 'warning', message: 'No K-line data provided.' }],
          isFinished: true,
        };
        lastStepState = emptyState;
        return emptyState;
      }

      currentIndex = 0;
      // 第 0 步之前的状态 (用于回退)
      history[0] = saveState(0);

      const state = processStep(0);
      lastStepState = state;
      return state;
    },

    stepForward(): BacktestStepState {
      if (!isStarted) {
        return this.start();
      }

      if (currentIndex >= klines.length - 1) {
        // Already at the end
        return lastStepState!;
      }

      const nextIndex = currentIndex + 1;
      // 记录「处理第 nextIndex 根之前」的状态, 用于回退
      history[nextIndex] = saveState(nextIndex);
      currentIndex = nextIndex;

      const state = processStep(nextIndex);
      lastStepState = state;
      return state;
    },

    stepBackward(): BacktestStepState {
      const target = currentIndex - 1;
      if (!isStarted || target < 0 || !history[target]) {
        // No history to go back to
        return lastStepState!;
      }

      // history[target] = 处理第 target 根之前的状态; 恢复后重放该根, 得到该步界面状态
      restoreState(history[target]);
      currentIndex = target;
      const state = processStep(target);
      lastStepState = state;
      return state;
    },

    jumpTo(index: number): BacktestStepState {
      if (index < 0 || index >= klines.length) {
        return lastStepState!;
      }

      if (!isStarted) {
        this.start();
      }

      if (index === currentIndex) {
        return lastStepState!;
      }

      // 回退: 命中历史, 恢复后重放目标根
      if (index < currentIndex && history[index]) {
        restoreState(history[index]);
        currentIndex = index;
        const state = processStep(index);
        lastStepState = state;
        return state;
      }

      // 前进 (或历史缺失时兜底): 从头/当前位置重放到目标 index
      if (index < currentIndex) {
        resetToInitialState();
        history = [];
        currentIndex = -1;
      }

      for (let i = currentIndex + 1; i <= index; i++) {
        history[i] = saveState(i);
        currentIndex = i;
        lastStepState = processStep(i);
      }

      return lastStepState!;
    },

    runAll(): RunBacktestOutput {
      if (!isStarted) {
        this.start();
      }

      // Run remaining steps
      while (currentIndex < klines.length - 1) {
        const nextIndex = currentIndex + 1;
        history[nextIndex] = saveState(nextIndex);
        currentIndex = nextIndex;
        processStep(nextIndex);
      }

      const result = buildResult();
      return {
        result,
        diagnostics: [...diagnostics],
      };
    },

    getCurrentState(): BacktestStepState {
      if (!isStarted || lastStepState === null) {
        // Return a default empty state
        return {
          currentStepIndex: -1,
          totalSteps: klines.length,
          currentKline: null as unknown as Kline,
          decision: null,
          accountBefore: cloneAccount(account),
          accountAfter: cloneAccount(account),
          positionBefore: clonePosition(position),
          positionAfter: clonePosition(position),
          tradesExecuted: [],
          indicatorSnapshot: null,
          chanlunSnapshot: null,
          diagnostics: [],
          isFinished: false,
        };
      }
      return lastStepState;
    },

    /** 本次运行到当前步骤为止的全部成交 (克隆, 供页面展示全部成交账本) */
    getTrades(): BacktestTrade[] {
      return cloneTrades(trades);
    },
  };

  return stepper;
}
