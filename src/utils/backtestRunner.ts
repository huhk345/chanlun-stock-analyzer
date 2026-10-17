import type { Kline, BacktestTrade, BacktestResult } from '../types/stock';
import type {
  RunBacktestInput,
  RunBacktestOutput,
  BacktestDiagnostic,
  BacktestAccountState,
  BacktestPositionState,
  UserStrategyInput,
  UserStrategyDecision,
} from '../types/strategy';
import { buildStrategyParams, validateDecision, resolveOrderShares, calcAStockFees, isLimitUp, isLimitDown } from './strategyAdapter';
import { computeIndicatorValues } from './indicatorAdapter';
import { loadStoredIndicators } from './indicatorLoader';
import { computeChanlunStructures } from './chanlun';
import {
  nextTradeId,
  tradesToSnapshots,
  sharpeFromEquityCurve,
  maxDrawdownFromEquityCurve,
} from './backtestUtils';

// ---------------------------------------------------------------------------
// Helper: create initial account state
// ---------------------------------------------------------------------------

export function createInitialAccount(initialCash: number, currency: string): BacktestAccountState {
  return {
    initialCash,
    cash: initialCash,
    equity: initialCash,
    currency,
  };
}

// ---------------------------------------------------------------------------
// Helper: create initial position state
// ---------------------------------------------------------------------------

export function createInitialPosition(): BacktestPositionState {
  return {
    shares: 0,
    averageCost: 0,
    marketValue: 0,
    unrealizedPnl: 0,
    unrealizedPnlPercent: 0,
  };
}

// ---------------------------------------------------------------------------
// Helper: update account equity after a trade
// ---------------------------------------------------------------------------

export function updateAccountAfterTrade(
  account: BacktestAccountState,
  position: BacktestPositionState,
  currentPrice: number,
): BacktestAccountState {
  const marketValue = position.shares * currentPrice;
  const equity = account.cash + marketValue;
  return {
    ...account,
    equity,
  };
}

// ---------------------------------------------------------------------------
// Helper: update position after a BUY
// ---------------------------------------------------------------------------

export function updatePositionAfterBuy(
  position: BacktestPositionState,
  shares: number,
  price: number,
): BacktestPositionState {
  const totalCost = position.averageCost * position.shares + price * shares;
  const totalShares = position.shares + shares;
  const averageCost = totalShares > 0 ? totalCost / totalShares : 0;
  const marketValue = totalShares * price;
  const unrealizedPnl = marketValue - totalCost;
  const unrealizedPnlPercent = totalCost > 0 ? (unrealizedPnl / totalCost) * 100 : 0;

  return {
    shares: totalShares,
    averageCost,
    marketValue,
    unrealizedPnl,
    unrealizedPnlPercent,
  };
}

// ---------------------------------------------------------------------------
// Helper: update position after a SELL
// ---------------------------------------------------------------------------

export function updatePositionAfterSell(
  position: BacktestPositionState,
  shares: number,
  price: number,
): { position: BacktestPositionState; realizedPnl: number } {
  const sellValue = shares * price;
  const costBasis = shares * position.averageCost;
  const realizedPnl = sellValue - costBasis;

  const remainingShares = position.shares - shares;
  const marketValue = remainingShares * price;
  const remainingCost = remainingShares * position.averageCost;
  const unrealizedPnl = marketValue - remainingCost;
  const unrealizedPnlPercent = remainingCost > 0 ? (unrealizedPnl / remainingCost) * 100 : 0;

  return {
    position: {
      shares: remainingShares,
      averageCost: position.averageCost,
      marketValue,
      unrealizedPnl,
      unrealizedPnlPercent,
    },
    realizedPnl,
  };
}

// ---------------------------------------------------------------------------
// Main: runBacktest
// ---------------------------------------------------------------------------

export function runBacktest(input: RunBacktestInput): RunBacktestOutput {
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

  const diagnostics: BacktestDiagnostic[] = [];

  // Empty klines → no-trade result
  if (klines.length === 0) {
    diagnostics.push({ level: 'warning', message: 'No K-line data provided; backtest produced no trades.' });
    const now = new Date().toISOString();
    return {
      result: {
        id: `backtest-${Date.now()}`,
        userId,
        symbol,
        startDate: '',
        endDate: '',
        initialBalance: initialCash,
        finalBalance: initialCash,
        totalReturnPercent: 0,
        totalTrades: 0,
        winningTrades: 0,
        winRate: 0,
        totalFees: 0,
        sharpeRatio: 0,
        buyHoldReturnPercent: 0,
        maxDrawdownPercent: 0,
        trades: [],
        createdAt: now,
      },
      diagnostics,
    };
  }

  // Build strategy params
  const params = buildStrategyParams(strategy, customParams as Record<string, unknown> | undefined);

  // Load indicator definitions once (outside the loop)
  const loadedIndicators = loadStoredIndicators();
  const selectedIndicators = selectedIndicatorIds
    ? loadedIndicators.filter(d => selectedIndicatorIds.includes(d.id))
    : [];

  // Initialise state
  let account = createInitialAccount(initialCash, currency);
  let position = createInitialPosition();
  const trades: BacktestTrade[] = [];
  /** 策略连续异常达到该次数后才判定为「不可用」, 之前按 HOLD 降级继续跑 */
  const MAX_CONSECUTIVE_ERRORS = 5;
  let strategyStopped = false;
  let consecutiveErrors = 0;
  /** 是否已成功评估过至少一次 (用于区分「数据不足」与「策略真的坏了」) */
  let hasDecidedOnce = false;
  let totalErrorDiagnostics = 0;
  let totalFees = 0;

  // Track daily equity for Sharpe ratio
  const equityCurve: number[] = [];

  // Iterate from oldest (index 0) to newest
  for (let i = 0; i < klines.length; i++) {
    const currentKline = klines[i];
    const currentPrice = currentKline.close;

    // Record equity at this step
    const currentEquity = account.cash + position.shares * currentPrice;
    equityCurve.push(currentEquity);

    // --- Stop-loss check (before strategy decision) ---
    if (stopLossPercent !== undefined && position.shares > 0) {
      const stopPrice = position.averageCost * (1 - stopLossPercent / 100);
      if (currentPrice < stopPrice) {
        // Force sell all shares
        const sellShares = position.shares;
        const sellValue = sellShares * currentPrice;
        const { position: newPosition, realizedPnl } = updatePositionAfterSell(position, sellShares, currentPrice);
        account = { ...account, cash: account.cash + sellValue };
        account = updateAccountAfterTrade(account, newPosition, currentPrice);
        position = newPosition;

        const pnlPercent = position.averageCost > 0
          ? (realizedPnl / (sellShares * position.averageCost)) * 100
          : 0;

        trades.push({
          id: nextTradeId(),
          type: 'SELL',
          signalType: 'stop-loss',
          reason: `触发固定止损 ${stopLossPercent}%`,
          price: currentPrice,
          date: currentKline.date,
          shares: sellShares,
          value: sellValue,
          pnl: realizedPnl,
          pnlPercent,
        });

        diagnostics.push({
          date: currentKline.date,
          level: 'warning',
          message: `Stop-loss triggered at ${currentPrice.toFixed(2)} (threshold ${stopPrice.toFixed(2)})`,
        });

        // Continue to next kline after stop-loss
        continue;
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

    // Provide ChanLun analysis data
    strategyInput.chanlun = computeChanlunStructures(klinesSlice);

    // Compute indicator values and merge into params
    const indicatorValues = computeIndicatorValues(selectedIndicators, symbol, klinesSlice, i);
    Object.assign(params, indicatorValues);

    // --- Call strategy ---
    let decision: UserStrategyDecision | null = null;

    if (!strategyStopped) {
      try {
        decision = strategy.decide(strategyInput);
        consecutiveErrors = 0;
        hasDecidedOnce = true;
      } catch (err) {
        // 单根 K 线异常只降级为 HOLD, 不中断整段回测 —— 否则该根之后的全部买卖信号都会丢失。
        // 尚未成功评估过 (多为样本不足导致) 时一律继续跑, 只记一条汇总诊断;
        // 已经跑通之后再连续异常, 才判定策略不可用。
        consecutiveErrors++;
        const msg = err instanceof Error ? err.message : String(err);
        const fatal = hasDecidedOnce && consecutiveErrors >= MAX_CONSECUTIVE_ERRORS;
        if (fatal) {
          strategyStopped = true;
          diagnostics.push({
            date: currentKline.date,
            level: 'error',
            message: `Strategy threw ${consecutiveErrors} consecutive errors after ${klines.length} bars, last: ${msg}. Strategy will no longer be called.`,
          });
        } else if (totalErrorDiagnostics < 3) {
          // 只保留前几条样本异常诊断, 避免刷屏; 其余静默降级
          totalErrorDiagnostics++;
          diagnostics.push({
            date: currentKline.date,
            level: 'warning',
            message: `Strategy error (treated as HOLD, 后续信号继续评估): ${msg}`,
          });
        }
        decision = { action: 'HOLD', reason: `策略异常按 HOLD 处理: ${msg}` };
      }
    }

    // If strategy is stopped, treat as HOLD
    if (strategyStopped) {
      decision = { action: 'HOLD' };
    }

    if (!decision) {
      decision = { action: 'HOLD' };
    }

    // --- Validate decision ---
    const validationErrors = validateDecision(decision);
    if (validationErrors.length > 0) {
      for (const errMsg of validationErrors) {
        diagnostics.push({
          date: currentKline.date,
          level: 'warning',
          message: `Invalid decision: ${errMsg}`,
        });
      }
      // Skip execution for invalid decision
      continue;
    }

    // --- HOLD → nothing to do ---
    if (decision.action === 'HOLD') {
      continue;
    }

    // --- BUY or SELL ---
    const { shares, actualValue, warnings } = resolveOrderShares(
      decision,
      account,
      position,
      currentPrice,
    );

    for (const w of warnings) {
      diagnostics.push({ date: currentKline.date, level: 'warning', message: w });
    }

    if (shares <= 0) {
      continue;
    }

    // --- Limit up/down checks ---
    if (decision.action === 'BUY' && isLimitUp(currentKline, klines, symbol)) {
      diagnostics.push({
        date: currentKline.date,
        level: 'warning',
        message: `Buy blocked: stock is at 涨停 (limit-up) at ${currentPrice.toFixed(2)}`,
      });
      continue;
    }

    if (decision.action === 'SELL' && isLimitDown(currentKline, klines, symbol)) {
      diagnostics.push({
        date: currentKline.date,
        level: 'warning',
        message: `Sell blocked: stock is at 跌停 (limit-down) at ${currentPrice.toFixed(2)}`,
      });
      continue;
    }

    // Execute fill at current close price
    if (decision.action === 'BUY') {
      const cost = shares * currentPrice;
      // Clamp: no negative cash
      if (cost > account.cash) {
        continue;
      }

      const fee = calcAStockFees(cost, true, commissionRate, minCommission);
      totalFees += fee;

      position = updatePositionAfterBuy(position, shares, currentPrice);
      account = { ...account, cash: account.cash - cost - fee };
      account = updateAccountAfterTrade(account, position, currentPrice);

      trades.push({
        id: nextTradeId(),
        type: 'BUY',
        signalType: strategy.id || strategy.name,
        reason: decision.reason,
        confidence: decision.confidence,
        price: currentPrice,
        date: currentKline.date,
        shares,
        value: cost,
        fee,
      });
    } else if (decision.action === 'SELL') {
      // Clamp: no negative shares (long-only)
      const sellShares = Math.min(shares, position.shares);
      if (sellShares <= 0) continue;

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

      trades.push({
        id: nextTradeId(),
        type: 'SELL',
        signalType: strategy.id || strategy.name,
        reason: decision.reason,
        confidence: decision.confidence,
        price: currentPrice,
        date: currentKline.date,
        shares: sellShares,
        value: sellValue,
        fee,
        pnl: realizedPnl,
        pnlPercent,
      });
    }
  }

  // --- Calculate final result ---
  const lastPrice = klines[klines.length - 1].close;
  const firstPrice = klines[0].close;
  const finalPositionMarketValue = position.shares * lastPrice;
  const finalBalance = account.cash + finalPositionMarketValue;
  const totalReturnPercent = ((finalBalance - initialCash) / initialCash) * 100;
  const totalTrades = trades.length;
  const totalSells = trades.filter((t) => t.type === 'SELL').length;
  const winningTrades = trades.filter((t) => t.type === 'SELL' && (t.pnl ?? 0) > 0).length;
  const winRate = totalSells > 0 ? (winningTrades / totalSells) * 100 : 0;

  // Buy & hold return
  const buyHoldReturnPercent = firstPrice > 0 ? ((lastPrice - firstPrice) / firstPrice) * 100 : 0;

  // Sharpe ratio from daily equity curve
  const sharpeRatio = sharpeFromEquityCurve(equityCurve);

  // Max drawdown from equity curve (peak-to-trough %)
  const maxDrawdownPercent = maxDrawdownFromEquityCurve(equityCurve);

  const result: BacktestResult = {
    id: `backtest-${Date.now()}`,
    userId,
    symbol,
    startDate: klines[0].date,
    endDate: klines[klines.length - 1].date,
    initialBalance: initialCash,
    finalBalance,
    totalReturnPercent,
    totalTrades,
    winningTrades,
    winRate,
    totalFees,
    sharpeRatio,
    buyHoldReturnPercent,
    maxDrawdownPercent,
    trades,
    createdAt: new Date().toISOString(),
  };

  return { result, diagnostics };
}
