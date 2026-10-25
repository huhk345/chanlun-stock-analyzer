/**
 * 逐步回测 (单步/回退/跳转) 的服务端会话
 *
 * 策略代码与回测引擎都在服务端, 浏览器无法本地逐步执行, 因此这里把
 * 「一次逐步回测」做成有状态会话:
 *
 *   POST   /api/backtest/stepper               建会话, 返回第 0 步状态
 *   POST   /api/backtest/stepper/:id/step      前进/后退/跳转
 *   POST   /api/backtest/stepper/:id/run-all   跑到结束, 返回完整报告
 *   GET    /api/backtest/stepper/:id/trades    当前账本 (全部已成交)
 *   DELETE /api/backtest/stepper/:id           结束会话
 *
 * 会话只存在内存里 (K 线 + 引擎状态), 30 分钟无访问自动回收。
 */
import { randomUUID } from 'node:crypto';
import type { KlinePeriod } from '../src/utils/klineUtils.ts';
import type {
  BacktestStepState,
  BacktestStepper,
  RunBacktestOutput,
} from '../src/types/strategy.ts';
import type { BacktestTrade } from '../src/types/stock.ts';
import { createBacktestStepper } from './engine/backtestStepper.ts';
import { resolveIndicatorDefinitions, type IndicatorCodeInput } from './engine/indicatorResolve.ts';
import { fetchBacktestKlines } from './backtest.ts';
import { findStrategy } from './strategies/index.ts';

const SESSION_TTL_MS = 30 * 60 * 1000;
/** 同时存在的会话上限 (防止前端反复点「逐步回测」把内存撑爆) */
const MAX_SESSIONS = 8;

export interface ServerStepperInput {
  symbol: string;
  strategyId: string;
  period?: KlinePeriod;
  adjust?: string;
  rangeStart?: string;
  rangeEnd?: string;
  initialCash?: number;
  currency?: string;
  commissionRate?: number;
  minCommission?: number;
  stopLossPercent?: number;
  params?: Record<string, unknown>;
  selectedIndicatorIds?: readonly string[];
  indicatorCodes?: readonly IndicatorCodeInput[];
}

export type StepperAction = 'start' | 'forward' | 'backward' | 'jump';

export interface StepperSessionView {
  sessionId: string;
  symbol: string;
  totalSteps: number;
  dateRange: { start: string; end: string };
  /** 已成交笔数 (账本明细走 GET /trades, 避免每步都回传全量成交) */
  tradeCount: number;
  state: BacktestStepState;
}

export interface StepperRunAllView extends Omit<RunBacktestOutput, 'result'> {
  sessionId: string;
  symbol: string;
  totalSteps: number;
  dateRange: { start: string; end: string };
  result: RunBacktestOutput['result'];
  trades: BacktestTrade[];
}

interface StepperSession {
  id: string;
  symbol: string;
  totalSteps: number;
  dateRange: { start: string; end: string };
  stepper: BacktestStepper;
  createdAt: number;
  lastAccessAt: number;
}

const sessions = new Map<string, StepperSession>();

function httpError(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function pruneSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastAccessAt > SESSION_TTL_MS) sessions.delete(id);
  }
  // 超上限时淘汰最久未访问的会话
  if (sessions.size >= MAX_SESSIONS) {
    const ordered = [...sessions.values()].sort((a, b) => a.lastAccessAt - b.lastAccessAt);
    const overflow = sessions.size - MAX_SESSIONS + 1;
    for (let i = 0; i < overflow && i < ordered.length; i++) {
      sessions.delete(ordered[i].id);
    }
  }
}

function view(session: StepperSession, state: BacktestStepState): StepperSessionView {
  return {
    sessionId: session.id,
    symbol: session.symbol,
    totalSteps: session.totalSteps,
    dateRange: session.dateRange,
    tradeCount: session.stepper.getTrades().length,
    state,
  };
}

/** 建会话并返回第 0 步状态 */
export async function createStepperSession(input: ServerStepperInput): Promise<StepperSessionView> {
  const { symbol, strategyId } = input ?? ({} as ServerStepperInput);
  if (!symbol) throw httpError('symbol is required', 400);
  if (!strategyId) throw httpError('strategyId is required', 400);

  const strategy = await findStrategy(strategyId);
  if (!strategy) throw httpError(`策略未找到: ${strategyId}`, 404);

  const { klines } = await fetchBacktestKlines(input);
  const indicators = input.selectedIndicatorIds?.length
    ? resolveIndicatorDefinitions(input.indicatorCodes).definitions
    : [];

  const stepper = createBacktestStepper({
    klines,
    symbol,
    userId: 'server',
    initialCash: input.initialCash ?? 100_000,
    currency: input.currency ?? 'CNY',
    stopLossPercent: input.stopLossPercent,
    commissionRate: input.commissionRate ?? 0.00025,
    minCommission: input.minCommission ?? 5,
    strategy,
    params: input.params,
    selectedIndicatorIds: input.selectedIndicatorIds,
    indicators,
  });

  const state = stepper.start();

  pruneSessions();
  const session: StepperSession = {
    id: randomUUID(),
    symbol,
    totalSteps: klines.length,
    dateRange: { start: klines[0].date, end: klines[klines.length - 1].date },
    stepper,
    createdAt: Date.now(),
    lastAccessAt: Date.now(),
  };
  sessions.set(session.id, session);

  return view(session, state);
}

function requireSession(id: string): StepperSession {
  pruneSessions();
  const session = sessions.get(id);
  if (!session) throw httpError('逐步回测会话不存在或已过期', 404);
  session.lastAccessAt = Date.now();
  return session;
}

/** 单步推进 / 回退 / 跳转 */
export function stepStepperSession(
  id: string,
  action: StepperAction,
  index?: number,
): StepperSessionView {
  const session = requireSession(id);
  const { stepper } = session;

  let state: BacktestStepState;
  switch (action) {
    case 'start':
      state = stepper.start();
      break;
    case 'backward':
      state = stepper.stepBackward();
      break;
    case 'jump':
      if (typeof index !== 'number' || !Number.isFinite(index)) {
        throw httpError('jump 需要 index 参数', 400);
      }
      state = stepper.jumpTo(Math.trunc(index));
      break;
    case 'forward':
    default:
      state = stepper.stepForward();
      break;
  }

  return view(session, state);
}

/** 跑到结束, 返回完整回测报告 + 成交账本 */
export function runAllStepperSession(id: string): StepperRunAllView {
  const session = requireSession(id);
  const output = session.stepper.runAll();
  const trades = session.stepper.getTrades();
  return {
    sessionId: session.id,
    symbol: session.symbol,
    totalSteps: session.totalSteps,
    dateRange: session.dateRange,
    result: output.result,
    diagnostics: output.diagnostics,
    equityCurve: output.equityCurve,
    trades,
  };
}

/** 当前账本 (逐步过程中查看全部成交) */
export function stepperSessionTrades(id: string): { sessionId: string; trades: BacktestTrade[] } {
  const session = requireSession(id);
  return { sessionId: session.id, trades: session.stepper.getTrades() };
}

export function closeStepperSession(id: string): boolean {
  return sessions.delete(id);
}

/** 当前活跃会话数 (健康检查用) */
export function activeStepperSessions(): number {
  pruneSessions();
  return sessions.size;
}
