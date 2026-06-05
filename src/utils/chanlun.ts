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
 * Step 3: Generate Strokes (画笔)
 * A clean, robust greedy search ensuring alternating tops and bottoms
 * Separated by at least 4 bars on the merged timeline (i.e. distance >= 4)
 */
export function calculateStrokes(fractions: Fraction[]): Stroke[] {
  if (fractions.length < 2) return [];

  const strokes: Stroke[] = [];
  let current: Fraction | null = null;

  for (let i = 0; i < fractions.length; i++) {
    const frac = fractions[i];

    if (!current) {
      current = frac;
      continue;
    }

    const dist = frac.index - current.index;
    const sameType = frac.type === current.type;

    if (sameType) {
      // If same type, keep the more extreme point
      if (current.type === 'TOP') {
        if (frac.price > current.price) {
          current = frac;
          if (strokes.length > 0) {
            const prevStroke = strokes[strokes.length - 1];
            prevStroke.end = frac;
            prevStroke.id = `stroke-${prevStroke.start.originalIndex}-${frac.originalIndex}`;
          }
        }
      } else {
        if (frac.price < current.price) {
          current = frac;
          if (strokes.length > 0) {
            const prevStroke = strokes[strokes.length - 1];
            prevStroke.end = frac;
            prevStroke.id = `stroke-${prevStroke.start.originalIndex}-${frac.originalIndex}`;
          }
        }
      }
    } else {
      // Different type: Check standard rule (at least 4 merged candles distance)
      if (dist >= 4) {
        // Valid stroke!
        strokes.push({
          id: `stroke-${current.originalIndex}-${frac.originalIndex}`,
          start: current,
          end: frac,
          direction: current.type === 'TOP' ? 'down' : 'up'
        });
        current = frac;
      } else {
        // If the distance is too small, we might want to extend the previous extreme if we hit a more extreme point
        // E.g. if we are exploring and see a higher peak/lower valley before a valid switch
        if (current.type === 'TOP' && frac.type === 'BOTTOM') {
          // If we can find a better bottom later, we might hold on
        }
      }
    }
  }

  // Double check strokes layout and filter out any anomalies (must strictly alternate)
  const cleanStrokes: Stroke[] = [];
  for (const s of strokes) {
    if (cleanStrokes.length === 0) {
      cleanStrokes.push(s);
    } else {
      const prev = cleanStrokes[cleanStrokes.length - 1];
      if (prev.direction !== s.direction) {
        cleanStrokes.push(s);
      } else {
        // If same direction, merge strokes by keeping the best extreme
        if (prev.direction === 'up') {
          if (s.end.price > prev.end.price) {
            prev.end = s.end;
          }
        } else {
          if (s.end.price < prev.end.price) {
            prev.end = s.end;
          }
        }
      }
    }
  }

  return cleanStrokes;
}

/**
 * Step 4: Calculate Segments (线段)
 * Segments represent larger swings, made up of at least 3 strokes.
 * For simplicity and perfect visualization, let's cluster strokes with swing filters.
 */
export function calculateSegments(strokes: Stroke[]): Segment[] {
  if (strokes.length < 3) return [];

  const segments: Segment[] = [];
  let currentStrokeIdx = 0;

  // Step 1: Naively generate segments of 3 strokes
  while (currentStrokeIdx < strokes.length) {
    const s1 = strokes[currentStrokeIdx];
    let candidateEndIdx = currentStrokeIdx + 2;

    if (candidateEndIdx < strokes.length) {
      const s3 = strokes[candidateEndIdx];
      // Create segment spanning s1.start to s3.end
      const dir = s1.start.type === 'BOTTOM' && s3.end.type === 'TOP' ? 'up' 
                : s1.start.type === 'TOP' && s3.end.type === 'BOTTOM' ? 'down' 
                : s1.direction;
      segments.push({
        id: `segment-${s1.start.originalIndex}-${s3.end.originalIndex}`,
        start: s1.start,
        end: s3.end,
        direction: dir
      });
      currentStrokeIdx = candidateEndIdx + 1;
    } else {
      // Connect remainder by extending the last segment or creating a final one
      if (segments.length > 0) {
        const lastSeg = segments[segments.length - 1];
        const lastStroke = strokes[strokes.length - 1];
        lastSeg.end = lastStroke.end;
        lastSeg.id = `segment-${lastSeg.start.originalIndex}-${lastStroke.end.originalIndex}`;
        lastSeg.direction = lastSeg.start.type === 'BOTTOM' ? 'up' : 'down';
      } else {
        const lastStroke = strokes[strokes.length - 1];
        const dir = s1.start.type === 'BOTTOM' && lastStroke.end.type === 'TOP' ? 'up'
                  : s1.start.type === 'TOP' && lastStroke.end.type === 'BOTTOM' ? 'down'
                  : s1.direction;
        segments.push({
          id: `segment-${s1.start.originalIndex}-${lastStroke.end.originalIndex}`,
          start: s1.start,
          end: lastStroke.end,
          direction: dir
        });
      }
      break;
    }
  }

  // Step 2: Clean and filter the segments to guarantee strict alternation (up, down, up, down...)
  // and ensure direction perfectly aligns with the start/end types (UP is BOTTOM -> TOP, DOWN is TOP -> BOTTOM)
  const clean: Segment[] = [];
  for (const seg of segments) {
    if (seg.start.type === seg.end.type) {
      // If start and end are of same type (e.g., TOP to TOP), it's invalid.
      // Merge its range into the previous segment.
      if (clean.length > 0) {
        const prev = clean[clean.length - 1];
        prev.end = seg.end;
        prev.id = `segment-${prev.start.originalIndex}-${seg.end.originalIndex}`;
        prev.direction = prev.start.type === 'BOTTOM' ? 'up' : 'down';
      }
      continue;
    }

    const realDirection = seg.start.type === 'BOTTOM' ? 'up' : 'down';
    seg.direction = realDirection;

    if (clean.length === 0) {
      clean.push(seg);
    } else {
      const prev = clean[clean.length - 1];
      if (prev.direction !== seg.direction) {
        clean.push(seg);
      } else {
        // Same direction: merge them to keep alternating trends
        if (prev.direction === 'up') {
          if (seg.end.price > prev.end.price) {
            prev.end = seg.end;
          }
          if (seg.start.price < prev.start.price) {
            prev.start = seg.start;
          }
        } else {
          if (seg.end.price < prev.end.price) {
            prev.end = seg.end;
          }
          if (seg.start.price > prev.start.price) {
            prev.start = seg.start;
          }
        }
        prev.id = `segment-${prev.start.originalIndex}-${prev.end.originalIndex}`;
      }
    }
  }

  // Final validation pass
  const finalSegments: Segment[] = [];
  for (const seg of clean) {
    if (seg.start.originalIndex === seg.end.originalIndex) continue;
    if (seg.start.type === seg.end.type) continue;
    seg.direction = seg.start.type === 'BOTTOM' ? 'up' : 'down';
    finalSegments.push(seg);
  }

  return finalSegments;
}

/**
 * Step 5: Identify Price Hubs (中枢)
 * Overlap floor and ceiling of three consecutive alternating strokes.
 */
export function calculateHubs(strokes: Stroke[]): Hub[] {
  const hubs: Hub[] = [];
  if (strokes.length < 3) return [];

  let i = 0;
  while (i < strokes.length - 2) {
    const s1 = strokes[i];
    const s2 = strokes[i + 1];
    const s3 = strokes[i + 2];

    const s1Min = Math.min(s1.start.price, s1.end.price);
    const s1Max = Math.max(s1.start.price, s1.end.price);
    const s2Min = Math.min(s2.start.price, s2.end.price);
    const s2Max = Math.max(s2.start.price, s2.end.price);
    const s3Min = Math.min(s3.start.price, s3.end.price);
    const s3Max = Math.max(s3.start.price, s3.end.price);

    // Calculate overlapping range
    const hubHigh = Math.min(s1Max, s2Max, s3Max);
    const hubLow = Math.max(s1Min, s2Min, s3Min);

    if (hubHigh > hubLow) {
      // Valid Hub!
      let hubStart = s1.start.originalIndex;
      let hubEnd = s3.end.originalIndex;
      let count = 3;
      let nextIdx = i + 3;

      // Extend the hub with subsequent strokes that overlap with it
      while (nextIdx < strokes.length) {
        const nextStroke = strokes[nextIdx];
        const nsMin = Math.min(nextStroke.start.price, nextStroke.end.price);
        const nsMax = Math.max(nextStroke.start.price, nextStroke.end.price);

        // Check if next stroke overlaps with the established hub range
        const overlapping = Math.min(hubHigh, nsMax) > Math.max(hubLow, nsMin);
        if (overlapping) {
          hubEnd = nextStroke.end.originalIndex;
          count++;
          nextIdx++;
        } else {
          break;
        }
      }

      hubs.push({
        id: `hub-${hubStart}-${hubEnd}`,
        high: parseFloat(hubHigh.toFixed(2)),
        low: parseFloat(hubLow.toFixed(2)),
        startIndex: hubStart,
        endIndex: hubEnd,
        strokesCount: count
      });

      // Jump past the extended strokes
      i = nextIdx;
    } else {
      i++;
    }
  }

  return hubs;
}

/**
 * Step 6: Trigger Buy/Sell Setup Points
 * 1st Type: Diverging extremes (divergence at bottom/top)
 * 2nd Type: pullback bottoms/tops not breaking previous highs/lows
 * 3rd Type: Pullback/Relief tests above/below Hub boundaries
 */
export function calculateBuySellPoints(strokes: Stroke[], hubs: Hub[]): BuySellPoint[] {
  const points: BuySellPoint[] = [];
  if (strokes.length === 0) return [];

  for (let idx = 0; idx < strokes.length; idx++) {
    const str = strokes[idx];
    const endFrac = str.end;

    // Check if there is an active hub covering this time area
    const matchingHub = hubs.find(h => endFrac.originalIndex >= h.startIndex && endFrac.originalIndex <= h.endIndex);

    if (str.direction === 'down') {
      // Possible BUY Point (ends in a BOTTOM fraction)
      
      // 1. First BUY (一买): Major bottom with stroke shortening (divergence)
      if (idx >= 2) {
        const prevDownStroke = strokes[idx - 2];
        if (prevDownStroke && prevDownStroke.direction === 'down') {
          const prvLen = Math.abs(prevDownStroke.start.price - prevDownStroke.end.price);
          const curLen = Math.abs(str.start.price - str.end.price);
          
          if (curLen < prvLen && endFrac.price < prevDownStroke.end.price) {
            points.push({
              id: `bs-buy1-${endFrac.originalIndex}`,
              type: 'BUY_1',
              price: parseFloat(endFrac.price.toFixed(2)),
              originalIndex: endFrac.originalIndex,
              date: endFrac.date,
              reason: 'Class 1 Buy (一买): Downward swing divergence'
            });
            continue;
          }
        }
      }

      // Default buy if it’s an absolute low
      if (idx === strokes.length - 1 && strokes.length > 2) {
        // Fallback check
        const isLowest = strokes.every(s => s.end.price >= endFrac.price);
        if (isLowest) {
          points.push({
            id: `bs-buy1-end-${endFrac.originalIndex}`,
            type: 'BUY_1',
            price: parseFloat(endFrac.price.toFixed(2)),
            originalIndex: endFrac.originalIndex,
            date: endFrac.date,
            reason: 'Class 1 Buy (一买): Extreme swing low'
          });
          continue;
        }
      }

      // 2. Second BUY (二买): Pullback bottom that stays above original first-buy low
      const buy1Points = points.filter(p => p.type === 'BUY_1');
      if (buy1Points.length > 0) {
        const lastBuy1 = buy1Points[buy1Points.length - 1];
        if (endFrac.originalIndex > lastBuy1.originalIndex && endFrac.price > lastBuy1.price) {
          points.push({
            id: `bs-buy2-${endFrac.originalIndex}`,
            type: 'BUY_2',
            price: parseFloat(endFrac.price.toFixed(2)),
            originalIndex: endFrac.originalIndex,
            date: endFrac.date,
            reason: 'Class 2 Buy (二买): First higher-low pullback'
          });
          continue;
        }
      }

      // 3. Third BUY (三买): Pullback bottom outside of Hub ceiling
      if (matchingHub) {
        // Wait, 3rd Buy occurs *after* price breaks above Hub ceiling, then pulls back to a bottom *above* Hub ceiling
        if (endFrac.originalIndex > matchingHub.endIndex && endFrac.price > matchingHub.high) {
          points.push({
            id: `bs-buy3-${endFrac.originalIndex}`,
            type: 'BUY_3',
            price: parseFloat(endFrac.price.toFixed(2)),
            originalIndex: endFrac.originalIndex,
            date: endFrac.date,
            reason: 'Class 3 Buy (三买): Pullback test above Hub ceiling'
          });
          continue;
        }
      }
    } else {
      // Possible SELL Point (ends in a TOP fraction)

      // 1. First SELL (一卖): Swing high showing upward fatigue
      if (idx >= 2) {
        const prevUpStroke = strokes[idx - 2];
        if (prevUpStroke && prevUpStroke.direction === 'up') {
          const prvLen = Math.abs(prevUpStroke.start.price - prevUpStroke.end.price);
          const curLen = Math.abs(str.start.price - str.end.price);
          
          if (curLen < prvLen && endFrac.price > prevUpStroke.end.price) {
            points.push({
              id: `bs-sell1-${endFrac.originalIndex}`,
              type: 'SELL_1',
              price: parseFloat(endFrac.price.toFixed(2)),
              originalIndex: endFrac.originalIndex,
              date: endFrac.date,
              reason: 'Class 1 Sell (一卖): Upward swing divergence'
            });
            continue;
          }
        }
      }

      // 2. Second SELL (二卖): Lower high pullback that stays below first-sell peak
      const sell1Points = points.filter(p => p.type === 'SELL_1');
      if (sell1Points.length > 0) {
        const lastSell1 = sell1Points[sell1Points.length - 1];
        if (endFrac.originalIndex > lastSell1.originalIndex && endFrac.price < lastSell1.price) {
          points.push({
            id: `bs-sell2-${endFrac.originalIndex}`,
            type: 'SELL_2',
            price: parseFloat(endFrac.price.toFixed(2)),
            originalIndex: endFrac.originalIndex,
            date: endFrac.date,
            reason: 'Class 2 Sell (二卖): First lower-high pullback'
          });
          continue;
        }
      }

      // 3. Third SELL (三卖): Pullback test below Hub floor
      if (matchingHub) {
        if (endFrac.originalIndex > matchingHub.endIndex && endFrac.price < matchingHub.low) {
          points.push({
            id: `bs-sell3-${endFrac.originalIndex}`,
            type: 'SELL_3',
            price: parseFloat(endFrac.price.toFixed(2)),
            originalIndex: endFrac.originalIndex,
            date: endFrac.date,
            reason: 'Class 3 Sell (三卖): Pullback test below Hub floor'
          });
          continue;
        }
      }
    }
  }

  return points;
}
