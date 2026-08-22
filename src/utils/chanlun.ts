import { Kline, MergedKline, Fraction, Stroke, Segment, Hub, BSPoint, BSPointType } from '../types/stock';

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

// ---------------------------------------------------------------------------
// 买卖点识别 (Buy/Sell Points 1-3)
// 移植自 doc/czsc-master (czsc Rust 实现)：
//   - crates/czsc-signals/src/utils/cxt.rs::check_first_buy / check_first_sell
//   - crates/czsc-signals/src/cxt.rs::cxt_first_buy_V221126 (窗口 21→5 滑动)
//   - crates/czsc-signals/src/cxt.rs::cxt_third_bs_V230318 (5 笔中枢 + 离开笔)
// 二买/二卖采用缠论经典定义：一买后次级别反弹再回调不创新低。
// ---------------------------------------------------------------------------

/** 笔高点 = max(起点, 终点)，对齐 BI::get_high */
function strokeHigh(s: Stroke): number {
  return Math.max(s.start.price, s.end.price);
}

/** 笔低点 = min(起点, 终点)，对齐 BI::get_low */
function strokeLow(s: Stroke): number {
  return Math.min(s.start.price, s.end.price);
}

/** 价差力度 = |终点价 - 起点价|，对齐 BI::get_power_price */
function strokePowerPrice(s: Stroke): number {
  return Math.abs(s.end.price - s.start.price);
}

/** 笔长度（无包含关系 K 线数量近似），对齐 BI::get_length */
function strokeLength(s: Stroke): number {
  return s.end.index - s.start.index + 1;
}

/** 成交量力度：笔内部原始 K 线成交量之和（不含首尾分型 K 线），对齐 BI::get_power_volume */
function strokePowerVolume(s: Stroke, klines: Kline[]): number {
  let vol = 0;
  for (let i = s.start.originalIndex + 1; i < s.end.originalIndex; i++) {
    vol += klines[i]?.volume ?? 0;
  }
  return vol;
}

function _mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * 一买结构判定（下跌趋势背驰），移植 check_first_buy：
 * 1. 奇数笔且首尾同为向下笔；
 * 2. 首笔高点为区间最高、末笔低点为区间最低（趋势结构）；
 * 3. 关键笔（创新低的向下笔）序列；
 * 4. 末笔价差力度 < 前一同向笔与关键笔均值的最大值，且量/长度至少其一同步衰竭。
 */
export function checkFirstBuy(bis: Stroke[], klines: Kline[]): boolean {
  const n = bis.length;
  if (n < 5 || n % 2 !== 1) return false;
  if (bis[n - 1].direction !== 'down') return false;
  if (bis[0].direction !== bis[n - 1].direction) return false;

  let maxHigh = -Infinity;
  let minLow = Infinity;
  for (const b of bis) {
    maxHigh = Math.max(maxHigh, strokeHigh(b));
    minLow = Math.min(minLow, strokeLow(b));
  }
  if (maxHigh !== strokeHigh(bis[0]) || minLow !== strokeLow(bis[n - 1])) return false;

  const keyBis: Stroke[] = [];
  for (let i = 0; i <= n - 3; i += 2) {
    if (i === 0) {
      keyBis.push(bis[0]);
    } else if (strokeLow(bis[i]) < strokeLow(bis[i - 2])) {
      keyBis.push(bis[i]);
    }
  }
  if (keyBis.length === 0) return false;

  const last = bis[n - 1];
  const prev = bis[n - 3];
  const bcPrice =
    strokePowerPrice(last) <
    Math.max(strokePowerPrice(prev), _mean(keyBis.map(strokePowerPrice)));
  const bcVolume =
    strokePowerVolume(last, klines) <
    Math.max(
      strokePowerVolume(prev, klines),
      _mean(keyBis.map(b => strokePowerVolume(b, klines)))
    );
  const bcLength =
    strokeLength(last) <
    Math.max(strokeLength(prev), _mean(keyBis.map(strokeLength)));
  return bcPrice && (bcVolume || bcLength);
}

/**
 * 一卖结构判定（上涨趋势背驰），check_first_buy 的镜像，移植 check_first_sell。
 */
export function checkFirstSell(bis: Stroke[], klines: Kline[]): boolean {
  const n = bis.length;
  if (n < 5 || n % 2 !== 1) return false;
  if (bis[n - 1].direction !== 'up') return false;
  if (bis[0].direction !== bis[n - 1].direction) return false;

  let maxHigh = -Infinity;
  let minLow = Infinity;
  for (const b of bis) {
    maxHigh = Math.max(maxHigh, strokeHigh(b));
    minLow = Math.min(minLow, strokeLow(b));
  }
  if (maxHigh !== strokeHigh(bis[n - 1]) || minLow !== strokeLow(bis[0])) return false;

  const keyBis: Stroke[] = [];
  for (let i = 0; i <= n - 3; i += 2) {
    if (i === 0) {
      keyBis.push(bis[0]);
    } else if (strokeHigh(bis[i]) > strokeHigh(bis[i - 2])) {
      keyBis.push(bis[i]);
    }
  }
  if (keyBis.length === 0) return false;

  const last = bis[n - 1];
  const prev = bis[n - 3];
  const bcPrice =
    strokePowerPrice(last) <
    Math.max(strokePowerPrice(prev), _mean(keyBis.map(strokePowerPrice)));
  const bcVolume =
    strokePowerVolume(last, klines) <
    Math.max(
      strokePowerVolume(prev, klines),
      _mean(keyBis.map(b => strokePowerVolume(b, klines)))
    );
  const bcLength =
    strokeLength(last) <
    Math.max(strokeLength(prev), _mean(keyBis.map(strokeLength)));
  return bcPrice && (bcVolume || bcLength);
}

const BS_LABELS: Record<BSPointType, string> = {
  B1: '一买',
  B2: '二买',
  B3: '三买',
  S1: '一卖',
  S2: '二卖',
  S3: '三卖'
};

/** 一类买卖点检测窗口，对齐 cxt_first_buy_V221126 的 [21..5] 奇数序列 */
const BS1_WINDOWS = [21, 19, 17, 15, 13, 11, 9, 7, 5];

/**
 * 计算缠论三类买卖点：
 * - B1/S1：趋势背驰（checkFirstBuy/checkFirstSell，窗口滑动）；
 * - B2/S2：一买/一卖后次级别反弹、再次回调不创新低/新高；
 * - B3/S3：5 笔中枢（b1∧b3 重叠），离开后的回抽整笔不回中枢区间。
 *
 * 返回按 originalIndex 升序的买卖点列表。
 */
export function calculateBSPoints(klines: Kline[], strokes: Stroke[]): BSPoint[] {
  const points: BSPoint[] = [];
  const n = strokes.length;
  if (klines.length === 0 || n < 5) return points;

  const seen = new Set<string>();
  const lastFiredAt = new Map<BSPointType, number>();

  const pushPoint = (type: BSPointType, strokeIdx: number, dedupeGap: number) => {
    const prevAt = lastFiredAt.get(type);
    if (prevAt !== undefined && strokeIdx - prevAt < dedupeGap) return;
    const stroke = strokes[strokeIdx];
    const isBuy = type.startsWith('B');
    const point: BSPoint = {
      id: `bs-${type}-${stroke.end.originalIndex}`,
      type,
      label: BS_LABELS[type],
      price: stroke.end.price,
      originalIndex: stroke.end.originalIndex,
      date: stroke.end.date,
      strokeIndex: strokeIdx
    };
    const key = `${type}-${stroke.end.originalIndex}`;
    if (seen.has(key)) return;
    seen.add(key);
    lastFiredAt.set(type, strokeIdx);
    points.push(point);
  };

  // ---- B1/S1：一类买卖点（趋势背驰），窗口从大到小取首个命中 ----
  for (let e = 4; e < n; e++) {
    for (const w of BS1_WINDOWS) {
      const start = e - w + 1;
      if (start < 0) continue;
      const seg = strokes.slice(start, e + 1);
      if (checkFirstBuy(seg, klines)) {
        pushPoint('B1', e, 3);
        break;
      }
      if (checkFirstSell(seg, klines)) {
        pushPoint('S1', e, 3);
        break;
      }
    }
  }

  // ---- B2/S2：二类买卖点（一买/一卖后回调不创新低/新高）----
  for (const p of [...points]) {
    const k = p.strokeIndex;
    if (p.type === 'B1' && k + 2 < n) {
      const pullback = strokes[k + 2];
      if (pullback.direction === 'down' && strokeLow(pullback) > strokeLow(strokes[k])) {
        pushPoint('B2', k + 2, 1);
      }
    }
    if (p.type === 'S1' && k + 2 < n) {
      const rally = strokes[k + 2];
      if (rally.direction === 'up' && strokeHigh(rally) < strokeHigh(strokes[k])) {
        pushPoint('S2', k + 2, 1);
      }
    }
  }

  // ---- B3/S3：三类买卖点（中枢离开后回抽不回区间），对齐 cxt_third_bs_V230318 ----
  for (let e = 4; e < n; e++) {
    const b1 = strokes[e - 4];
    const b3 = strokes[e - 2];
    const b5 = strokes[e];
    const zsZd = Math.max(strokeLow(b1), strokeLow(b3));
    const zsZg = Math.min(strokeHigh(b1), strokeHigh(b3));
    if (zsZd > zsZg) continue; // 无有效中枢
    if (b5.direction === 'down' && strokeLow(b5) > zsZg) {
      pushPoint('B3', e, 3);
    } else if (b5.direction === 'up' && strokeHigh(b5) < zsZd) {
      pushPoint('S3', e, 3);
    }
  }

  points.sort((a, b) => a.originalIndex - b.originalIndex || a.type.localeCompare(b.type));
  return points;
}
