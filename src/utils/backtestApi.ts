/**
 * 回测 API 客户端
 *
 * 回测引擎 (策略 + 撮合 + 指标) 全部在服务端, 浏览器只发请求、渲染结果:
 *   POST   /api/backtest/run                 一次性回测 (可轮询进度)
 *   POST   /api/backtest/stepper             建逐步回测会话
 *   POST   /api/backtest/stepper/:id/step    前进 / 后退 / 跳转
 *   POST   /api/backtest/stepper/:id/run-all 跑到结束
 *   GET    /api/backtest/stepper/:id/trades  当前账本
 *   DELETE /api/backtest/stepper/:id         结束会话
 */
import type { BacktestResult, BacktestTrade } from '../types/stock';
import type {
  BacktestDiagnostic,
  BacktestStepState,
  BacktestTimelineRow,
} from '../types/strategy';
import type { BacktestEngine, PoolSymbolDetailView } from '../types/poolBacktest';

export interface BacktestIndicatorCode {
  id: string;
  code: string;
}

/** 一次性回测请求体 (服务端按 symbol 自行拉取 K 线) */
export interface BacktestRunRequest {
  symbol: string;
  strategyId: string;
  /** 回测引擎, 默认 'native' (逐步回测仅支持 native) */
  engine?: BacktestEngine;
  period?: '1d' | '1w';
  rangeStart?: string;
  rangeEnd?: string;
  initialCash?: number;
  currency?: string;
  commissionRate?: number;
  minCommission?: number;
  stopLossPercent?: number;
  params?: Record<string, unknown>;
  selectedIndicatorIds?: readonly string[];
  indicatorCodes?: readonly BacktestIndicatorCode[];
  adjust?: string;
  force?: boolean;
  /** 进度轮询 id (配合 GET /api/backtest/progress/:id) */
  progressId?: string;
}

/** 逐步回测会话请求体 (与一次性回测同口径) */
export type BacktestStepperRequest = Omit<BacktestRunRequest, 'progressId' | 'force'>;

export interface StepperSessionView {
  sessionId: string;
  symbol: string;
  /** 实际执行模拟的引擎 */
  engine?: BacktestEngine;
  /** 本次是复用磁盘上录好的时间轴 (不重新跑策略) */
  cached?: boolean;
  /** 录制耗时 (秒); 命中缓存时接近 0 */
  recordSeconds?: number;
  totalSteps: number;
  dateRange: { start: string; end: string };
  /** 已成交笔数 (账本明细走 getStepperTrades) */
  tradeCount: number;
  state: BacktestStepState;
}

/** 整段逐日模拟: 一次性拿到, 之后前端本地拖动即可 */
export interface StepperTimelineView {
  sessionId: string;
  symbol: string;
  engine?: BacktestEngine;
  cached?: boolean;
  recordSeconds?: number;
  totalSteps: number;
  dateRange: { start: string; end: string };
  rows: BacktestTimelineRow[];
  /** 全量成交账本 (按日期过滤即可得到"截至某天"的账本) */
  trades: BacktestTrade[];
}

export interface StepperRunAllView {
  sessionId: string;
  symbol: string;
  totalSteps: number;
  dateRange: { start: string; end: string };
  result: BacktestResult;
  diagnostics: readonly BacktestDiagnostic[];
  equityCurve?: number[];
  trades: BacktestTrade[];
}

export type StepperAction = 'start' | 'forward' | 'backward' | 'jump';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(path, init);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error((err as { error?: string })?.error || `请求失败 (${resp.status})`);
  }
  return (await resp.json()) as T;
}

/** 一次性回测: 服务端拉 K 线 + 跑策略, 返回完整报告 */
export async function runBacktest(request_: BacktestRunRequest): Promise<PoolSymbolDetailView> {
  return request<PoolSymbolDetailView>('/api/backtest/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request_),
  });
}

/** 建逐步回测会话, 返回第 0 步状态 */
export async function createStepperSession(
  request_: BacktestStepperRequest,
): Promise<StepperSessionView> {
  return request<StepperSessionView>('/api/backtest/stepper', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request_),
  });
}

export async function stepStepperSession(
  sessionId: string,
  action: StepperAction,
  index?: number,
): Promise<StepperSessionView> {
  return request<StepperSessionView>(
    `/api/backtest/stepper/${encodeURIComponent(sessionId)}/step`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, index }),
    },
  );
}

export async function runAllStepperSession(sessionId: string): Promise<StepperRunAllView> {
  return request<StepperRunAllView>(
    `/api/backtest/stepper/${encodeURIComponent(sessionId)}/run-all`,
    { method: 'POST' },
  );
}

export async function getStepperTrades(sessionId: string): Promise<BacktestTrade[]> {
  const data = await request<{ trades?: BacktestTrade[] }>(
    `/api/backtest/stepper/${encodeURIComponent(sessionId)}/trades`,
  );
  return data.trades ?? [];
}

/**
 * 拉取整段逐日模拟。
 *
 * 服务端在建会话时已经一次性录好每一天 (决策 / 成交 / 账户 / 持仓 / 权益),
 * 所以这里只取一次, 之后前进、后退、拖动都是本地索引, 不再触发策略计算。
 */
export async function getStepperTimeline(sessionId: string): Promise<StepperTimelineView> {
  return request<StepperTimelineView>(
    `/api/backtest/stepper/${encodeURIComponent(sessionId)}/timeline`,
  );
}

export async function closeStepperSession(sessionId: string): Promise<void> {
  try {
    await fetch(`/api/backtest/stepper/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
  } catch {
    /* 关闭失败不影响界面 (服务端会自动回收) */
  }
}

/** 进度轮询 id 生成 (8~64 位 [A-Za-z0-9_-]) */
export function newProgressId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `bt-${Date.now().toString(36)}-${rand}`;
}
