import type { Hub, Kline } from '../../types/stock';
import type {
  BacktestTradeSnapshot,
  StrategyParamValue,
  UserStrategyDefinition,
} from '../../types/strategy';

interface StrategyConfig {
  volumeLookback: number;
  breakoutVolumeMultiplier: number;
  minBreakoutBodyRatio: number;
  maxBreakoutUpperShadowRatio: number;
  minBreakoutCloseAboveHubPct: number;
  minShrinkBars: number;
  maxPullbackBars: number;
  supportTolerancePct: number;
  maxEntryDistanceFromHubPct: number;
  maxPullbackDistanceFromHubPct: number;
  pullbackVolumeVsBreakout: number;
  baseBuyPercent: number;
  strongBuyPercent: number;
  hardStopLossPct: number;
  structuralStopBufferPct: number;
  atrPeriod: number;
  atrStopMultiplier: number;
  trailingActivationPct: number;
  firstTakeProfitPct: number;
  strongTakeProfitPct: number;
  maxHoldBars: number;
  timeStopMinProfitPct: number;
}

interface PullbackSetup {
  hub: Hub;
  breakoutIndex: number;
  pullbackBars: number;
  volumeRatio: number;
  bodyRatio: number;
  shrinkBars: number;
  score: number;
}

const DEFAULT_CONFIG: StrategyConfig = {
  volumeLookback: 20,
  breakoutVolumeMultiplier: 1.6,
  minBreakoutBodyRatio: 0.58,
  maxBreakoutUpperShadowRatio: 0.22,
  minBreakoutCloseAboveHubPct: 0.8,
  minShrinkBars: 3,
  maxPullbackBars: 10,
  supportTolerancePct: 0.6,
  maxEntryDistanceFromHubPct: 5,
  maxPullbackDistanceFromHubPct: 4.5,
  pullbackVolumeVsBreakout: 0.85,
  baseBuyPercent: 82,
  strongBuyPercent: 98,
  hardStopLossPct: 5.5,
  structuralStopBufferPct: 0.8,
  atrPeriod: 14,
  atrStopMultiplier: 2.6,
  trailingActivationPct: 6,
  firstTakeProfitPct: 14,
  strongTakeProfitPct: 28,
  maxHoldBars: 45,
  timeStopMinProfitPct: 1.5,
};

function numberParam(
  params: Readonly<Record<string, StrategyParamValue>>,
  key: keyof StrategyConfig,
  fallback: number,
): number {
  const value = params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function configFromParams(params: Readonly<Record<string, StrategyParamValue>>): StrategyConfig {
  return {
    volumeLookback: Math.round(numberParam(params, 'volumeLookback', DEFAULT_CONFIG.volumeLookback)),
    breakoutVolumeMultiplier: numberParam(params, 'breakoutVolumeMultiplier', DEFAULT_CONFIG.breakoutVolumeMultiplier),
    minBreakoutBodyRatio: numberParam(params, 'minBreakoutBodyRatio', DEFAULT_CONFIG.minBreakoutBodyRatio),
    maxBreakoutUpperShadowRatio: numberParam(
      params,
      'maxBreakoutUpperShadowRatio',
      DEFAULT_CONFIG.maxBreakoutUpperShadowRatio,
    ),
    minBreakoutCloseAboveHubPct: numberParam(
      params,
      'minBreakoutCloseAboveHubPct',
      DEFAULT_CONFIG.minBreakoutCloseAboveHubPct,
    ),
    minShrinkBars: Math.round(numberParam(params, 'minShrinkBars', DEFAULT_CONFIG.minShrinkBars)),
    maxPullbackBars: Math.round(numberParam(params, 'maxPullbackBars', DEFAULT_CONFIG.maxPullbackBars)),
    supportTolerancePct: numberParam(params, 'supportTolerancePct', DEFAULT_CONFIG.supportTolerancePct),
    maxEntryDistanceFromHubPct: numberParam(
      params,
      'maxEntryDistanceFromHubPct',
      DEFAULT_CONFIG.maxEntryDistanceFromHubPct,
    ),
    maxPullbackDistanceFromHubPct: numberParam(
      params,
      'maxPullbackDistanceFromHubPct',
      DEFAULT_CONFIG.maxPullbackDistanceFromHubPct,
    ),
    pullbackVolumeVsBreakout: numberParam(
      params,
      'pullbackVolumeVsBreakout',
      DEFAULT_CONFIG.pullbackVolumeVsBreakout,
    ),
    baseBuyPercent: numberParam(params, 'baseBuyPercent', DEFAULT_CONFIG.baseBuyPercent),
    strongBuyPercent: numberParam(params, 'strongBuyPercent', DEFAULT_CONFIG.strongBuyPercent),
    hardStopLossPct: numberParam(params, 'hardStopLossPct', DEFAULT_CONFIG.hardStopLossPct),
    structuralStopBufferPct: numberParam(
      params,
      'structuralStopBufferPct',
      DEFAULT_CONFIG.structuralStopBufferPct,
    ),
    atrPeriod: Math.round(numberParam(params, 'atrPeriod', DEFAULT_CONFIG.atrPeriod)),
    atrStopMultiplier: numberParam(params, 'atrStopMultiplier', DEFAULT_CONFIG.atrStopMultiplier),
    trailingActivationPct: numberParam(params, 'trailingActivationPct', DEFAULT_CONFIG.trailingActivationPct),
    firstTakeProfitPct: numberParam(params, 'firstTakeProfitPct', DEFAULT_CONFIG.firstTakeProfitPct),
    strongTakeProfitPct: numberParam(params, 'strongTakeProfitPct', DEFAULT_CONFIG.strongTakeProfitPct),
    maxHoldBars: Math.round(numberParam(params, 'maxHoldBars', DEFAULT_CONFIG.maxHoldBars)),
    timeStopMinProfitPct: numberParam(params, 'timeStopMinProfitPct', DEFAULT_CONFIG.timeStopMinProfitPct),
  };
}

function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function averageVolume(klines: readonly Kline[], start: number, endExclusive: number): number | null {
  const safeStart = Math.max(0, start);
  const safeEnd = Math.min(klines.length, endExclusive);
  if (safeEnd <= safeStart) return null;
  return average(klines.slice(safeStart, safeEnd).map((kline) => kline.volume));
}

function candleRange(kline: Kline): number {
  return Math.max(kline.high - kline.low, kline.close * 0.001, 0.0001);
}

function bullishBodyRatio(kline: Kline): number {
  const body = kline.close - kline.open;
  if (body <= 0) return 0;
  return body / candleRange(kline);
}

function upperShadowRatio(kline: Kline): number {
  return Math.max(0, kline.high - Math.max(kline.open, kline.close)) / candleRange(kline);
}

function smaClose(klines: readonly Kline[], endIndex: number, period: number): number | null {
  if (endIndex < 0) return null;
  const start = Math.max(0, endIndex - period + 1);
  return average(klines.slice(start, endIndex + 1).map((kline) => kline.close));
}

function trueRange(klines: readonly Kline[], index: number): number {
  const current = klines[index];
  const previous = index > 0 ? klines[index - 1] : null;
  if (!previous) return current.high - current.low;
  return Math.max(
    current.high - current.low,
    Math.abs(current.high - previous.close),
    Math.abs(current.low - previous.close),
  );
}

function atr(klines: readonly Kline[], endIndex: number, period: number): number | null {
  if (endIndex <= 0) return null;
  const start = Math.max(1, endIndex - period + 1);
  const ranges: number[] = [];
  for (let i = start; i <= endIndex; i++) {
    ranges.push(trueRange(klines, i));
  }
  return average(ranges);
}

function highestHigh(klines: readonly Kline[], startIndex: number, endIndex: number): number {
  let highest = -Infinity;
  for (let i = Math.max(0, startIndex); i <= endIndex; i++) {
    highest = Math.max(highest, klines[i].high);
  }
  return Number.isFinite(highest) ? highest : klines[endIndex]?.high ?? 0;
}

function findIndexByDate(klines: readonly Kline[], date: string): number {
  return klines.findIndex((kline) => kline.date === date);
}

function lastTradeIndex(
  klines: readonly Kline[],
  trades: readonly BacktestTradeSnapshot[],
  action?: BacktestTradeSnapshot['action'],
): number {
  for (let i = trades.length - 1; i >= 0; i--) {
    if (action && trades[i].action !== action) continue;
    const index = findIndexByDate(klines, trades[i].date);
    if (index >= 0) return index;
  }
  return -1;
}

function lastOpenBuyTrade(trades: readonly BacktestTradeSnapshot[]): BacktestTradeSnapshot | null {
  for (let i = trades.length - 1; i >= 0; i--) {
    if (trades[i].action === 'BUY') return trades[i];
    if (trades[i].action === 'SELL') return null;
  }
  return null;
}

function isQualityBreakout(
  klines: readonly Kline[],
  index: number,
  hub: Hub,
  config: StrategyConfig,
): { pass: boolean; volumeRatio: number; bodyRatio: number } {
  const kline = klines[index];
  const avgVol = averageVolume(klines, index - config.volumeLookback, index);
  if (!avgVol || avgVol <= 0) return { pass: false, volumeRatio: 0, bodyRatio: 0 };

  const volumeRatio = kline.volume / avgVol;
  const bodyRatio = bullishBodyRatio(kline);
  const closeAboveHub = kline.close > hub.zg * (1 + config.minBreakoutCloseAboveHubPct / 100);

  const pass =
    kline.close > kline.open &&
    closeAboveHub &&
    volumeRatio >= config.breakoutVolumeMultiplier &&
    bodyRatio >= config.minBreakoutBodyRatio &&
    upperShadowRatio(kline) <= config.maxBreakoutUpperShadowRatio;

  return { pass, volumeRatio, bodyRatio };
}

function countTrailingShrinkBars(
  klines: readonly Kline[],
  breakoutIndex: number,
  currentIndex: number,
  config: StrategyConfig,
): number {
  const breakoutVolume = klines[breakoutIndex].volume;
  let count = 0;

  for (let i = currentIndex; i > breakoutIndex; i--) {
    const previousVolume = i === breakoutIndex + 1 ? breakoutVolume : klines[i - 1].volume;
    const lowerThanBreakout = klines[i].volume <= breakoutVolume * config.pullbackVolumeVsBreakout;
    const notExpanding = klines[i].volume <= previousVolume * 1.06;

    if (!lowerThanBreakout || !notExpanding) break;
    count++;
  }

  return count;
}

function hasValidPullback(
  klines: readonly Kline[],
  hub: Hub,
  breakoutIndex: number,
  currentIndex: number,
  config: StrategyConfig,
): boolean {
  const supportFloor = hub.zg * (1 - config.supportTolerancePct / 100);
  const nearSupport = hub.zg * (1 + config.maxPullbackDistanceFromHubPct / 100);
  let touchedNearSupport = false;

  for (let i = breakoutIndex + 1; i <= currentIndex; i++) {
    const kline = klines[i];
    if (kline.low < supportFloor || kline.close < supportFloor) return false;
    if (kline.low <= nearSupport) touchedNearSupport = true;
  }

  const current = klines[currentIndex];
  const previous = klines[currentIndex - 1];
  const entryCeiling = hub.zg * (1 + config.maxEntryDistanceFromHubPct / 100);
  const currentHeldAboveHub = current.close >= hub.zg;
  const notChasing = current.close <= entryCeiling;
  const stabilized =
    current.close >= current.open ||
    current.close >= previous.close ||
    current.low <= nearSupport;

  return touchedNearSupport && currentHeldAboveHub && notChasing && stabilized;
}

function scoreSetup(
  klines: readonly Kline[],
  hub: Hub,
  breakoutIndex: number,
  currentIndex: number,
  volumeRatio: number,
  bodyRatio: number,
  shrinkBars: number,
  config: StrategyConfig,
): number {
  const current = klines[currentIndex];
  const pullbackVolumes = klines.slice(breakoutIndex + 1, currentIndex + 1).map((kline) => kline.volume);
  const avgPullbackVolume = average(pullbackVolumes) ?? klines[breakoutIndex].volume;
  const shrinkQuality = 1 - Math.min(1, avgPullbackVolume / Math.max(1, klines[breakoutIndex].volume));
  const entryDistancePct = Math.max(0, ((current.close - hub.zg) / hub.zg) * 100);
  const entryQuality = 1 - Math.min(1, entryDistancePct / Math.max(0.1, config.maxEntryDistanceFromHubPct));
  const ma20 = smaClose(klines, currentIndex, 20);
  const ma60 = smaClose(klines, currentIndex, 60);
  const trendBonus = ma20 !== null && ma60 !== null && current.close > ma20 && ma20 > ma60 ? 0.12 : 0;

  return (
    Math.min(0.28, (volumeRatio / Math.max(1, config.breakoutVolumeMultiplier)) * 0.12) +
    Math.min(0.22, bodyRatio * 0.22) +
    Math.min(0.18, shrinkQuality * 0.18) +
    Math.min(0.18, entryQuality * 0.18) +
    Math.min(0.12, (shrinkBars / Math.max(1, config.minShrinkBars)) * 0.08) +
    trendBonus
  );
}

function findBestPullbackSetup(
  klines: readonly Kline[],
  hubs: readonly Hub[],
  config: StrategyConfig,
  lastExitIndex: number,
): PullbackSetup | null {
  const currentIndex = klines.length - 1;
  let best: PullbackSetup | null = null;

  for (let h = hubs.length - 1; h >= 0; h--) {
    const hub = hubs[h];
    if (hub.zg <= 0 || hub.endIndex >= currentIndex - config.minShrinkBars) continue;

    const earliestBreakout = Math.max(hub.endIndex + 1, lastExitIndex + 1);
    const latestBreakout = currentIndex - config.minShrinkBars;

    for (let breakoutIndex = latestBreakout; breakoutIndex >= earliestBreakout; breakoutIndex--) {
      const pullbackBars = currentIndex - breakoutIndex;
      if (pullbackBars < config.minShrinkBars || pullbackBars > config.maxPullbackBars) continue;

      const breakout = isQualityBreakout(klines, breakoutIndex, hub, config);
      if (!breakout.pass) continue;

      const shrinkBars = countTrailingShrinkBars(klines, breakoutIndex, currentIndex, config);
      if (shrinkBars < config.minShrinkBars) continue;
      if (!hasValidPullback(klines, hub, breakoutIndex, currentIndex, config)) continue;

      const score = scoreSetup(
        klines,
        hub,
        breakoutIndex,
        currentIndex,
        breakout.volumeRatio,
        breakout.bodyRatio,
        shrinkBars,
        config,
      );

      const candidate: PullbackSetup = {
        hub,
        breakoutIndex,
        pullbackBars,
        volumeRatio: breakout.volumeRatio,
        bodyRatio: breakout.bodyRatio,
        shrinkBars,
        score,
      };

      if (!best || candidate.score > best.score || candidate.breakoutIndex > best.breakoutIndex) {
        best = candidate;
      }
    }
  }

  return best;
}

function findEntryHub(hubs: readonly Hub[], entryIndex: number): Hub | null {
  let best: Hub | null = null;
  for (const hub of hubs) {
    if (hub.endIndex < entryIndex && (!best || hub.endIndex > best.endIndex)) {
      best = hub;
    }
  }
  return best;
}

function exhaustionSignal(
  klines: readonly Kline[],
  currentIndex: number,
  config: StrategyConfig,
): boolean {
  const current = klines[currentIndex];
  const avgVol = averageVolume(klines, currentIndex - config.volumeLookback, currentIndex);
  if (!avgVol || avgVol <= 0) return false;

  const heavyVolume = current.volume >= avgVol * 1.55;
  const longUpperShadow = upperShadowRatio(current) >= 0.38;
  const bearishHighVolume = current.close < current.open && current.volume >= avgVol * 1.35;

  return (heavyVolume && longUpperShadow) || bearishHighVolume;
}

export const chanlunVolumePullbackStrategy: UserStrategyDefinition = {
  id: 'chanlun-volume-pullback',
  name: '缠论放量离开回踩',
  description:
    '中枢放量阳线离开后，等待不破中枢上轨且连续缩量三根以上的回踩买点，并用结构止损、ATR移动止盈和放量衰竭信号动态退出。',
  defaultSelected: true,
  requiresChanLun: true,
  params: [
    { key: 'volumeLookback', label: '量能均值周期', type: 'number', defaultValue: DEFAULT_CONFIG.volumeLookback, min: 5, max: 60, step: 1 },
    { key: 'breakoutVolumeMultiplier', label: '离开段放量倍数', type: 'number', defaultValue: DEFAULT_CONFIG.breakoutVolumeMultiplier, min: 1, max: 4, step: 0.1 },
    { key: 'minBreakoutBodyRatio', label: '阳线实体占比', type: 'number', defaultValue: DEFAULT_CONFIG.minBreakoutBodyRatio, min: 0.35, max: 0.9, step: 0.01 },
    { key: 'maxBreakoutUpperShadowRatio', label: '最大上影占比', type: 'number', defaultValue: DEFAULT_CONFIG.maxBreakoutUpperShadowRatio, min: 0.05, max: 0.5, step: 0.01 },
    { key: 'minBreakoutCloseAboveHubPct', label: '突破中枢上轨幅度%', type: 'number', defaultValue: DEFAULT_CONFIG.minBreakoutCloseAboveHubPct, min: 0, max: 5, step: 0.1 },
    { key: 'minShrinkBars', label: '连续缩量K线数', type: 'number', defaultValue: DEFAULT_CONFIG.minShrinkBars, min: 3, max: 8, step: 1 },
    { key: 'maxPullbackBars', label: '最长回踩天数', type: 'number', defaultValue: DEFAULT_CONFIG.maxPullbackBars, min: 3, max: 20, step: 1 },
    { key: 'supportTolerancePct', label: '中枢上轨容错%', type: 'number', defaultValue: DEFAULT_CONFIG.supportTolerancePct, min: 0, max: 3, step: 0.1 },
    { key: 'maxEntryDistanceFromHubPct', label: '买入距上轨上限%', type: 'number', defaultValue: DEFAULT_CONFIG.maxEntryDistanceFromHubPct, min: 1, max: 15, step: 0.5 },
    { key: 'maxPullbackDistanceFromHubPct', label: '回踩接近上轨%', type: 'number', defaultValue: DEFAULT_CONFIG.maxPullbackDistanceFromHubPct, min: 1, max: 12, step: 0.5 },
    { key: 'pullbackVolumeVsBreakout', label: '回踩量/突破量上限', type: 'number', defaultValue: DEFAULT_CONFIG.pullbackVolumeVsBreakout, min: 0.4, max: 1, step: 0.05 },
    { key: 'baseBuyPercent', label: '基础仓位%', type: 'number', defaultValue: DEFAULT_CONFIG.baseBuyPercent, min: 10, max: 100, step: 1 },
    { key: 'strongBuyPercent', label: '强信号仓位%', type: 'number', defaultValue: DEFAULT_CONFIG.strongBuyPercent, min: 10, max: 100, step: 1 },
    { key: 'hardStopLossPct', label: '硬止损%', type: 'number', defaultValue: DEFAULT_CONFIG.hardStopLossPct, min: 2, max: 15, step: 0.5 },
    { key: 'structuralStopBufferPct', label: '结构止损缓冲%', type: 'number', defaultValue: DEFAULT_CONFIG.structuralStopBufferPct, min: 0, max: 3, step: 0.1 },
    { key: 'atrPeriod', label: 'ATR周期', type: 'number', defaultValue: DEFAULT_CONFIG.atrPeriod, min: 5, max: 30, step: 1 },
    { key: 'atrStopMultiplier', label: 'ATR移动止盈倍数', type: 'number', defaultValue: DEFAULT_CONFIG.atrStopMultiplier, min: 1, max: 5, step: 0.1 },
    { key: 'trailingActivationPct', label: '移动止盈启动%', type: 'number', defaultValue: DEFAULT_CONFIG.trailingActivationPct, min: 2, max: 20, step: 0.5 },
    { key: 'firstTakeProfitPct', label: '首段止盈阈值%', type: 'number', defaultValue: DEFAULT_CONFIG.firstTakeProfitPct, min: 5, max: 40, step: 1 },
    { key: 'strongTakeProfitPct', label: '强势止盈阈值%', type: 'number', defaultValue: DEFAULT_CONFIG.strongTakeProfitPct, min: 10, max: 80, step: 1 },
    { key: 'maxHoldBars', label: '最长持仓天数', type: 'number', defaultValue: DEFAULT_CONFIG.maxHoldBars, min: 10, max: 120, step: 1 },
    { key: 'timeStopMinProfitPct', label: '时间止损最低收益%', type: 'number', defaultValue: DEFAULT_CONFIG.timeStopMinProfitPct, min: -5, max: 10, step: 0.5 },
  ],
  decide({ klines, currentKline, position, trades, params, chanlun }) {
    const currentIndex = klines.length - 1;
    const config = configFromParams(params);

    if (currentIndex < config.volumeLookback + config.minShrinkBars + 1 || !chanlun?.hubs?.length) {
      return { action: 'HOLD', reason: 'Insufficient ChanLun or volume history' };
    }

    if (position.shares > 0) {
      const entryTrade = lastOpenBuyTrade(trades);
      const entryIndex = entryTrade ? findIndexByDate(klines, entryTrade.date) : -1;
      const barsHeld = entryIndex >= 0 ? currentIndex - entryIndex : 0;
      const averageCost = position.averageCost > 0 ? position.averageCost : currentKline.close;
      const profitPct = ((currentKline.close - averageCost) / averageCost) * 100;
      const maxHigh = highestHigh(klines, Math.max(0, entryIndex), currentIndex);
      const maxProfitPct = ((maxHigh - averageCost) / averageCost) * 100;
      const entryHub = entryIndex >= 0 ? findEntryHub(chanlun.hubs, entryIndex) : null;
      const hardStop = averageCost * (1 - config.hardStopLossPct / 100);
      const structuralStop = entryHub
        ? entryHub.zg * (1 - config.structuralStopBufferPct / 100)
        : hardStop;
      const stopPrice = Math.max(hardStop, structuralStop);

      if (currentKline.close <= stopPrice) {
        return {
          action: 'SELL',
          amount: { unit: 'percent', value: 100 },
          reason: `Dynamic stop: close ${currentKline.close.toFixed(2)} <= ${stopPrice.toFixed(2)}`,
          confidence: 0.95,
        };
      }

      if (maxProfitPct >= config.trailingActivationPct) {
        const currentAtr = atr(klines, currentIndex, config.atrPeriod);
        const atrStop = currentAtr ? maxHigh - currentAtr * config.atrStopMultiplier : hardStop;
        let lockedProfitPct = 0;
        if (maxProfitPct >= config.strongTakeProfitPct) {
          lockedProfitPct = Math.max(config.firstTakeProfitPct, maxProfitPct * 0.48);
        } else if (maxProfitPct >= config.firstTakeProfitPct) {
          lockedProfitPct = Math.max(config.trailingActivationPct * 0.45, maxProfitPct * 0.34);
        } else {
          lockedProfitPct = 1.2;
        }
        const profitLockStop = averageCost * (1 + lockedProfitPct / 100);
        const dynamicStop = Math.max(stopPrice, atrStop, profitLockStop);

        if (currentKline.close <= dynamicStop) {
          return {
            action: 'SELL',
            amount: { unit: 'percent', value: 100 },
            reason: `Trailing take-profit: max profit ${maxProfitPct.toFixed(1)}%, stop ${dynamicStop.toFixed(2)}`,
            confidence: 0.9,
          };
        }
      }

      if (profitPct >= config.firstTakeProfitPct && exhaustionSignal(klines, currentIndex, config)) {
        return {
          action: 'SELL',
          amount: { unit: 'percent', value: 100 },
          reason: `Volume exhaustion after ${profitPct.toFixed(1)}% profit`,
          confidence: 0.86,
        };
      }

      const ma10 = smaClose(klines, currentIndex, 10);
      const ma20 = smaClose(klines, currentIndex, 20);
      if (
        profitPct > 0 &&
        ma10 !== null &&
        ma20 !== null &&
        currentKline.close < ma20 &&
        ma10 < ma20
      ) {
        return {
          action: 'SELL',
          amount: { unit: 'percent', value: 100 },
          reason: `Trend exit: close below MA20 with ${profitPct.toFixed(1)}% profit`,
          confidence: 0.78,
        };
      }

      if (barsHeld >= config.maxHoldBars && profitPct < config.timeStopMinProfitPct) {
        return {
          action: 'SELL',
          amount: { unit: 'percent', value: 100 },
          reason: `Time stop: ${barsHeld} bars held, profit ${profitPct.toFixed(1)}%`,
          confidence: 0.72,
        };
      }

      return { action: 'HOLD', reason: `Holding, profit ${profitPct.toFixed(1)}%` };
    }

    const lastExitIndex = lastTradeIndex(klines, trades, 'SELL');
    const setup = findBestPullbackSetup(klines, chanlun.hubs, config, lastExitIndex);

    if (!setup) {
      return { action: 'HOLD', reason: 'No qualified hub breakout and shrinking-volume pullback' };
    }

    const buyPercent = setup.score >= 0.72 ? config.strongBuyPercent : config.baseBuyPercent;

    return {
      action: 'BUY',
      amount: { unit: 'percent', value: Math.max(1, Math.min(100, buyPercent)) },
      reason:
        `Hub pullback buy: breakout vol ${setup.volumeRatio.toFixed(2)}x, ` +
        `body ${(setup.bodyRatio * 100).toFixed(0)}%, shrink ${setup.shrinkBars} bars, ` +
        `pullback ${setup.pullbackBars} bars, score ${setup.score.toFixed(2)}`,
      confidence: Math.max(0.55, Math.min(0.95, setup.score)),
    };
  },
};
