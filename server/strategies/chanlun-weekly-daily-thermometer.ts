import type { BSPoint, Hub, Kline, MergedKline, Stroke } from '../../src/types/stock.ts';
import type { UserStrategyDefinition, UserStrategyInput } from '../../src/types/strategy.ts';
import { calculateBSPoints, computeChanlunStructures } from '../../src/utils/chanlun.ts';
import { MARKET_STRENGTH_ROWS } from './data/market-strength.ts';

const DEFAULTS = {
  weeklyMaPeriod: 20,
  weeklySlopeWeeks: 4,
  maxSignalAge: 10,
  minBreakoutVolumeRatio: 1.5,
  hubReturnBars: 3,
  maxRsi: 72,
  maxDistanceFromMa20Percent: 12,
  minRelativeStrengthPercent: -8,
  minimumSignalQuality: 0.7,
  hardStopPercent: 10,
  structureStopBufferPercent: 1.5,
  // 移动保护的回吐额度必须小于启动线，否则保护在数学上不存在。
  // 全样本 ATR14/价格 中位 3.01%，5×ATR 中位 15.1%，与启动线 15% 几乎相等
  // → 启动瞬间止损位就落在成本价上（50.5% 的交易 5×ATR ≥ 15%），等于没有保护，
  // 只能一路跌到 -10% 硬止损。3×ATR 中位 9.0%，启动瞬间止损位在成本上方约 6%。
  trailingAtrMultiple: 3,
  trailingActivationPercent: 15,
  maxHoldingBars: 60,
  timeStopMinReturnPercent: 2,
};

function numberParam(input: UserStrategyInput, key: keyof typeof DEFAULTS): number {
  const value = input.params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : DEFAULTS[key] as number;
}

function meanAt(values: readonly number[], endIndex: number, period: number): number | null {
  if (period <= 0 || endIndex + 1 < period) return null;
  let total = 0;
  for (let i = endIndex - period + 1; i <= endIndex; i++) total += values[i];
  return total / period;
}

function klineMean(klines: readonly Kline[], endIndex: number, period: number, field: 'close' | 'volume' = 'close'): number | null {
  if (period <= 0 || endIndex + 1 < period) return null;
  let total = 0;
  for (let i = endIndex - period + 1; i <= endIndex; i++) total += klines[i][field];
  return total / period;
}

function isFinitePositive(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

function dateToUtcMs(date: string): number {
  return Date.parse(`${date.slice(0, 10)}T00:00:00.000Z`);
}

function mondayOf(date: string): string {
  const timestamp = dateToUtcMs(date);
  const day = new Date(timestamp).getUTCDay();
  const daysFromMonday = (day + 6) % 7;
  return new Date(timestamp - daysFromMonday * 86_400_000).toISOString().slice(0, 10);
}

/** Aggregate daily bars and omit the current, still-forming week. */
function completedWeeks(klines: readonly Kline[]): Kline[] {
  const groups: Array<{ key: string; bar: Kline }> = [];
  for (const bar of klines) {
    const key = mondayOf(bar.date);
    const last = groups[groups.length - 1];
    if (last?.key === key) {
      last.bar.high = Math.max(last.bar.high, bar.high);
      last.bar.low = Math.min(last.bar.low, bar.low);
      last.bar.close = bar.close;
      last.bar.volume += bar.volume;
      last.bar.amount += bar.amount;
      last.bar.date = bar.date;
    } else {
      groups.push({ key, bar: { ...bar } });
    }
  }

  // Drop the first bucket because a backtest warm-up can start mid-week.
  // At the daily close on Friday the current week is complete; on other days
  // the final bucket is still forming and must not affect the weekly signal.
  const lastBar = klines[klines.length - 1];
  const lastWeekIsComplete = lastBar && new Date(dateToUtcMs(lastBar.date)).getUTCDay() === 5;
  return groups.slice(1, lastWeekIsComplete ? undefined : -1).map(({ bar }) => bar);
}

interface WeeklyContext {
  bars: Kline[];
  strokes: Stroke[];
  hubs: Hub[];
  points: BSPoint[];
  bullish: boolean;
  weak: boolean;
  freshB3: boolean;
  freshSell: boolean;
  close: number | null;
  ma20: number | null;
  maSlopeUp: boolean;
}

function hasRisingHubs(hubs: readonly Hub[]): boolean {
  if (hubs.length < 2) return false;
  const previous = hubs[hubs.length - 2];
  const latest = hubs[hubs.length - 1];
  return latest.zd > previous.zg;
}

function hasHigherWeeklySwings(strokes: readonly Stroke[]): boolean {
  const up = strokes.filter((stroke) => stroke.direction === 'up').slice(-2);
  const down = strokes.filter((stroke) => stroke.direction === 'down').slice(-2);
  return up.length === 2 && down.length === 2 &&
    up[1].end.price > up[0].end.price &&
    down[1].end.price > down[0].end.price;
}

/**
 * 买卖点被"确认"的那根 K 线。
 *
 * 一笔的终点只有在之后出现下一笔时才会冻结。下一笔的终点分型需要右边一根
 * 合并K线才能成立，因此确认日取该分型后一根合并K线的首根原始K线。
 * 返回 null 表示该笔仍是最后一笔，尚未确认。
 */
function confirmationIndex(
  strokes: readonly Stroke[],
  mergedKlines: readonly MergedKline[],
  point: BSPoint,
): number | null {
  const next = strokes[point.strokeIndex + 1];
  if (!next) return null;
  const nextMerged = mergedKlines[next.end.index + 1];
  return nextMerged ? nextMerged.originalIndices[0] : next.end.originalIndex;
}

interface ConfirmedPoint {
  point: BSPoint;
  /** 该点被确认的原始 K 线下标 */
  confirmedAt: number;
}

/** 取最近一个"已确认且确认后不超过 maxAge 根"的买卖点。 */
function latestConfirmedPoint(
  points: readonly BSPoint[],
  strokes: readonly Stroke[],
  mergedKlines: readonly MergedKline[],
  currentIndex: number,
  types: readonly string[],
  maxAge: number,
): ConfirmedPoint | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const point = points[i];
    if (!types.includes(point.type)) continue;
    const confirmedAt = confirmationIndex(strokes, mergedKlines, point);
    if (confirmedAt === null) continue;
    const age = currentIndex - confirmedAt;
    if (age >= 0 && age <= maxAge) return { point, confirmedAt };
  }
  return null;
}

function strokeHigh(stroke: Stroke): number {
  return Math.max(stroke.start.price, stroke.end.price);
}

function strokeLow(stroke: Stroke): number {
  return Math.min(stroke.start.price, stroke.end.price);
}

/** B3 对应的中枢区间，与 calculateBSPoints 的三买口径一致：e-4 / e-2 两笔的重叠区间。 */
function b3HubRange(point: BSPoint, strokes: readonly Stroke[]): { zd: number; zg: number } | null {
  const e = point.strokeIndex;
  const first = strokes[e - 4];
  const second = strokes[e - 2];
  if (!first || !second) return null;
  const zd = Math.max(strokeLow(first), strokeLow(second));
  const zg = Math.min(strokeHigh(first), strokeHigh(second));
  return zg > zd ? { zd, zg } : null;
}

/**
 * 突破中枢的那一笔必须有量：取突破笔内成交量最大的一根，
 * 要求其成交量 >= 20 日均量 × minRatio。
 */
function breakoutVolumeConfirmed(
  point: BSPoint,
  strokes: readonly Stroke[],
  klines: readonly Kline[],
  minRatio: number,
): boolean {
  const breakout = strokes[point.strokeIndex - 1];
  if (!breakout || breakout.direction !== 'up') return false;

  let maxVolume = 0;
  let maxVolumeIndex = -1;
  for (let i = breakout.start.originalIndex; i <= breakout.end.originalIndex; i++) {
    if (klines[i].volume > maxVolume) {
      maxVolume = klines[i].volume;
      maxVolumeIndex = i;
    }
  }
  if (maxVolumeIndex < 0 || maxVolume <= 0) return false;

  const averageVolume = klineMean(klines, maxVolumeIndex, 20, 'volume');
  return isFinitePositive(averageVolume) && maxVolume >= averageVolume * minRatio;
}

/**
 * 动态止盈：浮盈越高，ATR 跟踪越紧。
 * 默认 3×ATR 在 20% 浮盈后收紧到 2.5×，30% 后收紧到 2×，最低不低于 1.5×。
 */
function trailingAtrMultipleFor(baseMultiple: number, maxProfitPercent: number): number {
  if (maxProfitPercent >= 30) return Math.max(1.5, baseMultiple * 2 / 3);
  if (maxProfitPercent >= 20) return Math.max(1.5, baseMultiple * 5 / 6);
  return baseMultiple;
}

function weeklyContext(klines: readonly Kline[]): WeeklyContext {
  const bars = completedWeeks(klines);
  if (bars.length === 0) {
    return {
      bars, strokes: [], hubs: [], points: [], bullish: false, weak: false, freshB3: false, freshSell: false,
      close: null, ma20: null, maSlopeUp: false,
    };
  }

  const structures = computeChanlunStructures(bars);
  // 周线同样只认已确认的笔，避免用下一周仍可能改写的末端中枢/买卖点。
  const points = calculateBSPoints(bars, structures.strokes, { confirmedOnly: true });
  const endIndex = bars.length - 1;
  const ma20 = klineMean(bars, endIndex, DEFAULTS.weeklyMaPeriod);
  const ma20AtSlopeStart = klineMean(bars, endIndex - DEFAULTS.weeklySlopeWeeks, DEFAULTS.weeklyMaPeriod);
  const close = bars[endIndex].close;
  const enoughHistory = bars.length >= DEFAULTS.weeklyMaPeriod + DEFAULTS.weeklySlopeWeeks;
  const slopeUp = isFinitePositive(ma20) && isFinitePositive(ma20AtSlopeStart) && ma20 > ma20AtSlopeStart;
  const freshB3 = latestConfirmedPoint(points, structures.strokes, structures.mergedKlines, endIndex, ['B3'], 3) !== null;
  const freshSell = latestConfirmedPoint(points, structures.strokes, structures.mergedKlines, endIndex, ['S1', 'S2', 'S3'], 2) !== null;
  const structuralUptrend = hasRisingHubs(structures.hubs) || hasHigherWeeklySwings(structures.strokes);
  const bullish = enoughHistory && isFinitePositive(ma20) && close > ma20 && slopeUp && structuralUptrend && !freshSell;
  // A weekly close below MA20 while the 4-week slope is still rising can be a
  // normal pullback. Confirm a weekly trend break only when both agree.
  const weak = enoughHistory && close < (ma20 ?? Infinity) && !slopeUp;

  return {
    bars, strokes: structures.strokes, hubs: structures.hubs, points, bullish, weak, freshB3, freshSell,
    close, ma20, maSlopeUp: slopeUp,
  };
}

interface MarketContext {
  source: 'benchmark' | 'stock-fallback';
  score: number;
  close: number;
  ma20: number;
  ma60: number;
  stableTrend: boolean;
  relativeStrengthPercent: number | null;
}

function stockFallbackMarketContext(stockKlines: readonly Kline[], index: number): MarketContext | null {
  const close = stockKlines[index]?.close;
  const ma20 = klineMean(stockKlines, index, 20);
  const ma60 = klineMean(stockKlines, index, 60);
  const ma20TenDaysAgo = klineMean(stockKlines, index - 10, 20);
  if (!isFinitePositive(close) || !isFinitePositive(ma20) || !isFinitePositive(ma60) || !isFinitePositive(ma20TenDaysAgo)) return null;

  const stableTrend = close > ma20 && close > ma60 && ma20 > ma60 && ma20 > ma20TenDaysAgo;
  return {
    source: 'stock-fallback',
    // Keep the fallback neutral and small-sized. Without a fresh benchmark,
    // do not pretend that stock-local data can estimate broad-market strength.
    score: 50,
    close,
    ma20,
    ma60,
    stableTrend,
    relativeStrengthPercent: null,
  };
}

/** Use the latest market row strictly before the signal date (one-day lag). */
function marketContext(date: string, stockKlines: readonly Kline[], index: number): MarketContext | null {
  let low = 0;
  let high = MARKET_STRENGTH_ROWS.length - 1;
  let rowIndex = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (MARKET_STRENGTH_ROWS[mid][0] < date) {
      rowIndex = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (rowIndex < 0) return stockFallbackMarketContext(stockKlines, index);

  const row = MARKET_STRENGTH_ROWS[rowIndex];
  const ageDays = (dateToUtcMs(date) - dateToUtcMs(row[0])) / 86_400_000;
  if (ageDays > 15) return stockFallbackMarketContext(stockKlines, index);

  const closes = MARKET_STRENGTH_ROWS.slice(0, rowIndex + 1).map((item) => item[3]);
  const end = closes.length - 1;
  const ma20 = meanAt(closes, end, 20);
  const ma60 = meanAt(closes, end, 60);
  const ma20TenDaysAgo = meanAt(closes, end - 10, 20);
  if (!isFinitePositive(ma20) || !isFinitePositive(ma60)) return stockFallbackMarketContext(stockKlines, index);

  const stableTrend = row[3] > ma20 && row[3] > ma60 && ma20 > ma60 &&
    isFinitePositive(ma20TenDaysAgo) && ma20 > ma20TenDaysAgo && row[1] >= 50;

  // Align the benchmark with the latest common completed session (t-1).
  const stockClose = index >= 1 ? stockKlines[index - 1].close : null;
  const stockOldClose = index >= 21 ? stockKlines[index - 21].close : null;
  const marketOldClose = rowIndex >= 20 ? MARKET_STRENGTH_ROWS[rowIndex - 20][3] : null;
  const relativeStrengthPercent = isFinitePositive(stockClose) && isFinitePositive(stockOldClose) && isFinitePositive(marketOldClose)
    ? ((stockClose / stockOldClose - 1) - (row[3] / marketOldClose - 1)) * 100
    : null;

  return {
    source: 'benchmark',
    score: row[1],
    close: row[3],
    ma20,
    ma60,
    stableTrend,
    relativeStrengthPercent,
  };
}

function rsi14(klines: readonly Kline[], index: number): number | null {
  if (index < 14) return null;
  let gains = 0;
  let losses = 0;
  for (let i = index - 13; i <= index; i++) {
    const delta = klines[i].close - klines[i - 1].close;
    if (delta > 0) gains += delta;
    else losses -= delta;
  }
  const averageGain = gains / 14;
  const averageLoss = losses / 14;
  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  const relativeStrength = averageGain / averageLoss;
  return 100 - 100 / (1 + relativeStrength);
}

function atr14(klines: readonly Kline[], index: number): number | null {
  if (index < 14) return null;
  let total = 0;
  for (let i = index - 13; i <= index; i++) {
    const previousClose = klines[i - 1].close;
    total += Math.max(
      klines[i].high - klines[i].low,
      Math.abs(klines[i].high - previousClose),
      Math.abs(klines[i].low - previousClose),
    );
  }
  return total / 14;
}

interface BuyCandidate {
  kind: 'B1' | 'B2' | 'B3';
  quality: number;
  reason: string;
  supportPrice: number;
  /** 买点自身的日期，用于在图表上与看板买卖点对齐 */
  pointDate: string;
  /** B3 突破的中枢上沿；回到该价位下方盘整即判定突破失败 */
  hubUpper: number | null;
}

function confirmedPointCandidate(
  found: ConfirmedPoint | null,
  type: 'B1' | 'B2' | 'B3',
  klines: readonly Kline[],
  index: number,
  ma20: number,
  ma20Rising: boolean,
  weekly: WeeklyContext,
  hubUpper: number | null = null,
): BuyCandidate | null {
  if (!found) return null;
  const point = found.point;
  const bar = klines[index];
  // found 已经保证买点被确认；这里只检查确认后的价格与趋势条件。
  if (bar.close <= point.price || bar.close <= ma20 || bar.close <= bar.open || !ma20Rising) return null;
  const baseQuality = type === 'B3' ? 0.9 : type === 'B2' ? 0.82 : 0.74;
  const pointName = type === 'B3' ? '三买' : type === 'B2' ? '二买' : '一买';
  const quality = Math.min(0.99, baseQuality + (weekly.freshB3 ? 0.035 : 0));
  return {
    kind: type,
    quality,
    reason: `${type}|周线多头，日线${pointName}右侧确认，收盘站上买点与 MA20`,
    supportPrice: point.price,
    pointDate: point.date,
    hubUpper,
  };
}

/**
 * 仓位只由大盘趋势强度决定：趋势越强，仓位越重。
 *
 * 温度已整体移除，不再用估值冷热做逆向分档，也不再用单日温度开关否决开仓。
 */
function allocationPercent(market: MarketContext, weeklyBullish: boolean, candidateKind: BuyCandidate['kind']): number {
  if (market.source === 'stock-fallback') {
    return candidateKind === 'B3' && weeklyBullish && market.stableTrend ? 25 : 0;
  }
  if (!weeklyBullish || !market.stableTrend) return 0;
  if (market.score >= 75) return 100;
  if (market.score >= 60) return 80;
  return 50;
}

function attractionScore(
  weekly: WeeklyContext,
  market: MarketContext | null,
  close: number,
  dailyMa20: number | null,
  dailyMa20Rising: boolean,
  relativeStrength: number | null,
  hasFreshDailyBuy: boolean,
): number {
  let score = weekly.bullish ? 24 : 0;
  score += weekly.freshB3 ? 10 : (hasRisingHubs(weekly.hubs) ? 6 : 0);
  if (isFinitePositive(dailyMa20) && close > dailyMa20) score += 16;
  if (dailyMa20Rising) score += 10;
  if (market) {
    score += Math.max(0, Math.min(20, market.score / 100 * 20));
    if (relativeStrength !== null) score += Math.max(0, Math.min(14, ((relativeStrength + 15) / 30) * 14));
  }
  if (hasFreshDailyBuy) score += 10;
  return Math.round(Math.min(100, Math.max(0, score)) * 100) / 100;
}

function sellAll(reason: string, score: number, shares: number, confidence = 0.9) {
  return {
    action: 'SELL' as const,
    amount: { unit: 'shares' as const, value: shares },
    reason,
    confidence,
    score,
  };
}

function currentEntryTrade(input: UserStrategyInput) {
  for (let i = input.trades.length - 1; i >= 0; i--) {
    if (input.trades[i].action === 'BUY') return input.trades[i];
  }
  return null;
}

function entryIndexFor(input: UserStrategyInput, tradeDate: string | null): number | null {
  if (!tradeDate) return null;
  const exact = input.klines.findIndex((bar) => bar.date === tradeDate);
  if (exact >= 0) return exact;
  const firstAfter = input.klines.findIndex((bar) => bar.date > tradeDate);
  return firstAfter >= 0 ? firstAfter : null;
}

function decision(input: UserStrategyInput) {
  const klines = input.klines;
  const index = Math.min(input.currentIndex, klines.length - 1);
  const current = klines[index];
  if (!current || index < 1) return { action: 'HOLD' as const, score: 0 };

  const dailyStructures = input.chanlun
    ? { ...input.chanlun, strokes: [...input.chanlun.strokes], hubs: [...input.chanlun.hubs] }
    : computeChanlunStructures([...klines]);
  // 只用已确认的笔：最后一笔的终点仍可能被后续 K 线延伸，据此产生的买卖点
  // 会在之后重算同一段历史时消失，与看板最终买卖点对不上。
  const dailyPoints = calculateBSPoints([...klines], [...dailyStructures.strokes], { confirmedOnly: true });
  const weekly = weeklyContext(klines);
  const market = marketContext(current.date, klines, index);

  const dailyMa20 = klineMean(klines, index, 20);
  const dailyMa20FiveDaysAgo = klineMean(klines, index - 5, 20);
  const dailyMa20Rising = isFinitePositive(dailyMa20) && isFinitePositive(dailyMa20FiveDaysAgo) && dailyMa20 > dailyMa20FiveDaysAgo;
  const distanceFromMa20Percent = isFinitePositive(dailyMa20) ? ((current.close / dailyMa20) - 1) * 100 : null;
  const rsi = rsi14(klines, index);
  const relativeStrength = market?.relativeStrengthPercent ?? null;

  // 年龄从"买点被确认"的那根 K 线开始算：确认前不动作，确认后一旦满足
  // 其他条件即可入场，这样买点与看板按完整数据算出的买卖点完全一致。
  const maxConfirmAge = numberParam(input, 'maxSignalAge');
  const b3 = latestConfirmedPoint(dailyPoints, dailyStructures.strokes, dailyStructures.mergedKlines, index, ['B3'], maxConfirmAge);
  const b2 = latestConfirmedPoint(dailyPoints, dailyStructures.strokes, dailyStructures.mergedKlines, index, ['B2'], maxConfirmAge);
  const b1 = latestConfirmedPoint(dailyPoints, dailyStructures.strokes, dailyStructures.mergedKlines, index, ['B1'], maxConfirmAge);
  // B3 必须由放量突破中枢确认；量能取突破笔内成交量最大的一根。
  const b3Hub = b3 ? b3HubRange(b3.point, dailyStructures.strokes) : null;
  const b3VolumeConfirmed = b3 !== null && breakoutVolumeConfirmed(
    b3.point,
    dailyStructures.strokes,
    klines,
    numberParam(input, 'minBreakoutVolumeRatio'),
  );
  const b3Candidate = b3VolumeConfirmed
    ? confirmedPointCandidate(b3, 'B3', klines, index, dailyMa20 ?? Infinity, dailyMa20Rising, weekly, b3Hub?.zg ?? null)
    : null;
  const b2Candidate = market?.source === 'benchmark' && market.stableTrend
    ? confirmedPointCandidate(b2, 'B2', klines, index, dailyMa20 ?? Infinity, dailyMa20Rising, weekly)
    : null;
  const b1Candidate = market?.source === 'benchmark' && market.stableTrend
    ? confirmedPointCandidate(b1, 'B1', klines, index, dailyMa20 ?? Infinity, dailyMa20Rising, weekly)
    : null;
  const candidate = b3Candidate ?? b2Candidate ?? b1Candidate;
  const score = attractionScore(weekly, market, current.close, dailyMa20, dailyMa20Rising, relativeStrength, candidate !== null);

  if (input.position.shares > 0) {
    const entryTrade = currentEntryTrade(input);
    const entryIndex = entryIndexFor(input, entryTrade?.date ?? null);
    const heldBars = entryIndex === null ? 0 : index - entryIndex + 1;

    if (weekly.freshSell) return sellAll('[weekly-sell]|周线出现近两周确认卖点', score, input.position.shares, 0.95);
    if (weekly.weak) {
      return sellAll(
        `[weekly-weak]|周线收盘 ${weekly.close?.toFixed(2) ?? 'n/a'}，MA20 ${weekly.ma20?.toFixed(2) ?? 'n/a'}，4 周斜率未向上`,
        score,
        input.position.shares,
        0.88,
      );
    }

    const hardStop = input.position.averageCost * (1 - numberParam(input, 'hardStopPercent') / 100);
    if (current.close <= hardStop) {
      return sellAll(`[hard-stop]|收盘低于成本 ${numberParam(input, 'hardStopPercent').toFixed(1)}%`, score, input.position.shares, 0.98);
    }

    // B3 入场后，收盘跌回被突破中枢的上沿下方，并连续 hubReturnBars 根未收回，
    // 视为突破失败离场。该规则取代 B3 的"跌回买点价"结构止损。
    const hubUpperMatch = entryTrade?.reason?.match(/(?:^|\|)hub=([0-9]+(?:\.[0-9]+)?)/);
    const hubUpper = hubUpperMatch ? Number(hubUpperMatch[1]) : null;
    if (isFinitePositive(hubUpper) && entryIndex !== null) {
      const requiredBars = numberParam(input, 'hubReturnBars');
      let barsBackInside = 0;
      for (let i = index; i > entryIndex && barsBackInside < requiredBars; i--) {
        if (klines[i].close > hubUpper) break;
        barsBackInside++;
      }
      if (barsBackInside >= requiredBars) {
        return sellAll(
          `[hub-return]|收盘连续 ${barsBackInside} 根跌回中枢上沿 ${hubUpper.toFixed(2)} 下方，突破失败`,
          score,
          input.position.shares,
          0.93,
        );
      }
    }

    const supportMatch = entryTrade?.reason?.match(/(?:^|\|)support=([0-9]+(?:\.[0-9]+)?)/);
    let structuralSupport: number | null = supportMatch ? Number(supportMatch[1]) : null;
    if (!isFinitePositive(structuralSupport) && entryIndex !== null && entryTrade?.reason?.startsWith('B3|')) {
      const entryB3 = dailyPoints.find((point) => point.type === 'B3' && point.originalIndex <= entryIndex && entryIndex - point.originalIndex <= 10);
      if (entryB3) structuralSupport = entryB3.price;
    } else if (!isFinitePositive(structuralSupport) && entryIndex !== null && entryTrade?.reason?.startsWith('B2|')) {
      const entryB2 = dailyPoints.find((point) => point.type === 'B2' && point.originalIndex <= entryIndex && entryIndex - point.originalIndex <= 10);
      if (entryB2) structuralSupport = entryB2.price;
    } else if (!isFinitePositive(structuralSupport) && entryIndex !== null && entryTrade?.reason?.startsWith('hub-retest|')) {
      const supportHub = dailyStructures.hubs.filter((hub) => hub.endIndex < entryIndex).at(-1);
      if (supportHub) structuralSupport = supportHub.zg;
    } else if (!isFinitePositive(structuralSupport) && entryIndex !== null && entryTrade?.reason?.startsWith('higher-low|')) {
      const entrySwingLow = dailyStructures.strokes.filter((stroke) => stroke.direction === 'down' && stroke.end.originalIndex <= entryIndex).at(-1);
      if (entrySwingLow) structuralSupport = entrySwingLow.end.price;
    }
    if (!isFinitePositive(hubUpper) && isFinitePositive(structuralSupport) && current.close <= structuralSupport * (1 - numberParam(input, 'structureStopBufferPercent') / 100)) {
      return sellAll('[structure-stop]|收盘跌破入场支撑并超过结构缓冲', score, input.position.shares, 0.93);
    }

    const atr = atr14(klines, index);
    if (entryIndex !== null && isFinitePositive(atr)) {
      // The entry is filled at its close, so that day's earlier high is not
      // part of the position's run-up.
      let highestSinceEntry = input.position.averageCost;
      for (let i = entryIndex + 1; i <= index; i++) highestSinceEntry = Math.max(highestSinceEntry, klines[i].high);
      const maximumProfitPercent = ((highestSinceEntry / input.position.averageCost) - 1) * 100;
      // 浮盈越高，跟踪倍数越紧；highestSinceEntry 只上移，保护线因此只升不降。
      const atrMultiple = trailingAtrMultipleFor(numberParam(input, 'trailingAtrMultiple'), maximumProfitPercent);
      const trailingStop = highestSinceEntry - atrMultiple * atr;
      if (maximumProfitPercent >= numberParam(input, 'trailingActivationPercent') && current.close <= trailingStop) {
        if (!weekly.bullish) {
          return sellAll(`[atr-trailing-stop]|浮盈达到启动线后收盘跌破 ${atrMultiple.toFixed(2)} ATR 动态移动保护位，周线多头未确认`, score, input.position.shares, 0.9);
        }

        const alreadyTrimmed = input.trades.some((trade) =>
          trade.action === 'SELL' && trade.date >= (entryTrade?.date ?? '') && trade.reason?.startsWith('[atr-trailing-trim]'),
        );
        if (!alreadyTrimmed) {
          const trimShares = Math.floor((input.position.shares * 0.5) / 100) * 100;
          if (trimShares < 100 || trimShares >= input.position.shares) {
            return sellAll(`[atr-trailing-stop]|触发 ${atrMultiple.toFixed(2)} ATR 动态移动保护位，持仓不足一手无法减半，清仓`, score, input.position.shares, 0.9);
          }
          return {
            action: 'SELL' as const,
            amount: { unit: 'shares' as const, value: trimShares },
            reason: `[atr-trailing-trim]|周线仍多头，首次减仓约 50%，剩余仓位等待周线或结构退出`,
            confidence: 0.9,
            score,
          };
        }
      }
    }

    const recentDailySell = latestConfirmedPoint(dailyPoints, dailyStructures.strokes, dailyStructures.mergedKlines, index, ['S2', 'S3'], 5);
    if (recentDailySell && entryIndex !== null && recentDailySell.point.originalIndex >= entryIndex) {
      return sellAll(`[daily-${recentDailySell.point.type}]|日线出现确认卖点`, score, input.position.shares, 0.88);
    }

    const currentReturnPercent = input.position.averageCost > 0
      ? ((current.close / input.position.averageCost) - 1) * 100
      : input.position.unrealizedPnlPercent;
    if (heldBars >= numberParam(input, 'maxHoldingBars') && currentReturnPercent < numberParam(input, 'timeStopMinReturnPercent') && !weekly.bullish) {
      return sellAll('[time-stop]|持有达到时间上限、收益不足且周线多头未确认', score, input.position.shares, 0.82);
    }

    return { action: 'HOLD' as const, reason: '持仓管理中，周线趋势与风险条件未触发', score };
  }

  if (!weekly.bullish) return { action: 'HOLD' as const, reason: '[filter:weekly]|等待周线多头确认', score };
  if (!market) return { action: 'HOLD' as const, reason: '[filter:market-data]|大盘数据缺失或过期，暂停新买入', score };
  if (!candidate) return { action: 'HOLD' as const, reason: '[filter:chanlun-point]|等待确认的日线 B3、B2 或 B1', score };
  if (market.source === 'stock-fallback' && !market.stableTrend) {
    return { action: 'HOLD' as const, reason: '[filter:stock-fallback-trend]|大盘数据已过期，个股 MA20/MA60 趋势未确认', score };
  }
  if (current.close <= (dailyMa20 ?? Infinity) || !dailyMa20Rising || current.close <= current.open) {
    return { action: 'HOLD' as const, reason: '[filter:daily-trend]|等待日线趋势与收盘确认', score };
  }
  if (rsi === null || rsi > numberParam(input, 'maxRsi')) {
    return { action: 'HOLD' as const, reason: '[filter:rsi]|RSI 过热或数据不足', score };
  }
  if (distanceFromMa20Percent === null || distanceFromMa20Percent > numberParam(input, 'maxDistanceFromMa20Percent')) {
    return { action: 'HOLD' as const, reason: '[filter:extension]|价格离日线 MA20 过远，避免追高', score };
  }
  if (market.source === 'benchmark' && (relativeStrength === null || relativeStrength < numberParam(input, 'minRelativeStrengthPercent'))) {
    return { action: 'HOLD' as const, reason: '[filter:relative-strength]|相对沪深300强度不足或历史数据不够', score };
  }
  if (candidate.quality < numberParam(input, 'minimumSignalQuality')) {
    return { action: 'HOLD' as const, reason: '[filter:quality]|买点质量低于最低阈值', score };
  }

  const percent = allocationPercent(market, weekly.bullish, candidate.kind);
  if (percent <= 0) {
    return { action: 'HOLD' as const, reason: '[filter:allocation]|当前大盘趋势强度不足，不允许新开仓', score };
  }

  return {
    action: 'BUY' as const,
    amount: { unit: 'percent' as const, value: percent },
    reason: `${candidate.reason}|support=${candidate.supportPrice.toFixed(4)}|point=${candidate.pointDate}${candidate.hubUpper !== null ? `|hub=${candidate.hubUpper.toFixed(4)}` : ''}|周线${weekly.freshB3 ? '含近端三买' : '多头结构'}，日线 MA20 上行，大盘强度 ${market.score.toFixed(1)}，数据源 ${market.source === 'benchmark' ? '沪深300' : '个股趋势回退'}，仓位 ${percent}%`,
    confidence: candidate.quality,
    score,
  };
}

export const chanlunWeeklyDailyThermometerStrategy: UserStrategyDefinition = {
  id: 'chanlun-weekly-daily-thermometer',
  name: '缠论周线日线趋势',
  description: '周线只用已完成周线确认多头，日线只在确认的缠论买点右侧入场，优先级为三买、二买、一买；一买和二买仅在市场趋势稳定时启用。B3 必须由突破中枢的放量笔确认，收盘连续回到中枢内即离场；仓位按沪深300趋势强度分档，并使用随浮盈收紧的 ATR 动态止盈、结构止损和周日线卖点退出。所有判断只使用当前回测日及之前的数据。',
  defaultSelected: false,
  requiresChanLun: true,
  params: [
    { key: 'maxSignalAge', label: '买点确认后最大等待交易日', type: 'number', defaultValue: DEFAULTS.maxSignalAge, min: 0, max: 30, step: 1 },
    { key: 'minBreakoutVolumeRatio', label: '突破笔量能 / 20 日均量倍数', type: 'number', defaultValue: DEFAULTS.minBreakoutVolumeRatio, min: 1, max: 5, step: 0.1 },
    { key: 'hubReturnBars', label: '回到中枢连续收盘根数', type: 'number', defaultValue: DEFAULTS.hubReturnBars, min: 1, max: 10, step: 1 },
    { key: 'maxRsi', label: '买入 RSI 上限', type: 'number', defaultValue: DEFAULTS.maxRsi, min: 50, max: 90, step: 1 },
    { key: 'maxDistanceFromMa20Percent', label: '距 MA20 最大涨幅 (%)', type: 'number', defaultValue: DEFAULTS.maxDistanceFromMa20Percent, min: 2, max: 30, step: 1 },
    { key: 'minRelativeStrengthPercent', label: '20 日相对强度下限 (%)', type: 'number', defaultValue: DEFAULTS.minRelativeStrengthPercent, min: -30, max: 20, step: 1 },
    { key: 'minimumSignalQuality', label: '最低买点质量', type: 'number', defaultValue: DEFAULTS.minimumSignalQuality, min: 0.5, max: 0.99, step: 0.01 },
    { key: 'hardStopPercent', label: '收盘硬止损 (%)', type: 'number', defaultValue: DEFAULTS.hardStopPercent, min: 3, max: 25, step: 0.5 },
    { key: 'structureStopBufferPercent', label: '结构止损缓冲 (%)', type: 'number', defaultValue: DEFAULTS.structureStopBufferPercent, min: 0, max: 8, step: 0.5 },
    { key: 'trailingAtrMultiple', label: '移动止盈 ATR 倍数', type: 'number', defaultValue: DEFAULTS.trailingAtrMultiple, min: 2, max: 10, step: 0.5 },
    { key: 'trailingActivationPercent', label: '启动移动保护的最大浮盈 (%)', type: 'number', defaultValue: DEFAULTS.trailingActivationPercent, min: 5, max: 50, step: 1 },
    { key: 'maxHoldingBars', label: '最长持有交易日', type: 'number', defaultValue: DEFAULTS.maxHoldingBars, min: 10, max: 250, step: 5 },
    { key: 'timeStopMinReturnPercent', label: '时间止损最低收益 (%)', type: 'number', defaultValue: DEFAULTS.timeStopMinReturnPercent, min: -10, max: 20, step: 1 },
  ],
  decide: decision,
};
