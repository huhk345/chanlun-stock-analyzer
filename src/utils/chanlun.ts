import { Kline, MergedKline, Fraction, Stroke, Segment, Hub } from '../types/stock';

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
