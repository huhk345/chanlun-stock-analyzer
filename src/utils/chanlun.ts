import { Kline, MergedKline, Fraction, Stroke, Segment, Hub, BuySellPoint, BuySellSignalType } from '../types/stock';

/**
 * Step 1: Combine overlapping K-lines (包含关系处理)
 * Upward containment: Merged high = max(H1, H2), Merged low = max(L1, L2)
 * Downward containment: Merged high = min(H1, H2), Merged low = min(L1, L2)
 */
export function mergeKlines(klines: Kline[]): MergedKline[] {
  if (klines.length === 0) return [];

  const merged: MergedKline[] = [];
  
  // Initialize with first K-line
  merged.push({
    high: klines[0].high,
    low: klines[0].low,
    direction: 'up',
    originalIndices: [0],
    originalHigh: klines[0].high,
    originalLow: klines[0].low
  });

  for (let i = 1; i < klines.length; i++) {
    const k = klines[i];
    let last = merged[merged.length - 1];
    
    // Check if there is containment
    const lastContainsCurrent = (last.high >= k.high && last.low <= k.low);
    const currentContainsLast = (k.high >= last.high && k.low <= last.low);
    
    if (lastContainsCurrent || currentContainsLast) {
      // Determine the direction of the merge
      let direction: 'up' | 'down' = 'up';
      if (merged.length > 1) {
        const prev = merged[merged.length - 2];
        if (last.high > prev.high) {
          direction = 'up';
        } else if (last.high < prev.high) {
          direction = 'down';
        } else {
          direction = last.direction;
        }
      } else {
        direction = last.direction;
      }

      // Merge based on direction
      let newHigh: number;
      let newLow: number;
      
      if (direction === 'up') {
        newHigh = Math.max(last.high, k.high);
        newLow = Math.max(last.low, k.low);
      } else {
        newHigh = Math.min(last.high, k.high);
        newLow = Math.min(last.low, k.low);
      }

      // Update the last merged candle in place
      last.high = newHigh;
      last.low = newLow;
      last.direction = direction;
      last.originalIndices.push(i);
      last.originalHigh = Math.max(last.originalHigh, k.high);
      last.originalLow = Math.min(last.originalLow, k.low);
    } else {
      // Determine next direction
      const nextDir: 'up' | 'down' = k.high > last.high ? 'up' : 'down';
      merged.push({
        high: k.high,
        low: k.low,
        direction: nextDir,
        originalIndices: [i],
        originalHigh: k.high,
        originalLow: k.low
      });
    }
  }

  return merged;
}

/**
 * Step 2: Identify Fractions (分型 - 顶/底分型)
 */
export function findFractions(merged: MergedKline[], original: Kline[]): Fraction[] {
  const fractions: Fraction[] = [];

  for (let i = 1; i < merged.length - 1; i++) {
    const prev = merged[i - 1];
    const curr = merged[i];
    const next = merged[i + 1];

    const isTop = curr.high > prev.high && curr.high > next.high &&
                  curr.low > prev.low && curr.low > next.low;
                  
    const isBottom = curr.low < prev.low && curr.low < next.low &&
                     curr.high < prev.high && curr.high < next.high;

    if (isTop) {
      // Find the absolute highest index of original candlestick in this merged index
      const highestOrigIndex = curr.originalIndices.reduce((best, idx) => {
        return original[idx].high > original[best].high ? idx : best;
      }, curr.originalIndices[0]);

      fractions.push({
        type: 'TOP',
        price: original[highestOrigIndex].high,
        index: i,
        originalIndex: highestOrigIndex,
        date: original[highestOrigIndex].date
      });
    } else if (isBottom) {
      // Find the absolute lowest index of original candlestick in this merged index
      const lowestOrigIndex = curr.originalIndices.reduce((best, idx) => {
        return original[idx].low < original[best].low ? idx : best;
      }, curr.originalIndices[0]);

      fractions.push({
        type: 'BOTTOM',
        price: original[lowestOrigIndex].low,
        index: i,
        originalIndex: lowestOrigIndex,
        date: original[lowestOrigIndex].date
      });
    }
  }

  return fractions;
}

/**
 * 连接分型形成笔（两遍过滤法）
 * 与 Python _connect_fenxing_to_bi_like 逻辑一致
 */
function _connectFenxingToStroke(fractions: Fraction[], minDistance: number): Fraction[] {
  if (fractions.length < 2) return [];

  // 第一遍：贪心过滤，保持同类型取极值，异类型检查距离
  let biPoints: Fraction[] = [];
  for (const fx of fractions) {
    if (biPoints.length === 0) {
      biPoints.push(fx);
      continue;
    }
    const last = biPoints[biPoints.length - 1];
    if (fx.type === last.type) {
      if (last.type === 'TOP' && fx.price > last.price) {
        biPoints[biPoints.length - 1] = fx;
      } else if (last.type === 'BOTTOM' && fx.price < last.price) {
        biPoints[biPoints.length - 1] = fx;
      }
    } else {
      if (Math.abs(fx.index - last.index) >= minDistance) {
        biPoints.push(fx);
      }
    }
  }

  // 第二遍：再次过滤，确保结果严格交替
  const finalPoints: Fraction[] = [];
  for (const fx of biPoints) {
    if (finalPoints.length === 0) {
      finalPoints.push(fx);
      continue;
    }
    const last = finalPoints[finalPoints.length - 1];
    if (fx.type === last.type) {
      if ((fx.type === 'TOP' && fx.price > last.price) ||
          (fx.type === 'BOTTOM' && fx.price < last.price)) {
        finalPoints[finalPoints.length - 1] = fx;
      }
    } else {
      if (Math.abs(fx.index - last.index) >= minDistance) {
        finalPoints.push(fx);
      }
    }
  }

  return finalPoints;
}

/**
 * Step 3: Generate Strokes (画笔)
 * 使用两遍过滤法，匹配 Python identify_bi 逻辑
 */
export function calculateStrokes(fractions: Fraction[]): Stroke[] {
  const filteredPoints = _connectFenxingToStroke(fractions, 4);
  if (filteredPoints.length < 2) return [];

  const strokes: Stroke[] = [];
  for (let i = 0; i < filteredPoints.length - 1; i++) {
    const curr = filteredPoints[i];
    const nxt = filteredPoints[i + 1];

    if (curr.type === 'TOP' && nxt.type === 'BOTTOM') {
      strokes.push({
        id: `stroke-${curr.originalIndex}-${nxt.originalIndex}`,
        start: curr,
        end: nxt,
        direction: 'down'
      });
    } else if (curr.type === 'BOTTOM' && nxt.type === 'TOP') {
      strokes.push({
        id: `stroke-${curr.originalIndex}-${nxt.originalIndex}`,
        start: curr,
        end: nxt,
        direction: 'up'
      });
    }
  }

  return strokes;
}

/**
 * Step 4: Calculate Segments (线段)
 * 将笔视为K线，用笔的 end_price 判断分型，再连接成分型形成线段
 * 与 Python identify_segment 逻辑一致
 */
export function calculateSegments(strokes: Stroke[]): Segment[] {
  if (strokes.length < 3) return [];

  // 用笔的 end.price 作为 "close" 来判断分型（找到笔级别的高低点）
  const strokeFenxings: Fraction[] = [];
  for (let i = 1; i < strokes.length - 1; i++) {
    const prevPrice = strokes[i - 1].end.price;
    const currPrice = strokes[i].end.price;
    const nextPrice = strokes[i + 1].end.price;

    if (currPrice > prevPrice && currPrice > nextPrice) {
      // 顶分型（笔的终点是局部高点）
      strokeFenxings.push({
        type: 'TOP',
        price: Math.max(strokes[i].start.price, strokes[i].end.price),
        index: i,                              // 笔索引
        originalIndex: strokes[i].end.originalIndex, // 原始K线索引
        date: strokes[i].end.date
      });
    } else if (currPrice < prevPrice && currPrice < nextPrice) {
      // 底分型（笔的终点是局部低点）
      strokeFenxings.push({
        type: 'BOTTOM',
        price: Math.min(strokes[i].start.price, strokes[i].end.price),
        index: i,                              // 笔索引
        originalIndex: strokes[i].end.originalIndex, // 原始K线索引
        date: strokes[i].end.date
      });
    }
  }

  if (strokeFenxings.length < 2) return [];

  // 使用两遍过滤法连接分型（线段级别 minDistance=3）
  const segPoints = _connectFenxingToStroke(strokeFenxings, 3);
  if (segPoints.length < 2) return [];

  const segments: Segment[] = [];
  for (let i = 0; i < segPoints.length - 1; i++) {
    const curr = segPoints[i];
    const nxt = segPoints[i + 1];

    const startStroke = strokes[curr.index];
    const endStroke = strokes[nxt.index];

    let direction: 'up' | 'down';
    let startFraction: Fraction;
    let endFraction: Fraction;

    if (curr.type === 'TOP' && nxt.type === 'BOTTOM') {
      direction = 'down';
      // 顶分型作为起点：取笔的高点端点
      startFraction = startStroke.direction === 'down' ? startStroke.start : startStroke.end;
      // 底分型作为终点：取笔的低点端点
      endFraction = endStroke.direction === 'up' ? endStroke.start : endStroke.end;
    } else if (curr.type === 'BOTTOM' && nxt.type === 'TOP') {
      direction = 'up';
      // 底分型作为起点：取笔的低点端点
      startFraction = startStroke.direction === 'up' ? startStroke.start : startStroke.end;
      // 顶分型作为终点：取笔的高点端点
      endFraction = endStroke.direction === 'down' ? endStroke.start : endStroke.end;
    } else {
      continue;
    }

    segments.push({
      id: `segment-${startFraction.originalIndex}-${endFraction.originalIndex}`,
      start: startFraction,
      end: endFraction,
      direction
    });
  }

  return segments;
}

/**
 * Step 5: Identify Price Hubs (中枢)
 * 通用中枢识别：取连续三笔/线段的高低点重叠区间
 * ZG = min(三个高点), ZD = max(三个低点), GG = max(所有高点), DD = min(所有低点)
 * 与 Python _identify_zhongshu_generic 逻辑一致
 */
function _identifyHubsGeneric(lines: Stroke[], level: number): Hub[] {
  if (lines.length < 3) return [];

  const hubs: Hub[] = [];
  let i = 0;
  while (i <= lines.length - 3) {
    const l1 = lines[i];
    const l2 = lines[i + 1];
    const l3 = lines[i + 2];

    const l1High = Math.max(l1.start.price, l1.end.price);
    const l1Low = Math.min(l1.start.price, l1.end.price);
    const l2High = Math.max(l2.start.price, l2.end.price);
    const l2Low = Math.min(l2.start.price, l2.end.price);
    const l3High = Math.max(l3.start.price, l3.end.price);
    const l3Low = Math.min(l3.start.price, l3.end.price);

    const zg = Math.min(l1High, l2High, l3High);
    const zd = Math.max(l1Low, l2Low, l3Low);

    if (zg > zd) {
      // 有效中枢
      let gg = Math.max(l1High, l2High, l3High);
      let dd = Math.min(l1Low, l2Low, l3Low);
      let hubEndIndex = l3.end.originalIndex;
      let count = 3;

      // 扩展中枢：后续笔/线段与中枢区间重叠则纳入
      let j = i + 3;
      while (j < lines.length) {
        const nextLine = lines[j];
        const nextHigh = Math.max(nextLine.start.price, nextLine.end.price);
        const nextLow = Math.min(nextLine.start.price, nextLine.end.price);

        // 检查是否与中枢区间重叠
        if (nextHigh > zd && nextLow < zg) {
          hubEndIndex = nextLine.end.originalIndex;
          gg = Math.max(gg, nextHigh);
          dd = Math.min(dd, nextLow);
          count++;
          j++;
        } else {
          break;
        }
      }

      hubs.push({
        id: `hub-${l1.start.originalIndex}-${hubEndIndex}`,
        zg: parseFloat(zg.toFixed(2)),
        zd: parseFloat(zd.toFixed(2)),
        gg: parseFloat(gg.toFixed(2)),
        dd: parseFloat(dd.toFixed(2)),
        startIndex: l1.start.originalIndex,
        endIndex: hubEndIndex,
        strokesCount: count,
        level
      });

      i = j;
    } else {
      i++;
    }
  }

  return hubs;
}

export function calculateHubs(strokes: Stroke[]): Hub[] {
  return _identifyHubsGeneric(strokes, 1);
}

/**
 * 线段级别中枢（用线段代替笔）
 */
export function calculateSegmentHubs(segments: Segment[]): Hub[] {
  if (segments.length < 3) return [];
  // 将 Segment 转为 Stroke-like 接口用于通用中枢识别
  const segmentLines: Stroke[] = segments.map(seg => ({
    id: seg.id,
    start: seg.start,
    end: seg.end,
    direction: seg.direction
  }));
  return _identifyHubsGeneric(segmentLines, 2);
}

// ============================================================
// MACD / BOLL 数据接口（由 indicators.ts 计算后传入）
// ============================================================

export interface MACDData {
  dif: (number | null)[];
  dea: (number | null)[];
  histogram: (number | null)[];
}

export interface BOLLData {
  upper: (number | null)[];
  middle: (number | null)[];
  lower: (number | null)[];
}

// ============================================================
// MACD 背驰检测辅助函数
// ============================================================

/**
 * 计算MACD柱状图面积（指定区间内同色柱的绝对值累加）
 */
function calcHistogramArea(hist: (number | null)[], startIdx: number, endIdx: number): number {
  let area = 0;
  for (let i = startIdx; i <= endIdx && i < hist.length; i++) {
    const v = hist[i];
    if (v !== null && v !== undefined) {
      area += Math.abs(v);
    }
  }
  return area;
}

/**
 * 寻找指定位置之前最近的一个同向柱状图波峰区间
 * 返回 { start, end, area } 或 null
 */
function findPrevHistogramWave(hist: (number | null)[], currentIdx: number, direction: 'green' | 'red'): { start: number; end: number; area: number } | null {
  const sign = direction === 'green' ? 1 : -1;
  let i = currentIdx;
  // 跳过当前同色区域
  while (i >= 0 && hist[i] !== null && (sign > 0 ? (hist[i] as number) >= 0 : (hist[i] as number) <= 0)) {
    i--;
  }
  // 跳过异色区域
  while (i >= 0 && hist[i] !== null && (sign > 0 ? (hist[i] as number) < 0 : (hist[i] as number) > 0)) {
    i--;
  }
  // 找前一个同色波
  const waveEnd = i;
  while (i >= 0 && hist[i] !== null && (sign > 0 ? (hist[i] as number) >= 0 : (hist[i] as number) <= 0)) {
    i--;
  }
  const waveStart = i + 1;
  if (waveStart > waveEnd) return null;
  const area = calcHistogramArea(hist, waveStart, waveEnd);
  return { start: waveStart, end: waveEnd, area };
}

/**
 * 寻找当前柱状图波区间
 */
function findCurrentHistogramWave(hist: (number | null)[], currentIdx: number, direction: 'green' | 'red'): { start: number; end: number; area: number } | null {
  const sign = direction === 'green' ? 1 : -1;
  let i = currentIdx;
  // 往前找波头
  while (i > 0 && hist[i - 1] !== null && (sign > 0 ? (hist[i - 1] as number) >= 0 : (hist[i - 1] as number) <= 0)) {
    i--;
  }
  const start = i;
  let j = currentIdx;
  // 往后找波尾
  while (j < hist.length - 1 && hist[j + 1] !== null && (sign > 0 ? (hist[j + 1] as number) >= 0 : (hist[j + 1] as number) <= 0)) {
    j++;
  }
  const area = calcHistogramArea(hist, start, j);
  return { start, end: j, area };
}

/**
 * 检测MACD底背驰（一买辅助）
 * 条件：价格创新低，但MACD黄白线不创新低，且绿色柱面积收缩
 */
function checkMACDBottomDivergence(
  klines: Kline[],
  macd: MACDData,
  strokeEndIdx: number
): { hasDivergence: boolean; description: string } {
  const { dif, dea, histogram } = macd;
  if (strokeEndIdx < 10 || !dif[strokeEndIdx]) {
    return { hasDivergence: false, description: '' };
  }

  // 当前绿色柱波
  const currentWave = findCurrentHistogramWave(histogram, strokeEndIdx, 'green');
  if (!currentWave) return { hasDivergence: false, description: '' };

  // 前一个绿色柱波
  const prevWave = findPrevHistogramWave(histogram, strokeEndIdx, 'green');
  if (!prevWave) return { hasDivergence: false, description: '' };

  // 面积收缩判断
  const areaShrunk = currentWave.area < prevWave.area * 0.85;

  // 黄白线不创新低判断
  let prevDifMin = Infinity;
  for (let i = prevWave.start; i <= prevWave.end; i++) {
    if (dif[i] !== null && dif[i] !== undefined) prevDifMin = Math.min(prevDifMin, dif[i] as number);
  }
  let curDifMin = Infinity;
  for (let i = currentWave.start; i <= currentWave.end; i++) {
    if (dif[i] !== null && dif[i] !== undefined) curDifMin = Math.min(curDifMin, dif[i] as number);
  }
  const difNotNewLow = curDifMin > prevDifMin;

  let prevDeaMin = Infinity;
  for (let i = prevWave.start; i <= prevWave.end; i++) {
    if (dea[i] !== null && dea[i] !== undefined) prevDeaMin = Math.min(prevDeaMin, dea[i] as number);
  }
  let curDeaMin = Infinity;
  for (let i = currentWave.start; i <= currentWave.end; i++) {
    if (dea[i] !== null && dea[i] !== undefined) curDeaMin = Math.min(curDeaMin, dea[i] as number);
  }
  const deaNotNewLow = curDeaMin > prevDeaMin;

  const hasDivergence = areaShrunk && (difNotNewLow || deaNotNewLow);

  const descriptions: string[] = [];
  if (areaShrunk) descriptions.push(`绿柱面积收缩(${(currentWave.area / prevWave.area * 100).toFixed(0)}%)`);
  if (difNotNewLow) descriptions.push('DIF未创新低');
  if (deaNotNewLow) descriptions.push('DEA未创新低');

  return {
    hasDivergence,
    description: descriptions.join('，')
  };
}

/**
 * 检测MACD顶背驰（一卖辅助）
 * 条件：价格创新高，但MACD黄白线不创新高，且红色柱面积收缩
 */
function checkMACDTopDivergence(
  klines: Kline[],
  macd: MACDData,
  strokeEndIdx: number
): { hasDivergence: boolean; description: string } {
  const { dif, dea, histogram } = macd;
  if (strokeEndIdx < 10 || !dif[strokeEndIdx]) {
    return { hasDivergence: false, description: '' };
  }

  // 当前红色柱波
  const currentWave = findCurrentHistogramWave(histogram, strokeEndIdx, 'red');
  if (!currentWave) return { hasDivergence: false, description: '' };

  // 前一个红色柱波
  const prevWave = findPrevHistogramWave(histogram, strokeEndIdx, 'red');
  if (!prevWave) return { hasDivergence: false, description: '' };

  // 面积收缩
  const areaShrunk = currentWave.area < prevWave.area * 0.85;

  // 黄白线不创新高
  let prevDifMax = -Infinity;
  for (let i = prevWave.start; i <= prevWave.end; i++) {
    if (dif[i] !== null && dif[i] !== undefined) prevDifMax = Math.max(prevDifMax, dif[i] as number);
  }
  let curDifMax = -Infinity;
  for (let i = currentWave.start; i <= currentWave.end; i++) {
    if (dif[i] !== null && dif[i] !== undefined) curDifMax = Math.max(curDifMax, dif[i] as number);
  }
  const difNotNewHigh = curDifMax < prevDifMax;

  let prevDeaMax = -Infinity;
  for (let i = prevWave.start; i <= prevWave.end; i++) {
    if (dea[i] !== null && dea[i] !== undefined) prevDeaMax = Math.max(prevDeaMax, dea[i] as number);
  }
  let curDeaMax = -Infinity;
  for (let i = currentWave.start; i <= currentWave.end; i++) {
    if (dea[i] !== null && dea[i] !== undefined) curDeaMax = Math.max(curDeaMax, dea[i] as number);
  }
  const deaNotNewHigh = curDeaMax < prevDeaMax;

  const hasDivergence = areaShrunk && (difNotNewHigh || deaNotNewHigh);

  const descriptions: string[] = [];
  if (areaShrunk) descriptions.push(`红柱面积收缩(${(currentWave.area / prevWave.area * 100).toFixed(0)}%)`);
  if (difNotNewHigh) descriptions.push('DIF未创新高');
  if (deaNotNewHigh) descriptions.push('DEA未创新高');

  return {
    hasDivergence,
    description: descriptions.join('，')
  };
}

/**
 * 检测MACD双回试形态（二买辅助）
 * 条件：一买后价格上涨，DIF/DEA第一次放量站上0轴；
 *       随后价格回调，DIF/DEA回抽0轴附近并在0轴之上形成二次金叉或双脚支撑
 */
function checkMACDDoubleRetest(
  macd: MACDData,
  buy1Idx: number,
  currentIdx: number
): { hasDoubleRetest: boolean; description: string } {
  const { dif, dea } = macd;
  if (currentIdx - buy1Idx < 3) return { hasDoubleRetest: false, description: '' };

  // 检查一买后是否有DIF/DEA上穿0轴
  let crossedAbove = false;
  let crossAboveIdx = -1;
  for (let i = buy1Idx + 1; i <= currentIdx; i++) {
    if (dif[i] !== null && dea[i] !== null && dif[i] !== undefined && dea[i] !== undefined) {
      if ((dif[i] as number) > 0 && (dea[i] as number) > 0) {
        if (!crossedAbove) {
          crossedAbove = true;
          crossAboveIdx = i;
        }
      }
    }
  }
  if (!crossedAbove) return { hasDoubleRetest: false, description: '' };

  // 检查是否回抽0轴附近（DIF回抽到0轴附近但未跌破，或在0轴上方形成金叉）
  let retested = false;
  for (let i = crossAboveIdx + 1; i <= currentIdx; i++) {
    if (dif[i] !== null && dea[i] !== null && dif[i] !== undefined && dea[i] !== undefined) {
      const difVal = dif[i] as number;
      const deaVal = dea[i] as number;
      // DIF回抽到0轴附近但仍在0轴上方，或DIF在0轴上方上穿DEA（金叉）
      if ((Math.abs(difVal) < Math.abs(dif[crossAboveIdx] as number) * 0.3 && difVal > 0) ||
          (i > 0 && dif[i - 1] !== null && dea[i - 1] !== null &&
           (dif[i - 1] as number) < (dea[i - 1] as number) &&
           difVal > deaVal && difVal > 0)) {
        retested = true;
        break;
      }
    }
  }

  if (retested) {
    return { hasDoubleRetest: true, description: 'MACD双回试：黄白线站上0轴后回抽0轴附近形成支撑/金叉' };
  }
  return { hasDoubleRetest: false, description: '' };
}

/**
 * 检测MACD双回试形态（二卖辅助，镜像版）
 */
function checkMACDDoubleRetestSell(
  macd: MACDData,
  sell1Idx: number,
  currentIdx: number
): { hasDoubleRetest: boolean; description: string } {
  const { dif, dea } = macd;
  if (currentIdx - sell1Idx < 3) return { hasDoubleRetest: false, description: '' };

  // 检查一卖后是否有DIF/DEA跌破0轴
  let crossedBelow = false;
  let crossBelowIdx = -1;
  for (let i = sell1Idx + 1; i <= currentIdx; i++) {
    if (dif[i] !== null && dea[i] !== null && dif[i] !== undefined && dea[i] !== undefined) {
      if ((dif[i] as number) < 0 && (dea[i] as number) < 0) {
        if (!crossedBelow) {
          crossedBelow = true;
          crossBelowIdx = i;
        }
      }
    }
  }
  if (!crossedBelow) return { hasDoubleRetest: false, description: '' };

  // 检查是否反弹到0轴附近但未突破，或在0轴下方形成死叉
  let retested = false;
  for (let i = crossBelowIdx + 1; i <= currentIdx; i++) {
    if (dif[i] !== null && dea[i] !== null && dif[i] !== undefined && dea[i] !== undefined) {
      const difVal = dif[i] as number;
      const deaVal = dea[i] as number;
      if ((Math.abs(difVal) < Math.abs(dif[crossBelowIdx] as number) * 0.3 && difVal < 0) ||
          (i > 0 && dif[i - 1] !== null && dea[i - 1] !== null &&
           (dif[i - 1] as number) > (dea[i - 1] as number) &&
           difVal < deaVal && difVal < 0)) {
        retested = true;
        break;
      }
    }
  }

  if (retested) {
    return { hasDoubleRetest: true, description: 'MACD双回试：黄白线跌破0轴后反弹0轴附近形成压力/死叉' };
  }
  return { hasDoubleRetest: false, description: '' };
}

/**
 * 检测BOLL收口（三买/三卖辅助）
 * 条件：布林通道宽度收窄到近期的极小值
 */
function checkBOLLNarrowing(
  boll: BOLLData,
  currentIdx: number,
  lookback: number = 30
): { isNarrowing: boolean; description: string } {
  const { upper, lower } = boll;
  if (currentIdx < lookback || upper[currentIdx] === null || lower[currentIdx] === null) {
    return { isNarrowing: false, description: '' };
  }

  const currentWidth = (upper[currentIdx] as number) - (lower[currentIdx] as number);

  // 计算近期的平均带宽
  const widths: number[] = [];
  for (let i = currentIdx - lookback; i <= currentIdx; i++) {
    if (upper[i] !== null && lower[i] !== null) {
      widths.push((upper[i] as number) - (lower[i] as number));
    }
  }

  if (widths.length < 5) return { isNarrowing: false, description: '' };

  const avgWidth = widths.reduce((a, b) => a + b, 0) / widths.length;
  const minWidth = Math.min(...widths);

  // 当前带宽小于平均带宽的60%或等于近期最小带宽
  const isNarrowing = currentWidth < avgWidth * 0.6 || currentWidth <= minWidth * 1.05;

  return {
    isNarrowing,
    description: isNarrowing ? `BOLL收口：当前带宽为均值的${(currentWidth / avgWidth * 100).toFixed(0)}%` : ''
  };
}

/**
 * 判断中枢方向：通过中枢前后的走势判断是上涨趋势中枢还是下跌趋势中枢
 * 上涨趋势中枢：后中枢在前中枢之上
 * 下跌趋势中枢：后中枢在前中枢之下
 */
function getHubTrendDirection(hubs: Hub[], hubIndex: number, _strokes: Stroke[]): 'up' | 'down' | 'unknown' {
  if (hubIndex < 1) return 'unknown';
  const prevHub = hubs[hubIndex - 1];
  const currHub = hubs[hubIndex];

  // 比较两个中枢的位置关系（用中枢区间 zg/zd）
  if (currHub.zd > prevHub.zg) return 'up';   // 后中枢在前中枢之上 → 上涨趋势
  if (currHub.zg < prevHub.zd) return 'down'; // 后中枢在前中枢之下 → 下跌趋势

  // 部分重叠时，比较中枢中心
  const prevCenter = (prevHub.zg + prevHub.zd) / 2;
  const currCenter = (currHub.zg + currHub.zd) / 2;
  if (currCenter > prevCenter) return 'up';
  if (currCenter < prevCenter) return 'down';
  return 'unknown';
}

// ============================================================
// Step 6: 缠论三类买卖点判断
// ============================================================

/**
 * Step 6: 触发缠论三类买卖点
 *
 * 一买/一卖（趋势背驰点）：
 *   - 趋势前提：必须已形成至少两个同方向、同级别中枢的标准趋势
 *   - 力度对比：C段力度弱于B段（笔长度缩短 + 价格创新低/新高）
 *   - MACD辅助：价格创新低/新高，但黄白线不创新低/新高，柱面积收缩
 *
 * 二买/二卖（次级别回踩确认点）：
 *   - 一买后回调低点不破一买最低点 → 二买
 *   - 一卖后反弹高点不破一卖最高点 → 二卖
 *   - MACD双回试形态辅助确认
 *
 * 三买/三卖（中枢突破确认点）：
 *   - 放量突破中枢后，次级别回踩低点不跌回中枢（三买：回踩低点 > ZG）
 *   - 跌破中枢后，次级别反弹高点不回中枢（三卖：反弹高点 < ZD）
 *   - BOLL收口预判辅助
 */
export function calculateBuySellPoints(
  strokes: Stroke[],
  hubs: Hub[],
  klines?: Kline[],
  macd?: MACDData,
  boll?: BOLLData
): BuySellPoint[] {
  const points: BuySellPoint[] = [];
  if (strokes.length === 0) return [];

  // 预计算：每个中枢的趋势方向
  const hubTrendDirs = hubs.map((_, idx) => getHubTrendDirection(hubs, idx, strokes));

  for (let idx = 0; idx < strokes.length; idx++) {
    const str = strokes[idx];
    const endFrac = str.end;

    // 查找该笔之前的所有中枢（用于趋势前提判断）
    const hubsBeforeStroke = hubs.filter(h => h.endIndex < endFrac.originalIndex);

    if (str.direction === 'down') {
      // ==================== 买入点判断 ====================

      // ---------- 一买：趋势背驰点 ----------
      if (idx >= 2) {
        const prevDownStroke = strokes[idx - 2];
        if (prevDownStroke && prevDownStroke.direction === 'down') {
          const prvLen = Math.abs(prevDownStroke.start.price - prevDownStroke.end.price);
          const curLen = Math.abs(str.start.price - str.end.price);

          // 力度对比：C段（当前笔）力度弱于B段（前一同向笔）+ 价格创新低
          if (curLen < prvLen && endFrac.price < prevDownStroke.end.price) {
            // 趋势前提：检查是否有至少两个同向中枢
            const downTrendHubs = hubsBeforeStroke.filter((_, hi) => {
              // 在 hubsBeforeStroke 中查找对应的原始 hub 索引
              const originalIdx = hubs.indexOf(hubsBeforeStroke[hi]);
              return hubTrendDirs[originalIdx] === 'down';
            });
            const hasTrendPremise = downTrendHubs.length >= 2;

            // MACD底背驰辅助
            let macdDivergence = { hasDivergence: false, description: '' };
            if (macd && klines) {
              macdDivergence = checkMACDBottomDivergence(klines, macd, endFrac.originalIndex);
            }

            // 一买成立的条件：
            // 1. 有趋势前提（至少两个同向中枢） → 强一买
            // 2. 无趋势前提但有MACD背驰 → 弱一买（盘整背驰，需谨慎）
            // 3. 两者都有 → 最强信号
            const isStrongSignal = hasTrendPremise;
            const hasMACDConfirm = macdDivergence.hasDivergence;

            if (isStrongSignal || hasMACDConfirm) {
              const reasonParts = ['一买(趋势背驰)'];
              if (hasTrendPremise) reasonParts.push(`${downTrendHubs.length}个同向中枢`);
              if (curLen < prvLen) reasonParts.push(`力度收缩(${(curLen / prvLen * 100).toFixed(0)}%)`);
              if (hasMACDConfirm) reasonParts.push(macdDivergence.description);
              if (!hasTrendPremise) reasonParts.push('注意：无趋势前提(盘整背驰)');

              points.push({
                id: `bs-buy1-${endFrac.originalIndex}`,
                type: 'BUY_1',
                price: parseFloat(endFrac.price.toFixed(2)),
                originalIndex: endFrac.originalIndex,
                date: endFrac.date,
                reason: reasonParts.join(' | '),
                divergence: macdDivergence.hasDivergence ? {
                  hasMACDDivergence: true,
                  description: macdDivergence.description
                } : undefined,
                hasTrendPremise
              });
              continue;
            }
          }
        }
      }

      // ---------- 二买：次级别回踩确认点 ----------
      const buy1Points = points.filter(p => p.type === 'BUY_1');
      if (buy1Points.length > 0) {
        const lastBuy1 = buy1Points[buy1Points.length - 1];
        // 核心条件：回调低点不破一买最低点
        if (endFrac.originalIndex > lastBuy1.originalIndex && endFrac.price > lastBuy1.price) {
          // MACD双回试辅助
          let doubleRetest = { hasDoubleRetest: false, description: '' };
          if (macd) {
            doubleRetest = checkMACDDoubleRetest(macd, lastBuy1.originalIndex, endFrac.originalIndex);
          }

          const reasonParts = ['二买(回踩确认)'];
          reasonParts.push(`低点${endFrac.price.toFixed(2)}未破一买${lastBuy1.price.toFixed(2)}`);
          if (doubleRetest.hasDoubleRetest) reasonParts.push(doubleRetest.description);

          points.push({
            id: `bs-buy2-${endFrac.originalIndex}`,
            type: 'BUY_2',
            price: parseFloat(endFrac.price.toFixed(2)),
            originalIndex: endFrac.originalIndex,
            date: endFrac.date,
            reason: reasonParts.join(' | '),
            divergence: doubleRetest.hasDoubleRetest ? {
              hasMACDDivergence: true,
              description: doubleRetest.description
            } : undefined,
            hasTrendPremise: lastBuy1.hasTrendPremise
          });
          continue;
        }
      }

      // ---------- 三买：中枢突破确认点 ----------
      // 三买条件：突破中枢后，次级别回踩低点 > 中枢上沿(ZG)
      for (let hi = 0; hi < hubs.length; hi++) {
        const hub = hubs[hi];
        // 该笔在中枢之后，且回踩低点在中枢上沿之上
        if (endFrac.originalIndex > hub.endIndex && endFrac.price > hub.zg) {
          // 确认之前有向上突破中枢的动作（严格：突破笔必须从中枢内部或下沿开始，向上突破上沿）
          let hasBreakout = false;
          let breakoutHighPrice = 0;
          for (let si = 0; si < idx; si++) {
            const prevStr = strokes[si];
            // 严格突破条件：
            // 1. 向上笔
            // 2. 笔的起点在中枢结束之后（确保突破发生在中枢之后）
            // 3. 笔的终点价格突破中枢上沿
            // 4. 笔的起点价格在中枢区间内或之下（从中枢出发的突破）
            if (prevStr.direction === 'up' &&
                prevStr.start.originalIndex > hub.endIndex &&
                prevStr.end.price > hub.zg &&
                prevStr.start.price <= hub.gg) {
              hasBreakout = true;
              breakoutHighPrice = Math.max(breakoutHighPrice, prevStr.end.price);
              break;
            }
          }
          if (hasBreakout && endFrac.price > hub.zg) {
            // BOLL收口辅助
            let bollNarrowing = { isNarrowing: false, description: '' };
            if (boll) {
              bollNarrowing = checkBOLLNarrowing(boll, endFrac.originalIndex);
            }

            const reasonParts = ['三买(中枢突破确认)'];
            reasonParts.push(`回踩${endFrac.price.toFixed(2)} > ZG${hub.zg.toFixed(2)}`);
            reasonParts.push(`突破高点${breakoutHighPrice.toFixed(2)}`);
            if (bollNarrowing.isNarrowing) reasonParts.push(bollNarrowing.description);

            points.push({
              id: `bs-buy3-${endFrac.originalIndex}-hub${hi}`,
              type: 'BUY_3',
              price: parseFloat(endFrac.price.toFixed(2)),
              originalIndex: endFrac.originalIndex,
              date: endFrac.date,
              reason: reasonParts.join(' | '),
              hubId: hub.id,
              hasTrendPremise: true
            });
            // 只关联最近的一个中枢
            break;
          }
        }
      }

    } else {
      // ==================== 卖出点判断 ====================

      // ---------- 一卖：趋势背驰点 ----------
      if (idx >= 2) {
        const prevUpStroke = strokes[idx - 2];
        if (prevUpStroke && prevUpStroke.direction === 'up') {
          const prvLen = Math.abs(prevUpStroke.start.price - prevUpStroke.end.price);
          const curLen = Math.abs(str.start.price - str.end.price);

          // 力度对比：C段力度弱于B段 + 价格创新高
          if (curLen < prvLen && endFrac.price > prevUpStroke.end.price) {
            // 趋势前提
            const upTrendHubs = hubsBeforeStroke.filter((_, hi) => {
              const originalIdx = hubs.indexOf(hubsBeforeStroke[hi]);
              return hubTrendDirs[originalIdx] === 'up';
            });
            const hasTrendPremise = upTrendHubs.length >= 2;

            // MACD顶背驰辅助
            let macdDivergence = { hasDivergence: false, description: '' };
            if (macd && klines) {
              macdDivergence = checkMACDTopDivergence(klines, macd, endFrac.originalIndex);
            }

            const isStrongSignal = hasTrendPremise;
            const hasMACDConfirm = macdDivergence.hasDivergence;

            if (isStrongSignal || hasMACDConfirm) {
              const reasonParts = ['一卖(趋势背驰)'];
              if (hasTrendPremise) reasonParts.push(`${upTrendHubs.length}个同向中枢`);
              if (curLen < prvLen) reasonParts.push(`力度收缩(${(curLen / prvLen * 100).toFixed(0)}%)`);
              if (hasMACDConfirm) reasonParts.push(macdDivergence.description);
              if (!hasTrendPremise) reasonParts.push('注意：无趋势前提(盘整背驰)');

              points.push({
                id: `bs-sell1-${endFrac.originalIndex}`,
                type: 'SELL_1',
                price: parseFloat(endFrac.price.toFixed(2)),
                originalIndex: endFrac.originalIndex,
                date: endFrac.date,
                reason: reasonParts.join(' | '),
                divergence: macdDivergence.hasDivergence ? {
                  hasMACDDivergence: true,
                  description: macdDivergence.description
                } : undefined,
                hasTrendPremise
              });
              continue;
            }
          }
        }
      }

      // ---------- 二卖：次级别反弹确认点 ----------
      const sell1Points = points.filter(p => p.type === 'SELL_1');
      if (sell1Points.length > 0) {
        const lastSell1 = sell1Points[sell1Points.length - 1];
        // 核心条件：反弹高点不破一卖最高点
        if (endFrac.originalIndex > lastSell1.originalIndex && endFrac.price < lastSell1.price) {
          // MACD双回试辅助
          let doubleRetest = { hasDoubleRetest: false, description: '' };
          if (macd) {
            doubleRetest = checkMACDDoubleRetestSell(macd, lastSell1.originalIndex, endFrac.originalIndex);
          }

          const reasonParts = ['二卖(反弹确认)'];
          reasonParts.push(`高点${endFrac.price.toFixed(2)}未破一卖${lastSell1.price.toFixed(2)}`);
          if (doubleRetest.hasDoubleRetest) reasonParts.push(doubleRetest.description);

          points.push({
            id: `bs-sell2-${endFrac.originalIndex}`,
            type: 'SELL_2',
            price: parseFloat(endFrac.price.toFixed(2)),
            originalIndex: endFrac.originalIndex,
            date: endFrac.date,
            reason: reasonParts.join(' | '),
            divergence: doubleRetest.hasDoubleRetest ? {
              hasMACDDivergence: true,
              description: doubleRetest.description
            } : undefined,
            hasTrendPremise: lastSell1.hasTrendPremise
          });
          continue;
        }
      }

      // ---------- 三卖：中枢突破确认点 ----------
      // 三卖条件：跌破中枢后，次级别反弹高点 < 中枢下沿(ZD)
      for (let hi = 0; hi < hubs.length; hi++) {
        const hub = hubs[hi];
        if (endFrac.originalIndex > hub.endIndex && endFrac.price < hub.zd) {
          // 确认之前有向下突破中枢的动作（严格：突破笔必须从中枢内部或上沿开始，向下突破下沿）
          let hasBreakout = false;
          let breakoutLowPrice = Infinity;
          for (let si = 0; si < idx; si++) {
            const prevStr = strokes[si];
            // 严格突破条件：
            // 1. 向下笔
            // 2. 笔的起点在中枢结束之后（确保突破发生在中枢之后）
            // 3. 笔的终点价格跌破中枢下沿
            // 4. 笔的起点价格在中枢区间内或之上（从中枢出发的突破）
            if (prevStr.direction === 'down' &&
                prevStr.start.originalIndex > hub.endIndex &&
                prevStr.end.price < hub.zd &&
                prevStr.start.price >= hub.dd) {
              hasBreakout = true;
              breakoutLowPrice = Math.min(breakoutLowPrice, prevStr.end.price);
              break;
            }
          }
          if (hasBreakout && endFrac.price < hub.zd) {
            // BOLL收口辅助
            let bollNarrowing = { isNarrowing: false, description: '' };
            if (boll) {
              bollNarrowing = checkBOLLNarrowing(boll, endFrac.originalIndex);
            }

            const reasonParts = ['三卖(中枢突破确认)'];
            reasonParts.push(`反弹${endFrac.price.toFixed(2)} < ZD${hub.zd.toFixed(2)}`);
            reasonParts.push(`突破低点${breakoutLowPrice.toFixed(2)}`);
            if (bollNarrowing.isNarrowing) reasonParts.push(bollNarrowing.description);

            points.push({
              id: `bs-sell3-${endFrac.originalIndex}-hub${hi}`,
              type: 'SELL_3',
              price: parseFloat(endFrac.price.toFixed(2)),
              originalIndex: endFrac.originalIndex,
              date: endFrac.date,
              reason: reasonParts.join(' | '),
              hubId: hub.id,
              hasTrendPremise: true
            });
            break;
          }
        }
      }
    }
  }

  return points;
}
