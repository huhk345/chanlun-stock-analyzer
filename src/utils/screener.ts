import type { Kline } from '../types/stock';
import type {
  StrategyParamValue,
  UserStrategyDefinition,
} from '../types/strategy';
import { buildStrategyParams, normalizeDecision } from './strategyAdapter';
import {
  mergeKlines,
  findFractions,
  calculateStrokes,
  calculateSegments,
  calculateHubs,
} from './chanlun';

// ---------------------------------------------------------------------------
// 选股引擎: 纯函数, 无网络/存储依赖, 可单元测试
// 对每只股票用策略 decide() 评估最新一根 K 线, 输出 BUY/SELL/HOLD 信号 + 行情摘要
// ---------------------------------------------------------------------------

export interface ScreenerSignal {
  symbol: string;
  action: 'BUY' | 'SELL' | 'HOLD';
  confidence?: number;
  reason?: string;
  close: number;
  prevClose: number | null;
  changePct: number;
  volRatio: number | null;
  amount5: number | null;
  dataDate: string;
  error?: string;
}

/** 选股 pad 默认推荐的策略 id (按顺序展示) */
export const SCREENER_DEFAULT_STRATEGY_IDS = [
  'screener-chanlun-b23',
  'screener-ma-bull',
  'screener-donchian-breakout',
  'ma-cross',
  'chanlun-volume-pullback',
] as const;

function marketStats(klines: readonly Kline[]): {
  close: number;
  prevClose: number | null;
  changePct: number;
  volRatio: number | null;
  amount5: number | null;
  dataDate: string;
} {
  const n = klines.length;
  const last = klines[n - 1];
  const prev = n >= 2 ? klines[n - 2] : null;
  const changePct =
    prev && prev.close > 0 ? ((last.close - prev.close) / prev.close) * 100 : 0;
  let volRatio: number | null = null;
  if (n >= 2) {
    const prev5 = klines.slice(Math.max(0, n - 6), n - 1);
    const avg = prev5.reduce((s, k) => s + k.volume, 0) / Math.max(1, prev5.length);
    volRatio = avg > 0 ? Math.round((last.volume / avg) * 100) / 100 : null;
  }
  let amount5: number | null = null;
  if (n >= 1) {
    const last5 = klines.slice(-5);
    amount5 = Math.round((last5.reduce((s, k) => s + k.amount, 0) / last5.length / 1e8) * 100) / 100;
  }
  return { close: last.close, prevClose: prev?.close ?? null, changePct, volRatio, amount5, dataDate: last.date };
}

function buildChanLun(klines: readonly Kline[]) {
  const mutable = [...klines];
  const mergedKlines = mergeKlines(mutable);
  const fractions = findFractions(mergedKlines, mutable);
  const strokes = calculateStrokes(fractions);
  const segments = calculateSegments(strokes);
  const hubs = calculateHubs(strokes);
  return { mergedKlines, fractions, strokes, segments, hubs };
}

/**
 * 用策略评估单只股票最新一根 K 线 (空仓视角: 只关心是否出现买入信号)。
 * 策略抛异常 / 返回非法决策时降级为 HOLD 并附带 error, 永不抛异常。
 */
export function evaluateScreenerSignal(
  strategy: UserStrategyDefinition,
  klines: readonly Kline[],
  symbol: string,
  customParams?: Readonly<Record<string, StrategyParamValue>>,
): ScreenerSignal {
  const empty: ScreenerSignal = {
    symbol,
    action: 'HOLD',
    close: klines.length > 0 ? klines[klines.length - 1].close : 0,
    prevClose: null,
    changePct: 0,
    volRatio: null,
    amount5: null,
    dataDate: klines.length > 0 ? klines[klines.length - 1].date : '',
  };
  if (klines.length === 0) {
    return { ...empty, reason: '无K线数据', error: 'empty-klines' };
  }
  const stats = marketStats(klines);
  const params = buildStrategyParams(strategy, customParams as Record<string, unknown> | undefined);
  const currentIndex = klines.length - 1;
  const currentKline = klines[currentIndex];
  try {
    const decision = normalizeDecision(
      strategy.decide({
        symbol,
        timeframe: 'daily',
        klines,
        currentIndex,
        currentKline,
        account: { initialCash: 100000, cash: 100000, equity: 100000, currency: 'CNY' },
        position: { shares: 0, averageCost: 0, marketValue: 0, unrealizedPnl: 0, unrealizedPnlPercent: 0 },
        trades: [],
        params,
        chanlun: strategy.requiresChanLun ? buildChanLun(klines) : undefined,
        currency: 'CNY',
        initialCash: 100000,
      }),
    );
    return {
      symbol,
      action: decision.action,
      confidence: decision.confidence,
      reason: decision.reason,
      ...stats,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { symbol, action: 'HOLD', reason: `策略执行失败: ${msg}`, ...stats, error: msg };
  }
}

/** 批量评估 (同步纯计算, 无 IO) */
export function evaluateScreenerBatch(
  strategy: UserStrategyDefinition,
  stocks: ReadonlyArray<{ symbol: string; klines: readonly Kline[] }>,
  customParams?: Readonly<Record<string, StrategyParamValue>>,
): ScreenerSignal[] {
  return stocks.map((s) => evaluateScreenerSignal(strategy, s.klines, s.symbol, customParams));
}

export interface ScreenerFilter {
  onlyBuy?: boolean;
  minConfidence?: number;
  minChangePct?: number;
}

export function filterScreenerSignals<T extends ScreenerSignal>(signals: readonly T[], filter: ScreenerFilter = {}): T[] {
  return signals.filter((s) => {
    if (filter.onlyBuy && s.action !== 'BUY') return false;
    if (filter.minConfidence != null && (s.confidence ?? 0) < filter.minConfidence) return false;
    if (filter.minChangePct != null && s.changePct < filter.minChangePct) return false;
    return true;
  });
}

export type ScreenerSortKey = 'confidenceDesc' | 'changeDesc' | 'changeAsc' | 'symbolAsc';

export function sortScreenerSignals<T extends ScreenerSignal>(signals: readonly T[], sortBy: ScreenerSortKey = 'confidenceDesc'): T[] {
  const arr = [...signals];
  switch (sortBy) {
    case 'changeDesc':
      return arr.sort((a, b) => b.changePct - a.changePct);
    case 'changeAsc':
      return arr.sort((a, b) => a.changePct - b.changePct);
    case 'symbolAsc':
      return arr.sort((a, b) => a.symbol.localeCompare(b.symbol));
    case 'confidenceDesc':
    default: {
      const rank = (s: ScreenerSignal) => (s.action === 'BUY' ? 2 : s.action === 'SELL' ? 1 : 0);
      return arr.sort((a, b) => rank(b) - rank(a) || (b.confidence ?? 0) - (a.confidence ?? 0));
    }
  }
}

// ---------------------------------------------------------------------------
// 回测区间: 日历日期切片 (YYYY-MM-DD 字符串比较, 交易日自然对齐)
// ---------------------------------------------------------------------------

/** 今天 (本地时区, YYYY-MM-DD) */
export function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** N 年前的今天 (回测区间默认值用: yearsAgoStr(3) = 近3年起点) */
export function yearsAgoStr(years: number): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 按回测区间切片 K 线 (起止均为闭区间, 空字符串视为无界)。
 * 区间无交集时返回空数组 (调用方计为失败, 不静默回退全量, 避免误导)。
 */
export function sliceKlinesByRange(
  klines: readonly Kline[],
  start?: string,
  end?: string,
): Kline[] {
  if (!start && !end) return [...klines];
  return klines.filter(
    (k) => (!start || k.date >= start) && (!end || k.date <= end),
  );
}
