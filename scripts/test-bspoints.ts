/* Sanity test for calculateBSPoints using synthetic ChanLun structures. */
import { Kline, Stroke, Fraction } from '../src/types/stock';
import { calculateBSPoints, checkFirstBuy, checkFirstSell } from '../src/utils/chanlun';

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++;
    console.log(`  PASS: ${msg}`);
  } else {
    fail++;
    console.error(`  FAIL: ${msg}`);
  }
}

// Helper: build a synthetic stroke from two price extremes.
// merged index distance must be >= 4 (minDistance in calculateStrokes).
let idx = 0;
function mkStroke(startPrice: number, endPrice: number, len = 6): Stroke {
  const start: Fraction = {
    type: startPrice > endPrice ? 'TOP' : 'BOTTOM',
    price: startPrice,
    index: idx,
    originalIndex: idx * 5,
    date: `2024-01-${String(idx * 5 + 1).padStart(2, '0')}`
  };
  const end: Fraction = {
    type: endPrice < startPrice ? 'BOTTOM' : 'TOP',
    price: endPrice,
    index: idx + len - 1,
    originalIndex: (idx + len - 1) * 5,
    date: `2024-01-${String((idx + len - 1) * 5 + 1).padStart(2, '0')}`
  };
  idx += len;
  return {
    id: `s-${start.originalIndex}-${end.originalIndex}`,
    start,
    end,
    direction: endPrice < startPrice ? 'down' : 'up'
  };
}

function mkKlines(count: number): Kline[] {
  return Array.from({ length: count }, (_, i) => ({
    date: `2024-01-${String(i + 1).padStart(2, '0')}`,
    open: 10, high: 11, low: 9, close: 10, volume: 1000, amount: 10000
  }));
}

console.log('== Test 1: checkFirstBuy on a 5-stroke downtrend with weakening last stroke ==');
// Down trend: each down stroke makes lower low; last stroke weaker (smaller range AND shorter length)
const downTrend = [
  mkStroke(100, 90, 8),   // b0 down
  mkStroke(90, 96, 6),    // b1 up
  mkStroke(96, 84, 7),    // b2 down (lower low)
  mkStroke(84, 91, 6),    // b3 up
  mkStroke(91, 82, 5)     // b4 down (lower low, weaker: range 9<12/10, length 5<7/8)
];
const kl1 = mkKlines(200);
assert(checkFirstBuy(downTrend, kl1) === true, 'weakening downtrend detected as B1');

// Strong last stroke (no divergence) should NOT be B1
idx = 0;
const noDiverge = [
  mkStroke(100, 90, 8),
  mkStroke(90, 96, 6),
  mkStroke(96, 84, 7),
  mkStroke(84, 91, 6),
  mkStroke(91, 70, 9) // much stronger
];
assert(checkFirstBuy(noDiverge, kl1) === false, 'strengthening downtrend NOT B1');

console.log('== Test 2: checkFirstSell mirror ==');
idx = 0;
const upTrend = [
  mkStroke(50, 60, 8),
  mkStroke(60, 54, 6),
  mkStroke(54, 66, 7),
  mkStroke(66, 59, 6),
  mkStroke(59, 68, 5) // weaker
];
assert(checkFirstSell(upTrend, kl1) === true, 'weakening uptrend detected as S1');

console.log('== Test 3: B3 third buy — hub then breakout pullback above ZG ==');
// strokes: b1 down(100->95) b2 up(95->99) b3 down(99->96) => ZG=min(100,99)=99? No:
// hub from b1,b3: zd=max(95,96)=96, zg=min(100,99)=99 -> valid [96,99]
// b4 up leaves: 96->105; b5 down pullback: 105->97.5 (low 97.5 > zg 99? NO)
// need pullback low > 99: b5: 106 -> 99.5
idx = 0;
const thirdBuy = [
  mkStroke(20, 30),      // prior context (not used by window ending at e=6? windows use e-4..e)
  mkStroke(30, 24),
  mkStroke(100, 95),     // b1 of hub (index 2)
  mkStroke(95, 99.5),    // b2
  mkStroke(99.5, 96),    // b3 of hub -> zd=96, zg=min(100,99.5)=99.5
  mkStroke(96, 106),     // b4 breakout up
  mkStroke(106, 99.8)    // b5 pullback down, low 99.8 > zg 99.5 => B3
];
const kls = mkKlines(300);
const pts3 = calculateBSPoints(kls, thirdBuy);
console.log('  detected:', pts3.map(p => `${p.type}@stroke${p.strokeIndex}`).join(', ') || '(none)');
assert(pts3.some(p => p.type === 'B3' && p.strokeIndex === 6), 'B3 at pullback stroke');

console.log('== Test 4: B2 second buy after B1 ==');
// Build long enough sequence where B1 fires then pullback holds higher low.
// B1 at stroke 4 (low 82); add up to 88 then pullback to 83 (> 82) => B2 at stroke 6.
idx = 0;
const seq2 = [
  mkStroke(100, 90, 8), mkStroke(90, 96, 6), mkStroke(96, 84, 7), mkStroke(84, 91, 6), mkStroke(91, 82, 5),
  mkStroke(82, 89, 6),   // rebound
  mkStroke(89, 83, 6)    // pullback low 83 > 82 => B2
];
const pts2 = calculateBSPoints(mkKlines(300), seq2);
console.log('  detected:', pts2.map(p => `${p.type}@stroke${p.strokeIndex}`).join(', ') || '(none)');
assert(pts2.some(p => p.type === 'B1' && p.strokeIndex === 4), 'B1 detected in sequence');
assert(pts2.some(p => p.type === 'B2' && p.strokeIndex === 6), 'B2 after B1 with higher low');

console.log('== Test 5: empty / short input safety ==');
assert(calculateBSPoints([], []).length === 0, 'empty input returns empty');
assert(calculateBSPoints(mkKlines(10), [mkStroke(10, 5)]).length === 0, 'short input returns empty');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
