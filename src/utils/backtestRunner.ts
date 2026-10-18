import type { BacktestTrade, BacktestResult } from '../types/stock';
import type {
  RunBacktestInput,
  RunBacktestOutput,
  BacktestDiagnostic,
  UserStrategyInput,
  UserStrategyDecision,
} from '../types/strategy';
import { buildStrategyParams, validateDecision } from './strategyAdapter';
import { computeIndicatorValues } from './indicatorAdapter';
import { loadStoredIndicators } from './indicatorLoader';
import { computeChanlunStructures } from './chanlun';
import {
  tradesToSnapshots,
  sharpeFromEquityCurve,
  maxDrawdownFromEquityCurve,
} from './backtestUtils';
import {
  createInitialAccount,
  createInitialPosition,
  executeDecisionAtClose,
  executeProtectiveStop,
} from './backtestExecution';

// ---------------------------------------------------------------------------
// 兼容导出: 账户/持仓状态工具已迁移到 backtestExecution.ts (单步回测共用),
// 这里继续转发, 避免既有导入路径失效。
// ---------------------------------------------------------------------------

export {
  createInitialAccount,
  createInitialPosition,
  updateAccountAfterTrade,
  updatePositionAfterBuy,
  updatePositionAfterSell,
} from './backtestExecution';

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

  // 迭代方向: 从最旧到最新; 信号当根收盘价成交 (全程不使用未来数据)
  for (let i = 0; i < klines.length; i++) {
    const currentKline = klines[i];
    const currentPrice = currentKline.close;
    const prevClose = i > 0 ? klines[i - 1].close : null;

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
      if (exec.trade) trades.push(exec.trade);
      diagnostics.push(...exec.diagnostics);
    }

    // --- 2) 策略决策: 只用截止当根的数据 (klines.slice(0, i + 1)); 决策以当根收盘价成交 ---
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
      // 无效决策按 HOLD 处理 (不产生交易)
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
      if (exec.trade) trades.push(exec.trade);
      diagnostics.push(...exec.diagnostics);
    }

    // --- 4) 记录当日收盘权益 (当日全部成交之后) ---
    equityCurve.push(account.cash + position.shares * currentPrice);
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

  return { result, diagnostics, equityCurve };
}
