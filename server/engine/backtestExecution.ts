/**
 * 回测成交模型 —— runBacktest / createBacktestStepper / 组合研究脚本共用。
 *
 * 成交约定 (原版口径: 信号当日收盘价成交, 全程不使用未来数据):
 *
 *   1. 信号只用「截止当根收盘」的数据生成 (策略输入始终是 klines.slice(0, i + 1)),
 *      并假设以尾盘/收盘集合竞价按【当根收盘价】完成买卖。
 *      任何环节都不得读取第 i 根之后的数据 —— 前缀不变性测试可检出未来数据。
 *
 *   2. 涨跌停拦截按「当根收盘价 vs 前收盘价」判定 (收盘时点可见的信息):
 *      收盘封涨停无法按收盘价买入, 收盘封跌停无法按收盘价卖出, 交易作废并记诊断。
 *
 *   3. 固定止损 = 盘中止损单模型: 止损价 (成本价 × (1 - 止损%)) 在开仓后即可
 *      提前挂出, 盘中最低价触及止损价则按止损价成交; 跳空低开 (开盘价已低于
 *      止损价) 按开盘价成交; 一字跌停封死卖不出去时止损顺延到下一交易日。
 *
 *   4. T+1: 当日买入的股份当日不可卖出。盘中止损在当日买入成交之前执行,
 *      因此结构上只可能卖出隔日及更早买入的股份。
 *
 * 上述(2)(3)(4)都只使用成交时点已经发生的价格 (收盘价/开盘价/最低价/前收盘)。
 */

import type { Kline, BacktestTrade } from '../../src/types/stock.ts';
import type {
  BacktestAccountState,
  BacktestPositionState,
  BacktestDiagnostic,
  UserStrategyDecision,
} from '../../src/types/strategy.ts';
import { calcAStockFees, limitDownPrice, limitUpPrice, resolveOrderShares } from './strategyAdapter.ts';
import { nextTradeId } from './backtestUtils.ts';

// ---------------------------------------------------------------------------
// 账户 / 持仓状态工具 (runBacktest 与 createBacktestStepper 共用)
// ---------------------------------------------------------------------------

export function createInitialAccount(initialCash: number, currency: string): BacktestAccountState {
  return {
    initialCash,
    cash: initialCash,
    equity: initialCash,
    currency,
  };
}

export function createInitialPosition(): BacktestPositionState {
  return {
    shares: 0,
    averageCost: 0,
    marketValue: 0,
    unrealizedPnl: 0,
    unrealizedPnlPercent: 0,
  };
}

/** 按当前价重算账户权益 (cash + 持仓市值) */
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

/** 买入后更新持仓 (加权平均成本) */
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

/** 卖出后更新持仓, 并返回本次卖出实现的盈亏 (未扣费用) */
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
// 决策执行: 以当根收盘价成交 (信号当日收盘价, 尾盘/收盘竞价模型)
// ---------------------------------------------------------------------------

/** 一次成交尝试的结果; trade 为 null 表示未成交 (拦截/资金不足等, 详见 diagnostics) */
export interface ExecutionResult {
  trade: BacktestTrade | null;
  account: BacktestAccountState;
  position: BacktestPositionState;
  /** 本次成交费用 (未成交为 0), 由调用方累加 */
  fee: number;
  diagnostics: BacktestDiagnostic[];
}

export interface DecisionExecutionArgs {
  /** 当根收盘产生、并以当根收盘价立即执行的决策 (action 必须为 BUY / SELL) */
  decision: UserStrategyDecision;
  /** 执行 K 线 (成交价 = bar.close) */
  bar: Kline;
  /** 当根前收价 (涨跌停判定基准; 首根 K 线为 null) */
  prevClose: number | null;
  symbol: string;
  account: BacktestAccountState;
  position: BacktestPositionState;
  commissionRate: number;
  minCommission: number;
  /** 成交记录的 signalType (策略 id / 名称) */
  strategyLabel: string;
}

/**
 * 执行决策: 以当根收盘价成交。
 * 在成交时点校验涨跌停、资金与可卖数量 —— 全部只用当根收盘可见的信息。
 */
export function executeDecisionAtClose(args: DecisionExecutionArgs): ExecutionResult {
  const {
    decision,
    bar,
    prevClose,
    symbol,
    account,
    position,
    commissionRate,
    minCommission,
    strategyLabel,
  } = args;

  const diagnostics: BacktestDiagnostic[] = [];
  const price = bar.close;
  const noTrade: ExecutionResult = { trade: null, account, position, fee: 0, diagnostics };

  // 按成交价解析委托股数 (资金/持仓均取成交时点状态)
  const { shares, warnings } = resolveOrderShares(decision, account, position, price);
  for (const w of warnings) {
    diagnostics.push({ date: bar.date, level: 'warning', message: w });
  }
  if (shares <= 0) {
    return noTrade;
  }

  // --- 涨跌停拦截 (当根收盘 vs 前收, 收盘时点可见) ---
  if (prevClose !== null && prevClose > 0) {
    if (decision.action === 'BUY' && price >= limitUpPrice(prevClose, symbol)) {
      diagnostics.push({
        date: bar.date,
        level: 'warning',
        message:
          `Buy blocked: 收盘封涨停, 无法按收盘价买入 (close ${price.toFixed(2)} >= ` +
          `limit-up ${limitUpPrice(prevClose, symbol).toFixed(2)}), 交易作废`,
      });
      return noTrade;
    }
    if (decision.action === 'SELL' && price <= limitDownPrice(prevClose, symbol)) {
      diagnostics.push({
        date: bar.date,
        level: 'warning',
        message:
          `Sell blocked: 收盘封跌停, 无法按收盘价卖出 (close ${price.toFixed(2)} <= ` +
          `limit-down ${limitDownPrice(prevClose, symbol).toFixed(2)}), 交易作废`,
      });
      return noTrade;
    }
  }

  if (decision.action === 'BUY') {
    // 含手续费必须不超过可用现金: 不足时按 100 股整数倍下调, 保证 cash >= 0
    let buyShares = shares;
    let cost = buyShares * price;
    let fee = calcAStockFees(cost, true, commissionRate, minCommission);
    while (buyShares >= 100 && cost + fee > account.cash) {
      buyShares -= 100;
      cost = buyShares * price;
      fee = calcAStockFees(cost, true, commissionRate, minCommission);
    }
    if (buyShares <= 0 || cost + fee > account.cash) {
      diagnostics.push({
        date: bar.date,
        level: 'warning',
        message: 'Buy skipped: 成交时可用资金不足 (含手续费)',
      });
      return noTrade;
    }

    const newPosition = updatePositionAfterBuy(position, buyShares, price);
    let newAccount: BacktestAccountState = { ...account, cash: account.cash - cost - fee };
    newAccount = updateAccountAfterTrade(newAccount, newPosition, price);

    const trade: BacktestTrade = {
      id: nextTradeId(),
      type: 'BUY',
      signalType: strategyLabel,
      reason: decision.reason,
      confidence: decision.confidence,
      price,
      date: bar.date,
      shares: buyShares,
      value: cost,
      fee,
    };
    return { trade, account: newAccount, position: newPosition, fee, diagnostics };
  }

  // --- SELL ---
  const sellShares = Math.min(shares, position.shares);
  if (sellShares <= 0) {
    return noTrade;
  }

  const sellValue = sellShares * price;
  const fee = calcAStockFees(sellValue, false, commissionRate, minCommission);
  const { position: newPosition, realizedPnl } = updatePositionAfterSell(position, sellShares, price);
  let newAccount: BacktestAccountState = { ...account, cash: account.cash + sellValue - fee };
  newAccount = updateAccountAfterTrade(newAccount, newPosition, price);

  const pnlPercent = newPosition.averageCost > 0
    ? (realizedPnl / (sellShares * newPosition.averageCost)) * 100
    : 0;

  const trade: BacktestTrade = {
    id: nextTradeId(),
    type: 'SELL',
    signalType: strategyLabel,
    reason: decision.reason,
    confidence: decision.confidence,
    price,
    date: bar.date,
    shares: sellShares,
    value: sellValue,
    fee,
    pnl: realizedPnl,
    pnlPercent,
  };
  return { trade, account: newAccount, position: newPosition, fee, diagnostics };
}

// ---------------------------------------------------------------------------
// 固定止损: 盘中止损单模型
// ---------------------------------------------------------------------------

export interface ProtectiveStopArgs {
  bar: Kline;
  /** 执行日前收价 (跌停判定基准; 首根 K 线为 null) */
  prevClose: number | null;
  symbol: string;
  /** 止损百分比, 如 8 表示成本价的 -8% */
  stopLossPercent: number;
  /**
   * 可卖出股数 (T+1: 调用方传入 position.shares 减去当日买入部分)。
   * 止损只卖出可卖数量。
   */
  sellableShares: number;
  account: BacktestAccountState;
  position: BacktestPositionState;
  commissionRate: number;
  minCommission: number;
}

/**
 * 盘中止损单: 最低价触及止损价即成交。
 *   跳空低开 (开盘价 <= 止损价) → 按开盘价成交 (更差的价格);
 *   盘中触及                  → 按止损价成交;
 *   一字跌停 (全天最高价 <= 跌停价) → 卖不出去, 顺延到下一交易日 (本函数返回未成交)。
 */
export function executeProtectiveStop(args: ProtectiveStopArgs): ExecutionResult {
  const {
    bar,
    prevClose,
    symbol,
    stopLossPercent,
    sellableShares,
    account,
    position,
    commissionRate,
    minCommission,
  } = args;

  const diagnostics: BacktestDiagnostic[] = [];
  const noTrade: ExecutionResult = { trade: null, account, position, fee: 0, diagnostics };

  if (sellableShares <= 0 || position.shares <= 0) return noTrade;

  const stopPrice = position.averageCost * (1 - stopLossPercent / 100);
  if (!(stopPrice > 0) || Number.isNaN(stopPrice)) return noTrade;

  // 未触及止损价
  if (bar.low > stopPrice) return noTrade;

  // 一字跌停封死: 全天没有高于跌停价的成交, 卖不出去 → 顺延
  if (prevClose !== null && prevClose > 0) {
    const limitDown = limitDownPrice(prevClose, symbol);
    if (bar.high <= limitDown) {
      diagnostics.push({
        date: bar.date,
        level: 'warning',
        message:
          `Stop-loss deferred: ${bar.date} 一字跌停无法卖出 ` +
          `(high ${bar.high.toFixed(2)} <= limit-down ${limitDown.toFixed(2)}), 止损顺延至下一交易日`,
      });
      return noTrade;
    }
  }

  const gappedBelow = bar.open <= stopPrice;
  const fillPrice = gappedBelow ? bar.open : stopPrice;
  const sellShares = Math.min(sellableShares, position.shares);
  if (sellShares <= 0) return noTrade;

  const sellValue = sellShares * fillPrice;
  const fee = calcAStockFees(sellValue, false, commissionRate, minCommission);
  const { position: newPosition, realizedPnl } = updatePositionAfterSell(position, sellShares, fillPrice);
  let newAccount: BacktestAccountState = { ...account, cash: account.cash + sellValue - fee };
  newAccount = updateAccountAfterTrade(newAccount, newPosition, fillPrice);

  const pnlPercent = newPosition.averageCost > 0
    ? (realizedPnl / (sellShares * newPosition.averageCost)) * 100
    : 0;

  const trade: BacktestTrade = {
    id: nextTradeId(),
    type: 'SELL',
    signalType: 'stop-loss',
    reason: `触发固定止损 ${stopLossPercent}%`,
    price: fillPrice,
    date: bar.date,
    shares: sellShares,
    value: sellValue,
    fee,
    pnl: realizedPnl,
    pnlPercent,
  };

  diagnostics.push({
    date: bar.date,
    level: 'warning',
    message: `Stop-loss triggered at ${fillPrice.toFixed(2)} (threshold ${stopPrice.toFixed(2)})`,
  });

  return { trade, account: newAccount, position: newPosition, fee, diagnostics };
}
