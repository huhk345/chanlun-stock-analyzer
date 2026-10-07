/**
 * 缠论买卖点 / 选股后端 API 客户端.
 *
 * 默认打相对路径 /api (vite dev 已代理到 server); 生产/预览环境可用
 * VITE_ANALYSIS_API_URL 指向独立 Node 服务 (默认 tsx server/index.ts, :3001)。
 * 服务端不可用时调用方应回退到本地计算 (evaluateSignalWithFallback /
 * analyzeChanlunWithFallback 已内置回退)。
 */
import type { Kline, BSPoint, Fraction, Hub, MergedKline, Segment, Stroke } from '../types/stock';
import type { StrategyParamValue, UserStrategyDefinition } from '../types/strategy';
import {
  calculateBSPoints,
  calculateHubs,
  calculateSegments,
  calculateStrokes,
  findFractions,
  mergeKlines,
} from './chanlun';
import { evaluateScreenerSignal, type ScreenerSignal } from './screener';
import { getStoredStrategy } from './strategyStorage';

const API_BASE: string = ((import.meta.env?.VITE_ANALYSIS_API_URL as string | undefined) ?? '').replace(/\/$/, '');

async function post<T>(path: string, body: unknown): Promise<T> {
  const resp = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try {
      const data = await resp.json();
      if (data?.error) msg = data.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return (await resp.json()) as T;
}

export interface ChanlunAnalysis {
  mergedKlines: MergedKline[];
  fractions: Fraction[];
  strokes: Stroke[];
  segments: Segment[];
  hubs: Hub[];
  bsPoints: BSPoint[];
}

/** 后端完整缠论流水线; 失败抛异常 */
export function analyzeChanlun(klines: Kline[]): Promise<ChanlunAnalysis> {
  return post<ChanlunAnalysis>('/api/chanlun/analyze', { klines });
}

function analyzeChanlunLocal(klines: Kline[]): ChanlunAnalysis {
  const mergedKlines = mergeKlines(klines);
  const fractions = findFractions(mergedKlines, klines);
  const strokes = calculateStrokes(fractions);
  const segments = calculateSegments(strokes);
  const hubs = calculateHubs(strokes);
  const bsPoints = calculateBSPoints(klines, strokes);
  return { mergedKlines, fractions, strokes, segments, hubs, bsPoints };
}

/** 优先后端, 不可用时本地计算 */
export async function analyzeChanlunWithFallback(klines: Kline[]): Promise<ChanlunAnalysis> {
  try {
    return await analyzeChanlun(klines);
  } catch {
    return analyzeChanlunLocal(klines);
  }
}

export interface BSPointsResult {
  strokes: Stroke[];
  bsPoints: BSPoint[];
}

/** 后端买卖点 (只返回 笔 + 买卖点, 跳过线段/中枢两遍计算) */
export function fetchBSPoints(klines: Kline[]): Promise<BSPointsResult> {
  return post<BSPointsResult>('/api/chanlun/bspoints', { klines });
}

function fetchBSPointsLocal(klines: Kline[]): BSPointsResult {
  const strokes = calculateStrokes(findFractions(mergeKlines(klines), klines));
  return { strokes, bsPoints: calculateBSPoints(klines, strokes) };
}

export async function fetchBSPointsWithFallback(klines: Kline[]): Promise<BSPointsResult> {
  try {
    return await fetchBSPoints(klines);
  } catch {
    return fetchBSPointsLocal(klines);
  }
}

/**
 * 后端选股信号评估.
 * AI 创建的策略从 localStorage 取源码发 strategyCode; 内建策略发 strategyId.
 */
export function evaluateSignal(
  strategy: UserStrategyDefinition,
  klines: readonly Kline[],
  symbol: string,
  customParams?: Readonly<Record<string, StrategyParamValue>>,
): Promise<ScreenerSignal> {
  let storedCode: string | null = null;
  try {
    storedCode = getStoredStrategy(strategy.id)?.code ?? null;
  } catch { /* 非浏览器环境 */ }
  return post<ScreenerSignal>('/api/screener/evaluate', {
    symbol,
    klines,
    customParams,
    ...(storedCode ? { strategyCode: storedCode } : { strategyId: strategy.id }),
  });
}

export async function evaluateSignalWithFallback(
  strategy: UserStrategyDefinition,
  klines: readonly Kline[],
  symbol: string,
  customParams?: Readonly<Record<string, StrategyParamValue>>,
): Promise<ScreenerSignal> {
  try {
    return await evaluateSignal(strategy, klines, symbol, customParams);
  } catch {
    return evaluateScreenerSignal(strategy, klines, symbol, customParams);
  }
}
