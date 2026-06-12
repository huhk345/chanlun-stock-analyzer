---
title: ChanLun Structure Reference for AI Strategy Generation
version: 1.0
date_created: 2026-06-12
last_updated: 2026-06-12
owner: Project maintainers
tags: [chanlun, strategy, ai, code-generation, trading-signals]
---

# Introduction

This specification documents the ChanLun (缠论) data structures and concepts that are available to AI-generated backtest strategies through the `input.chanlun` cache. When generating strategy code, the AI must understand these structures to write strategies that use ChanLun signals (fractions, strokes, segments, hubs, buy/sell points, and divergence).

## 1. ChanLun Analysis Pipeline

The project implements a 5-step deterministic pipeline. Each step builds on the previous:

```
Klines → MergedKlines → Fractions → Strokes → Segments → Hubs
```

### Pipeline Output Structure

All ChanLun analysis results are provided to the strategy through `input.chanlun`:

```ts
interface ChanLunCache {
  mergedKlines: MergedKline[];    // Step 1: Inclusion-merged K-lines
  fractions: Fraction[];           // Step 2: TOP/BOTTOM fractions
  strokes: Stroke[];               // Step 3: Strokes (笔)
  segments: Segment[];             // Step 4: Segments (线段)
  hubs: Hub[];                     // Step 5: Hubs (中枢, level 1 = stroke-level)
}
```

Access pattern in `decide()`:
```ts
decide({ klines, currentIndex, chanlun, ...rest }) {
  const { mergedKlines, fractions, strokes, segments, hubs } = chanlun;
  // Use these for analysis...
}
```

---

## 2. Data Structures

### 2.1 MergedKline (合并K线)

After inclusion processing (包含关系处理), overlapping K-lines are merged. Upward containment merges use max(high) and max(low); downward containment merges use min(high) and min(low).

```ts
interface MergedKline {
  high: number;              // Merged high price
  low: number;               // Merged low price
  direction: 'up' | 'down';  // Direction of the merge
  originalIndices: number[]; // Indices of original Klines merged into this one
  originalHigh: number;      // Max of all original highs
  originalLow: number;       // Min of all original lows
}
```

Usage hints:
- `mergedKlines.length` is always <= `klines.length` (merging reduces count)
- Fractions are identified on this merged representation
- Use `originalIndices` to map a merged kline back to the original Klines

### 2.2 Fraction (分型)

Fractions are the local extrema of merged K-lines. A TOP fraction requires the merged high to be higher than both neighbors; a BOTTOM fraction requires the merged low to be lower than both neighbors.

```ts
interface Fraction {
  type: 'TOP' | 'BOTTOM';  // 顶分型 or 底分型
  price: number;            // Price of the extreme (high for TOP, low for BOTTOM)
  index: number;            // Index in the *merged* K-line array
  originalIndex: number;    // Index in the *original* K-line array
  date: string;             // Date string
}
```

Usage hints:
- Fractions alternate in type (TOP → BOTTOM → TOP → ...) after stroke-filtering
- The `index` field refers to position in `mergedKlines[]`, NOT in `klines[]`
- Use `originalIndex` to look up the corresponding original Kline in `klines[]`
- Not all fractions become stroke endpoints — only those passing the `_connectFenxingToStroke` filter

### 2.3 Stroke (笔)

A stroke connects two alternating fractions (TOP→BOTTOM for down strokes, BOTTOM→TOP for up strokes) with a minimum distance of 4 merged K-lines between them. A two-pass greedy filter ensures strict alternation and keeps extreme values.

```ts
interface Stroke {
  id: string;               // e.g., "stroke-12-17"
  start: Fraction;          // Starting fraction
  end: Fraction;            // Ending fraction
  direction: 'up' | 'down'; // Up or down stroke
}
```

Usage hints:
- Strokes represent the most basic price movement unit
- `strokes.length` indicates the number of completed strokes
- For trend analysis: count consecutive strokes in the same direction
- Stroke price range: `Math.max(start.price, end.price)` is the stroke's high; `Math.min(start.price, end.price)` is the stroke's low
- Key for divergence analysis: compare the price range and momentum between adjacent strokes

### 2.4 Segment (线段)

Segments are higher-level structures. Strokes are treated as "K-lines" and fractions are found on stroke end-prices. Segments connect these higher-level fractions with a minimum distance of 3 strokes.

```ts
interface Segment {
  id: string;               // e.g., "segment-15-28"
  start: Fraction;          // Starting fraction
  end: Fraction;            // Ending fraction
  direction: 'up' | 'down'; // Up or down segment
}
```

Usage hints:
- Segments represent the primary trend structure
- A segment typically contains 3+ strokes
- Segment direction indicates the medium-term trend
- Segments are less numerous than strokes, providing a cleaner trend signal
- Use `segments` for trend identification and segment-level divergence

### 2.5 Hub (中枢)

Hubs represent price consolidation zones. They are identified by finding 3 consecutive strokes (or segments) whose price ranges overlap: the highest low (ZD) must be below the lowest high (ZG).

```ts
interface Hub {
  id: string;               // e.g., "hub-12-18"
  zg: number;               // 中枢上沿 = min of the 3 high prices (中枢高点)
  zd: number;               // 中枢下沿 = max of the 3 low prices (中枢低点)
  gg: number;               // 最高点 = max of all stroke highs (中枢最高价)
  dd: number;               // 最低点 = min of all stroke lows (中枢最低价)
  startIndex: number;       // Start index in original Klines
  endIndex: number;         // End index in original Klines
  strokesCount: number;     // Number of strokes/lines in this hub
  level: number;            // 1 = stroke-level hub (笔中枢), 2 = segment-level hub (线段中枢)
}
```

Hub geometry:
```
    gg ────────  (absolute highest price in the hub)
    ┌────────────────┐
    │  zg ───────     (hub upper bound = min of 3 highs)
    │  │  overlap  │  │
    │  └────── zd ──   (hub lower bound = max of 3 lows)
    └────────────────┘
    dd ────────  (absolute lowest price in the hub)
```

Usage hints:
- A valid hub exists when `zg > zd` (positive overlap)
- `[zd, zg]` is the price overlap zone — the "hub range"
- `[dd, gg]` is the full price extension — the "hub envelope"
- Hub extension: subsequent strokes overlapping the `[zd, zg]` range are added to the hub
- Level 1 hubs are based on strokes; level 2 hubs are based on segments
- Use `hubs` for identifying support/resistance zones and buy/sell points

---

## 3. ChanLun Trading Theory for Strategy Coding

### 3.1 Trend Identification

A trend is defined by at least 2 hubs in the same direction without overlap:
- **Downtrend**: Hub2.zg < Hub1.zd (each hub is lower than the previous, no overlap)
- **Uptrend**: Hub2.zd > Hub1.zg (each hub is higher than the previous, no overlap)

```ts
function isTrend(hubs: Hub[]): 'up' | 'down' | null {
  const sorted = [...hubs].sort((a, b) => a.startIndex - b.startIndex);
  if (sorted.length < 2) return null;
  const last = sorted[sorted.length - 1];
  const prev = sorted[sorted.length - 2];
  if (last.zd > prev.zg) return 'up';
  if (last.zg < prev.zd) return 'down';
  return null; // consolidation
}
```

### 3.2 Buy/Sell Point Detection (买卖点)

Three classic buy/sell point types. The strategy can implement these using the stroke, segment, and hub data.

#### 1st Buy Point (第一类买点)
- Condition: Downtrend with >= 2 hubs, the exit stroke from the last hub shows weaker momentum (divergence) than the entry stroke connecting the hubs
- Price condition: exit stroke low < entry stroke low (new low)
- Momentum condition: force(exit) < force(entry) (use MACD area or stroke length)
- Signal: Trend exhaustion bottom, potential reversal

```ts
function isFirstBuy(strokes: Stroke[], hubs: Hub[]): boolean {
  if (hubs.length < 2) return false;
  const sorted = [...hubs].sort((a, b) => a.startIndex - b.startIndex);
  const last = sorted[sorted.length - 1];
  const prev = sorted[sorted.length - 2];
  if (last.zg >= prev.zd) return false; // not a downtrend
  
  // Find the exit stroke from last hub
  const exitStroke = strokes.find(s => s.start.originalIndex >= last.endIndex);
  // Find the entry stroke connecting prev to last hub
  const entryStroke = strokes.find(s => s.end.originalIndex >= last.startIndex && s.start.originalIndex <= prev.endIndex);
  
  if (!exitStroke || !entryStroke) return false;
  if (exitStroke.direction !== 'down') return false;
  
  // Price condition: exit goes lower
  const priceCondition = exitStroke.end.price < entryStroke.end.price;
  // Momentum condition: exit is weaker (shorter range = less force)
  const exitRange = Math.abs(exitStroke.end.price - exitStroke.start.price);
  const entryRange = Math.abs(entryStroke.end.price - entryStroke.start.price);
  const momentumCondition = exitRange < entryRange;
  
  return priceCondition && momentumCondition;
}
```

#### 2nd Buy Point (第二类买点)
- Condition: After 1st Buy, a pullback that does NOT break below the 1st Buy low
- Price condition: pullback low > 1st Buy low
- Signal: Confirmation of trend reversal, lower risk entry than 1st Buy

```ts
function isSecondBuy(strokes: Stroke[], firstBuyLow: number): boolean {
  // Find the last stroke — it should be a down stroke (pullback) after the 1st buy's up stroke
  const last = strokes[strokes.length - 1];
  if (!last || last.direction !== 'down') return false;
  // Pullback does not break the 1st buy low
  return last.end.price > firstBuyLow;
}
```

#### 3rd Buy Point (第三类买点)
- Condition: After a hub, an upward breakout followed by a pullback that stays above ZG
- Price condition: pullback low > hub.zg
- Signal: Strong trend, hub becomes support

```ts
function isThirdBuy(strokes: Stroke[], hubs: Hub[]): boolean {
  const lastHub = hubs[hubs.length - 1];
  if (!lastHub) return false;
  
  // Last 2 strokes: up (breakout) then down (pullback)
  const s2 = strokes[strokes.length - 1]; // pullback
  const s1 = strokes[strokes.length - 2]; // breakout
  if (!s2 || !s1) return false;
  if (s1.direction !== 'up') return false;
  if (s2.direction !== 'down') return false;
  
  // Breakout above ZG, pullback stays above ZG
  return s1.end.price > lastHub.zg && s2.end.price > lastHub.zg;
}
```

#### Sell Points (Symmetric)

| Buy Point | Sell Point | Condition |
|-----------|-----------|-----------|
| 1Buy | 1Sell | Uptrend with >=2 hubs, exit stroke shows weaker momentum (higher high, less force) |
| 2Buy | 2Sell | After 1Sell, rebound does not break above 1Sell high |
| 3Buy | 3Sell | After hub, downward breakout stays below ZD |

### 3.3 Divergence (背驰) Analysis

Divergence is the core concept for identifying trend exhaustion:

```
Uptrend divergence: Price makes higher high BUT momentum weakens
  → Price: Stroke N high > Stroke N-1 high
  → Momentum: Force(N) < Force(N-1)  (shorter range, smaller MACD area)

Downtrend divergence: Price makes lower low BUT momentum weakens
  → Price: Stroke N low < Stroke N-1 low
  → Momentum: Force(N) < Force(N-1)  (shorter range, smaller MACD area)
```

Momentum estimation (when MACD data is not directly in chanlun cache):
```ts
function estimateForce(stroke: Stroke): number {
  // Price range as a proxy for momentum
  return Math.abs(stroke.end.price - stroke.start.price);
}

function hasDivergence(strokes: Stroke[]): 'bullish' | 'bearish' | null {
  if (strokes.length < 2) return null;
  const last = strokes[strokes.length - 1];
  const prev = strokes[strokes.length - 2];
  
  if (last.direction === 'up' && prev.direction === 'up') {
    // Both up strokes — check for bearish divergence
    if (last.end.price > prev.end.price && estimateForce(last) < estimateForce(prev)) {
      return 'bearish'; // Weakening upward momentum
    }
  }
  if (last.direction === 'down' && prev.direction === 'down') {
    // Both down strokes — check for bullish divergence
    if (last.end.price < prev.end.price && estimateForce(last) < estimateForce(prev)) {
      return 'bullish'; // Weakening downward momentum
    }
  }
  return null;
}
```

### 3.4 Hub Breakout Trading

- **Upward breakout**: Price closes above hub.zg → potential long entry
- **Downward breakout**: Price closes below hub.zd → potential short entry
- **Pullback to hub**: After breakout, if price pulls back to the `[zd, zg]` zone, the hub may act as support/resistance

---

## 4. Common Strategy Patterns Using ChanLun

### Pattern 1: Hub Support/Resistance Bounce

```ts
if (currentKline.low <= hub.zg && currentKline.close > hub.zg) {
  // Bounce off hub upper bound — buy
  return { action: 'BUY', amount: { unit: 'percent', value: 50 }, reason: 'Bounce off hub ZG' };
}
```

### Pattern 2: Trend Direction Filter

```ts
// Only buy when segments show uptrend
const lastSegment = segments[segments.length - 1];
if (lastSegment?.direction !== 'up') {
  return { action: 'HOLD', reason: 'No uptrend' };
}
```

### Pattern 3: Divergence Reversal

```ts
// Check if the last completed stroke shows divergence
const lastStrokes = strokes.slice(-2);
if (lastStrokes.length === 2 &&
    lastStrokes[0].direction === 'down' &&
    lastStrokes[1].direction === 'down' &&
    lastStrokes[1].end.price < lastStrokes[0].end.price) {
  const force0 = Math.abs(lastStrokes[0].end.price - lastStrokes[0].start.price);
  const force1 = Math.abs(lastStrokes[1].end.price - lastStrokes[1].start.price);
  if (force1 < force0) {
    // Bullish divergence — potential buy
    return { action: 'BUY', amount: { unit: 'percent', value: 50 }, reason: 'Bullish divergence' };
  }
}
```

### Pattern 4: Multi-Level Confirmation

```ts
// Use both stroke-level and segment-level signals
const strokeHubs = hubs.filter(h => h.level === 1);
const segmentHubs = hubs.filter(h => h.level === 2);

if (segmentHubs.length >= 2) {
  const uptrend = segmentHubs[segmentHubs.length - 1].zd > segmentHubs[0].zg;
  if (uptrend) {
    // Major trend is up — look for long entries using stroke-level signals
  }
}
```

---

## 5. Important Constraints

1. **No lookahead**: `chanlun` data is computed up to `currentIndex` only. Do not assume future strokes/segments/hubs exist.
2. **Partial data**: On early K-lines, `chanlun` may have very few or zero strokes/segments/hubs. Always check `length > 0` before accessing.
3. **Data index mapping**: Stroke/segment `start.originalIndex` and `end.originalIndex` refer to indices in the `klines[]` array. Hub `startIndex` and `endIndex` also refer to the original K-line array. The `Fraction.index` field refers to the merged K-line array.
4. **Hub level**: `hub.level === 1` means stroke-level hub (identified from strokes), `hub.level === 2` means segment-level hub (identified from segments).
5. **Cache is read-only**: The chanlun cache is computed by the backtest runner. Do not modify it in `decide()`.
6. **requiresChanLun**: Set `requiresChanLun: true` in the strategy definition only if the strategy actually uses `chanlun` data. When enabled, the backtest runner pre-computes the full ChanLun analysis for each step.
