import type { Kline, BacktestTrade, BacktestResult } from '../types/stock';
import type {
  RunBacktestInput,
  RunBacktestOutput,
  BacktestDiagnostic,
  BacktestAccountState,
  BacktestPositionState,
  BacktestTradeSnapshot,
  UserStrategyInput,
  UserStrategyDecision,
} from '../types/strategy';
import { buildStrategyParams, validateDecision, resolveOrderShares, calcAStockFees, isLimitUp, isLimitDown } from './strategyAdapter';
import { mergeKlines, findFractions, calculateStrokes, calculateSegments, calculateHubs } from './chanlun';

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
// Helper: build ChanLun snapshot for strategy input
// ---------------------------------------------------------------------------

function buildChanLunCache(klines: readonly Kline[]) {
  const mutableKlines = [...klines];
  const merged = mergeKlines(mutableKlines);
  const fractions = findFractions(merged, mutableKlines);
  const strokes = calculateStrokes(fractions);
  const segments = calculateSegments(strokes);
  const hubs = calculateHubs(strokes);
  return { mergedKlines: merged, fractions, strokes, segments, hubs };
}

// ---------------------------------------------------------------------------
// Helper: convert BacktestTrade[] to BacktestTradeSnapshot[]
// ---------------------------------------------------------------------------

function tradesToSnapshots(trades: BacktestTrade[]): BacktestTradeSnapshot[] {
  return trades.map((t) => ({
    id: t.id,
    date: t.date,
    action: t.type,
    price: t.price,
    shares: t.shares,
    value: t.value,
    reason: t.signalType,
  }));
}

// ---------------------------------------------------------------------------
// Helper: generate a unique trade ID
// ---------------------------------------------------------------------------

let tradeCounter = 0;
function nextTradeId(): string {
  tradeCounter++;
  return `trade-${Date.now()}-${tradeCounter}`;
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
        trades: [],
        createdAt: now,
      },
      diagnostics,
    };
  }

  // Build strategy params
  const params = buildStrategyParams(strategy, customParams as Record<string, unknown> | undefined);

  // Initialise state
  let account = createInitialAccount(initialCash, currency);
  let position = createInitialPosition();
  const trades: BacktestTrade[] = [];
  let strategyStopped = false;
  let totalFees = 0;

  // Iterate from oldest (index 0) to newest
  for (let i = 0; i < klines.length; i++) {
    const currentKline = klines[i];
    const currentPrice = currentKline.close;

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

    // Add ChanLun data if strategy requires it
    if (strategy.requiresChanLun) {
      strategyInput.chanlun = buildChanLunCache(klinesSlice);
    }

    // --- Call strategy ---
    let decision: UserStrategyDecision | null = null;

    if (!strategyStopped) {
      try {
        decision = strategy.decide(strategyInput);
      } catch (err) {
        strategyStopped = true;
        const msg = err instanceof Error ? err.message : String(err);
        diagnostics.push({
          date: currentKline.date,
          level: 'error',
          message: `Strategy threw an error: ${msg}. Strategy will no longer be called.`,
        });
        decision = null;
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
  const finalPositionMarketValue = position.shares * lastPrice;
  const finalBalance = account.cash + finalPositionMarketValue;
  const totalReturnPercent = ((finalBalance - initialCash) / initialCash) * 100;
  const totalTrades = trades.length;
  const winningTrades = trades.filter((t) => t.type === 'SELL' && (t.pnl ?? 0) > 0).length;
  const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;

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
    trades,
    createdAt: new Date().toISOString(),
  };

  return { result, diagnostics };
}
