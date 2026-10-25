/**
 * 回测引擎统一出口 (服务端)
 *
 * 浏览器不再引用这里的任何代码 —— 回测只在服务端跑, 前端通过
 * POST /api/backtest/run 与 /api/backtest/stepper/* 拿结果。
 */
export { runBacktest } from './backtestRunner.ts';
export { createBacktestStepper } from './backtestStepper.ts';
export {
  createInitialAccount,
  createInitialPosition,
  updateAccountAfterTrade,
  updatePositionAfterBuy,
  updatePositionAfterSell,
  executeDecisionAtClose,
  executeProtectiveStop,
} from './backtestExecution.ts';
export {
  sharpeFromEquityCurve,
  sharpeFromReturns,
  maxDrawdownFromEquityCurve,
  nextTradeId,
  tradesToSnapshots,
} from './backtestUtils.ts';
export {
  calcAStockFees,
  limitUpPrice,
  limitDownPrice,
  buildStrategyParams,
  validateDecision,
  resolveOrderShares,
} from './strategyAdapter.ts';
export { computeIndicatorValues } from './indicatorValues.ts';
export { resolveIndicatorDefinitions } from './indicatorResolve.ts';
export type { ResolvedIndicatorSet } from './indicatorResolve.ts';
