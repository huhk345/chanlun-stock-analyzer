/**
 * 回测公共工具 — 回测引擎 / 单步回测 / CLI 脚本共用:
 *   - 年化夏普比率 / 最大回撤
 *   - 交易 ID 生成 / BacktestTrade -> BacktestTradeSnapshot 转换
 */
import type { BacktestTrade } from '../../src/types/stock.ts';
import type { BacktestTradeSnapshot } from '../../src/types/strategy.ts';

// ---------------------------------------------------------------------------
// 统计指标
// ---------------------------------------------------------------------------

/**
 * 由收益率序列计算年化夏普比率 (无风险利率按 0, 252 个交易日/年)。
 * 样本不足 2 个或波动为 0 时返回 0。
 */
export function sharpeFromReturns(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  const std = Math.sqrt(variance);
  return std > 0 ? (mean / std) * Math.sqrt(252) : 0;
}

/** 由每日权益曲线计算年化夏普比率 (前一日权益为 0 时按 0 收益处理) */
export function sharpeFromEquityCurve(equityCurve: number[]): number {
  const returns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1];
    returns.push(prev > 0 ? (equityCurve[i] - prev) / prev : 0);
  }
  return sharpeFromReturns(returns);
}

/**
 * 由每日权益曲线计算最大回撤百分比 (峰谷回撤, 保留两位小数)。
 * @param initialPeak 初始峰值 (如初始资金), 用于计入首日即低于初始资金的回撤; 默认取首日权益。
 */
export function maxDrawdownFromEquityCurve(equityCurve: number[], initialPeak?: number): number {
  let peak = initialPeak ?? equityCurve[0] ?? 0;
  let maxDrawdown = 0;
  for (const equity of equityCurve) {
    if (equity > peak) {
      peak = equity;
    } else if (peak > 0) {
      const dd = ((peak - equity) / peak) * 100;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }
  }
  return Math.round(maxDrawdown * 100) / 100;
}

// ---------------------------------------------------------------------------
// 交易辅助
// ---------------------------------------------------------------------------

let tradeCounter = 0;

/** 生成全局唯一交易 ID (各回测引擎共用计数器, 避免同一毫秒内重复) */
export function nextTradeId(): string {
  tradeCounter++;
  return `trade-${Date.now()}-${tradeCounter}`;
}

/** BacktestTrade -> 策略可读的 BacktestTradeSnapshot; 理由优先用信号理由, 回退到来源标签 */
export function tradesToSnapshots(trades: BacktestTrade[]): BacktestTradeSnapshot[] {
  return trades.map((t) => ({
    id: t.id,
    date: t.date,
    action: t.type,
    price: t.price,
    shares: t.shares,
    value: t.value,
    fee: t.fee,
    reason: t.reason ?? t.signalType,
  }));
}
