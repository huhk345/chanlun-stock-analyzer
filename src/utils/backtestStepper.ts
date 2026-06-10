import type { Kline, BacktestTrade, BacktestResult } from '../types/stock';
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
} from '../types/strategy';
import { buildStrategyParams, validateDecision, resolveOrderShares, calcAStockFees, isLimitUp, isLimitDown } from './strategyAdapter';
import {
  createInitialAccount,
  createInitialPosition,
  updateAccountAfterTrade,
  updatePositionAfterBuy,
  updatePositionAfterSell,
} from './backtestRunner';
import { mergeKlines, findFractions, calculateStrokes, calculateSegments, calculateHubs } from './chanlun';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

let tradeCounter = 0;
function nextTradeId(): string {
  tradeCounter++;
  return `trade-${Date.now()}-${tradeCounter}`;
}

function buildChanLunCache(klines: readonly Kline[]) {
  const mutableKlines = [...klines];
  const merged = mergeKlines(mutableKlines);
  const fractions = findFractions(merged, mutableKlines);
  const strokes = calculateStrokes(fractions);
  const segments = calculateSegments(strokes);
  const hubs = calculateHubs(strokes);
  return { mergedKlines: merged, fractions, strokes, segments, hubs };
}

function tradesToSnapshots(trades: BacktestTrade[]): BacktestTradeSnapshot[] {
  return trades.map((t) => ({
    id: t.id,
    date: t.date,
    action: t.type,
    price: t.price,
    shares: t.shares,
    value: t.value,
    fee: t.fee,
    reason: t.signalType,
  }));
}

function cloneAccount(a: BacktestAccountState): BacktestAccountState {
  return { ...a };
}

function clonePosition(p: BacktestPositionState): BacktestPositionState {
  return { ...p };
}

function cloneTrades(trades: BacktestTrade[]): BacktestTrade[] {
  return trades.map((t) => ({ ...t }));
}

// ---------------------------------------------------------------------------
// Saved state for backward navigation
// ---------------------------------------------------------------------------

interface SavedState {
  stepIndex: number;
  account: BacktestAccountState;
  position: BacktestPositionState;
  trades: BacktestTrade[];
  strategyStopped: boolean;
  diagnostics: BacktestDiagnostic[];
  totalFees: number;
}

// ---------------------------------------------------------------------------
// Factory: createBacktestStepper
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
  } = input;

  // Build strategy params once
  const params = buildStrategyParams(strategy, customParams as Record<string, unknown> | undefined);

  // Mutable internal state
  let history: SavedState[] = [];
  let currentIndex = -1;
  let account = createInitialAccount(initialCash, currency);
  let position = createInitialPosition();
  let trades: BacktestTrade[] = [];
  let strategyStopped = false;
  let diagnostics: BacktestDiagnostic[] = [];
  let totalFees = 0;
  let isStarted = false;

  // The last computed step state (returned by start/stepForward/etc.)
  let lastStepState: BacktestStepState | null = null;

  // -----------------------------------------------------------------------
  // Core: process one kline at the given index, return BacktestStepState
  // -----------------------------------------------------------------------

  function processStep(i: number): BacktestStepState {
    const currentKline = klines[i];
    const currentPrice = currentKline.close;

    // Snapshot "before" state
    const accountBefore = cloneAccount(account);
    const positionBefore = clonePosition(position);

    let decision: UserStrategyDecision | null = null;
    const stepDiagnostics: BacktestDiagnostic[] = [];
    let tradeExecuted: BacktestTradeSnapshot | null = null;

    // --- Stop-loss check ---
    let stopLossTriggered = false;
    if (stopLossPercent !== undefined && position.shares > 0) {
      const stopPrice = position.averageCost * (1 - stopLossPercent / 100);
      if (currentPrice < stopPrice) {
        stopLossTriggered = true;
        const sellShares = position.shares;
        const sellValue = sellShares * currentPrice;
        const fee = calcAStockFees(sellValue, false, commissionRate, minCommission);
        totalFees += fee;
        const { position: newPosition, realizedPnl } = updatePositionAfterSell(position, sellShares, currentPrice);
        account = { ...account, cash: account.cash + sellValue - fee };
        account = updateAccountAfterTrade(account, newPosition, currentPrice);
        position = newPosition;

        const pnlPercent = position.averageCost > 0
          ? (realizedPnl / (sellShares * position.averageCost)) * 100
          : 0;

        const trade: BacktestTrade = {
          id: nextTradeId(),
          type: 'SELL',
          signalType: 'stop-loss',
          price: currentPrice,
          date: currentKline.date,
          shares: sellShares,
          value: sellValue,
          fee,
          pnl: realizedPnl,
          pnlPercent,
        };
        trades.push(trade);
        tradeExecuted = {
          id: trade.id,
          date: trade.date,
          action: trade.type,
          price: trade.price,
          shares: trade.shares,
          value: trade.value,
          reason: trade.signalType,
        };

        stepDiagnostics.push({
          date: currentKline.date,
          level: 'warning',
          message: `Stop-loss triggered at ${currentPrice.toFixed(2)} (threshold ${stopPrice.toFixed(2)})`,
        });

        diagnostics.push(...stepDiagnostics);

        const accountAfter = cloneAccount(account);
        const positionAfter = clonePosition(position);

        return {
          currentStepIndex: i,
          totalSteps: klines.length,
          currentKline,
          decision: { action: 'SELL', reason: 'stop-loss' },
          accountBefore,
          accountAfter,
          positionBefore,
          positionAfter,
          tradeExecuted,
          indicatorSnapshot: null,
          chanlunSnapshot: null,
          diagnostics: stepDiagnostics,
          isFinished: i === klines.length - 1,
        };
      }
    }

    // --- Build strategy input ---
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

    if (strategy.requiresChanLun) {
      strategyInput.chanlun = buildChanLunCache(klinesSlice);
    }

    // --- Call strategy ---
    if (!strategyStopped) {
      try {
        decision = strategy.decide(strategyInput);
      } catch (err) {
        strategyStopped = true;
        const msg = err instanceof Error ? err.message : String(err);
        stepDiagnostics.push({
          date: currentKline.date,
          level: 'error',
          message: `Strategy threw an error: ${msg}. Strategy will no longer be called.`,
        });
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

    // --- Execute decision ---
    if (decision.action !== 'HOLD') {
      const { shares, warnings } = resolveOrderShares(decision, account, position, currentPrice);

      for (const w of warnings) {
        stepDiagnostics.push({ date: currentKline.date, level: 'warning', message: w });
      }

      if (shares > 0) {
        // --- Limit up/down checks ---
        if (decision.action === 'BUY' && isLimitUp(currentKline, klines, symbol)) {
          stepDiagnostics.push({
            date: currentKline.date,
            level: 'warning',
            message: `Buy blocked: stock is at 涨停 (limit-up) at ${currentPrice.toFixed(2)}`,
          });
        } else if (decision.action === 'SELL' && isLimitDown(currentKline, klines, symbol)) {
          stepDiagnostics.push({
            date: currentKline.date,
            level: 'warning',
            message: `Sell blocked: stock is at 跌停 (limit-down) at ${currentPrice.toFixed(2)}`,
          });
        } else if (decision.action === 'BUY') {
          const cost = shares * currentPrice;
          if (cost <= account.cash) {
            const fee = calcAStockFees(cost, true, commissionRate, minCommission);
            totalFees += fee;

            position = updatePositionAfterBuy(position, shares, currentPrice);
            account = { ...account, cash: account.cash - cost - fee };
            account = updateAccountAfterTrade(account, position, currentPrice);

            const trade: BacktestTrade = {
              id: nextTradeId(),
              type: 'BUY',
              signalType: strategy.id || strategy.name,
              price: currentPrice,
              date: currentKline.date,
              shares,
              value: cost,
              fee,
            };
            trades.push(trade);
            tradeExecuted = {
              id: trade.id,
              date: trade.date,
              action: trade.type,
              price: trade.price,
              shares: trade.shares,
              value: trade.value,
              fee: trade.fee,
              reason: trade.signalType,
            };
          }
        } else if (decision.action === 'SELL') {
          const sellShares = Math.min(shares, position.shares);
          if (sellShares > 0) {
            const sellValue = sellShares * currentPrice;
            const fee = calcAStockFees(sellValue, false, commissionRate, minCommission);
            totalFees += fee;

            const { position: newPosition, realizedPnl } = updatePositionAfterSell(position, sellShares, currentPrice);
            account = { ...account, cash: account.cash + sellValue - fee };
            account = updateAccountAfterTrade(account, newPosition, currentPrice);
            position = newPosition;

            const pnlPercent = position.averageCost > 0
              ? (realizedPnl / (sellShares * position.averageCost)) * 100
              : 0;

            const trade: BacktestTrade = {
              id: nextTradeId(),
              type: 'SELL',
              signalType: strategy.id || strategy.name,
              price: currentPrice,
              date: currentKline.date,
              shares: sellShares,
              value: sellValue,
              fee,
              pnl: realizedPnl,
              pnlPercent,
            };
            trades.push(trade);
            tradeExecuted = {
              id: trade.id,
              date: trade.date,
              action: trade.type,
              price: trade.price,
              shares: trade.shares,
              value: trade.value,
              fee: trade.fee,
              reason: trade.signalType,
            };
          }
        }
      }
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
      tradeExecuted,
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

    let sharpeRatio = 0;
    const closedTrades = trades.filter(t => t.type === 'SELL' && t.pnlPercent !== undefined);
    if (closedTrades.length > 1) {
      const returns = closedTrades.map(t => (t.pnlPercent ?? 0) / 100);
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
      const std = Math.sqrt(variance);
      sharpeRatio = std > 0 ? (mean / std) * Math.sqrt(252) : 0;
    }

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
      if (klines.length === 0) {
        isStarted = true;
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
          tradeExecuted: null,
          indicatorSnapshot: null,
          chanlunSnapshot: null,
          diagnostics: [{ level: 'warning', message: 'No K-line data provided.' }],
          isFinished: true,
        };
        lastStepState = emptyState;
        return emptyState;
      }

      // Save initial state for potential backward navigation
      history = [];
      currentIndex = 0;
      isStarted = true;

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

      // Save current state before advancing
      history.push(saveState(currentIndex));
      currentIndex++;

      const state = processStep(currentIndex);
      lastStepState = state;
      return state;
    },

    stepBackward(): BacktestStepState {
      if (history.length === 0) {
        // No history to go back to
        return lastStepState!;
      }

      const saved = history.pop()!;
      restoreState(saved);
      currentIndex = saved.stepIndex;

      // Re-process the step to get the step state (without re-executing trades,
      // since we restored the state before the step)
      // Actually, we need to return the step state for the current index.
      // The saved state is the state *before* the step at saved.stepIndex was processed.
      // After restoring, we are at the state before step saved.stepIndex was processed,
      // but currentIndex is set to saved.stepIndex.
      // We need to re-process this step to get the BacktestStepState.
      const state = processStep(currentIndex);
      lastStepState = state;
      return state;
    },

    jumpTo(index: number): BacktestStepState {
      if (index < 0 || index >= klines.length) {
        return lastStepState!;
      }

      // Check if we have this exact index in history
      const historyIdx = history.findIndex((s) => s.stepIndex === index);
      if (historyIdx !== -1) {
        // Restore from history — the saved state at historyIdx is the state
        // *before* step index was processed. Discard any history after it.
        const saved = history[historyIdx];
        // Remove all entries after historyIdx (they represent later steps)
        history = history.slice(0, historyIdx);
        restoreState(saved);
        currentIndex = index;
        const state = processStep(currentIndex);
        lastStepState = state;
        return state;
      }

      // Not in history — replay from beginning
      account = createInitialAccount(initialCash, currency);
      position = createInitialPosition();
      trades = [];
      strategyStopped = false;
      diagnostics = [];
      history = [];
      currentIndex = -1;
      isStarted = true;

      // Replay up to and including the target index
      for (let i = 0; i <= index; i++) {
        if (i < index) {
          // Save state before each intermediate step
          history.push(saveState(i));
        }
        currentIndex = i;
        processStep(i);
      }

      // Now re-process the target step to get the BacktestStepState
      // (processStep already ran it above, but we need the return value)
      // Restore to state just before target index
      const preTargetState = saveState(index);
      // Actually, we need to save the state *before* the target step.
      // Let's redo this more carefully.

      // Reset and replay again, this time capturing the step state
      account = createInitialAccount(initialCash, currency);
      position = createInitialPosition();
      trades = [];
      strategyStopped = false;
      diagnostics = [];
      history = [];

      for (let i = 0; i < index; i++) {
        history.push(saveState(i));
        currentIndex = i;
        processStep(i);
      }

      currentIndex = index;
      const state = processStep(index);
      lastStepState = state;
      return state;
    },

    runAll(): RunBacktestOutput {
      if (!isStarted) {
        this.start();
      }

      // Run remaining steps
      while (currentIndex < klines.length - 1) {
        history.push(saveState(currentIndex));
        currentIndex++;
        processStep(currentIndex);
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
          tradeExecuted: null,
          indicatorSnapshot: null,
          chanlunSnapshot: null,
          diagnostics: [],
          isFinished: false,
        };
      }
      return lastStepState;
    },
  };

  return stepper;
}
