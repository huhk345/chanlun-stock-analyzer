import { Kline, MergedKline, Fraction, Stroke, Segment, Hub, BSPoint, BSPointType } from '../types/stock';

// ============================================================================
// 缠论结构计算：czsc-core / czsc-signals 的 TypeScript 等价移植。
//
// 全部计算仍然发生在浏览器（JS/TS）侧，不依赖 engine-rs，也不新增后端接口。
// 算法来源（文件级对照）：
//   * 去包含 / 分型 / 笔 / 中枢序列
//       czsc-master/crates/czsc-core/src/analyze/utils.rs
//       - remove_include() / check_fx() / check_fxs() / check_bi() / get_zs_seq()
//   * CZSC 增量状态机（逐根 K 线更新、笔的确认与被破坏回滚）
//       czsc-master/crates/czsc-core/src/analyze/mod.rs
//       - CZSC::update_bar() / CZSC::__update_bi()
//   * 笔的派生指标
//       czsc-master/crates/czsc-core/src/objects/bi.rs
//       - BI::get_high/get_low/get_power_price/get_power_volume/get_length
//   * 中枢对象与有效性
//       czsc-master/crates/czsc-core/src/objects/zs.rs
//       - ZS::new() / ZS::is_valid()
//   * 买卖点
//       czsc-master/crates/czsc-signals/src/utils/cxt.rs
//       - check_first_buy() / check_first_sell()
//       czsc-master/crates/czsc-signals/src/cxt.rs
//       - cxt_first_buy_V221126（21/19/.../5 笔窗口）
//       - cxt_third_bs_V230318（b1/b3/b5 五笔中枢 + SMA34 单调性）
//       czsc-master/crates/czsc-signals/src/utils/ta.rs
//       - calc_sma_cache_style() / ma_snapshot_value()（批量等价：SMA(close, 34)）
//
// 数据契约（Stroke/Segment/Hub/BSPoint 字段）保持与旧实现一致，仅在内部
// 增加合并 K 线 -> 分型 -> 笔 -> 线段的映射，调用方无需改动。
// ============================================================================

type Direction = 'up' | 'down';
type Mark = 'G' | 'D'; // G = 顶分型，D = 底分型（对齐 czsc Mark）

/** czsc-core 默认 min_bi_len = 6（去包含后的 K 线根数） */
const MIN_BI_LEN = 6;
/** 线段由笔递归构成，沿用旧实现“至少 3 笔”的口径 */
const MIN_SEG_LEN = 3;

// ---------------------------------------------------------------------------
// 内部基础对象（对应 czsc-core RawBar / NewBar / FX / BI）
// ---------------------------------------------------------------------------

/** 原始 K 线（对应 RawBar，额外携带在输入数组中的下标） */
interface RawBar {
  index: number;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
}

/**
 * 可参与分型/笔计算的最小 K 线接口（对应 NewBar 的 high/low/dt）。
 * 线段计算会把“笔”抽象成同构的 LevelBar，从而复用同一套 check_fx/check_bi。
 */
interface LevelBar {
  /** 在当前级别序列中的下标（合并 K 线下标 / 笔下标） */
  index: number;
  date: string;
  high: number;
  low: number;
  volume?: number;
  /** 线段级别使用：该 bar 对应的原始笔下标 */
  strokeIndex?: number;
}

/** 去包含后的 K 线（对应 NewBar） */
interface NewBar extends LevelBar {
  open: number;
  close: number;
  volume: number;
  amount: number;
  /** 参与合并的原始 K 线 */
  rawElements: RawBar[];
}

/** 分型（对应 FX；elements 固定为 [k1, k2, k3]） */
interface Fx {
  mark: Mark;
  high: number;
  low: number;
  /** 顶分型取 k2.high，底分型取 k2.low（对齐 FX.fx） */
  fx: number;
  date: string;
  elements: LevelBar[];
}

/** 笔（对应 BI）；bars 与输入级别同构，K 线级别为 NewBar，线段级别为 LevelBar */
interface Bi<T extends LevelBar = LevelBar> {
  direction: Direction;
  fxA: Fx;
  fxB: Fx;
  fxs: Fx[];
  bars: T[];
}

function rawFromKline(k: Kline, index: number): RawBar {
  return {
    index,
    date: k.date,
    open: k.open,
    high: k.high,
    low: k.low,
    close: k.close,
    volume: k.volume ?? 0,
    amount: k.amount ?? 0,
  };
}

function newBarFromRaw(raw: RawBar): NewBar {
  return {
    index: -1, // 入列时再赋合并 K 线下标
    date: raw.date,
    open: raw.open,
    high: raw.high,
    low: raw.low,
    close: raw.close,
    volume: raw.volume,
    amount: raw.amount,
    rawElements: [raw],
  };
}

/**
 * 去除包含关系。逐行对齐 czsc-core/analyze/utils.rs::remove_include：
 * 1. 用 k1/k2 的高点决定合并方向（相等时直接视为无包含，返回 k3）；
 * 2. 按方向取高/低极值，并保留极值所在 K 线的时间；
 * 3. 合并后的开收盘按 k3 阴阳摆成 high/low，成交量与成交额累加；
 * 4. elements 保留 k2 的前 100 根原始 K 线（剔除与 k3 同时间者）再拼接 k3。
 */
function removeInclude(k1: NewBar, k2: NewBar, k3: RawBar): { hasInclude: boolean; bar: NewBar } {
  let direction: Direction;
  if (k1.high < k2.high) direction = 'up';
  else if (k1.high > k2.high) direction = 'down';
  else return { hasInclude: false, bar: newBarFromRaw(k3) };

  const hasInclude =
    (k2.high <= k3.high && k2.low >= k3.low) || (k2.high >= k3.high && k2.low <= k3.low);
  if (!hasInclude) return { hasInclude: false, bar: newBarFromRaw(k3) };

  let high: number;
  let low: number;
  let date: string;
  if (direction === 'up') {
    high = Math.max(k2.high, k3.high);
    low = Math.max(k2.low, k3.low);
    date = k2.high > k3.high ? k2.date : k3.date;
  } else {
    high = Math.min(k2.high, k3.high);
    low = Math.min(k2.low, k3.low);
    date = k2.low < k3.low ? k2.date : k3.date;
  }

  const open = k3.open > k3.close ? high : low;
  const close = k3.open > k3.close ? low : high;
  const rawElements = k2.rawElements
    .slice(0, 100)
    .filter((x) => x.date !== k3.date)
    .concat(k3);

  return {
    hasInclude: true,
    bar: {
      index: -1,
      date,
      open,
      high,
      low,
      close,
      volume: k2.volume + k3.volume,
      amount: k2.amount + k3.amount,
      rawElements,
    },
  };
}

/**
 * 查找单个分型。对齐 czsc-core/analyze/utils.rs::check_fx：
 * 顶分型要求 k1/k2/k3 的高、低都严格抬高后回落；底分型反之。
 */
function checkFx(k1: LevelBar, k2: LevelBar, k3: LevelBar): Fx | undefined {
  if (k1.high < k2.high && k2.high > k3.high && k1.low < k2.low && k2.low > k3.low) {
    return {
      mark: 'G',
      high: k2.high,
      low: k2.low,
      fx: k2.high,
      date: k2.date,
      elements: [k1, k2, k3],
    };
  }
  if (k1.low > k2.low && k2.low < k3.low && k1.high > k2.high && k2.high < k3.high) {
    return {
      mark: 'D',
      high: k2.high,
      low: k2.low,
      fx: k2.low,
      date: k2.date,
      elements: [k1, k2, k3],
    };
  }
  return undefined;
}

/**
 * 全量分型。对齐 czsc-core/analyze/utils.rs::check_fxs：
 * 相邻同标记分型只保留先出现的一个，保证分型序列顶底交替。
 */
function checkFxs(bars: LevelBar[]): Fx[] {
  const fxs: Fx[] = [];
  for (let i = 1; i < bars.length - 1; i++) {
    const fx = checkFx(bars[i - 1], bars[i], bars[i + 1]);
    if (!fx) continue;
    if (fxs.length > 0 && fxs[fxs.length - 1].mark === fx.mark) continue;
    fxs.push(fx);
  }
  return fxs;
}

function firstIndexAtLeast(bars: LevelBar[], index: number): number {
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].index >= index) return i;
  }
  return bars.length;
}

/**
 * 查找一笔。对齐 czsc-core/analyze/utils.rs::check_bi：
 * - fx_a 取序列首个分型；
 * - fx_b 取 fx_a 之后、反向、且价格越过 fx_a 的极值分型（并列保留先出现者）；
 * - fx_a 与 fx_b 区间存在包含关系时不成笔；
 * - 区间内去包含 K 线数量必须 >= min_bi_len；
 * - 返回剩余 K 线从 fx_b 的 k1 开始，供下一笔继续。
 */
function checkBi<T extends LevelBar>(bars: T[], minBiLen: number): { bi: Bi<T> | null; rest: T[] } {
  const fxs = checkFxs(bars);
  if (fxs.length < 2) return { bi: null, rest: bars };

  const fxA = fxs[0];
  let fxB: Fx | undefined;
  if (fxA.mark === 'D') {
    for (const x of fxs) {
      if (x.mark !== 'G' || x.date <= fxA.date || x.fx <= fxA.fx) continue;
      if (!fxB || x.high > fxB.high) fxB = x;
    }
  } else {
    for (const x of fxs) {
      if (x.mark !== 'D' || x.date <= fxA.date || x.fx >= fxA.fx) continue;
      if (!fxB || x.low < fxB.low) fxB = x;
    }
  }
  if (!fxB) return { bi: null, rest: bars };

  const startIndex = fxA.elements[0].index;
  const endIndex = fxB.elements[2].index;
  const startPos = firstIndexAtLeast(bars, startIndex);
  const endPos = firstIndexAtLeast(bars, endIndex + 1);
  if (startPos >= endPos) return { bi: null, rest: bars };

  const barsA = bars.slice(startPos, endPos);
  const restPos = firstIndexAtLeast(bars, fxB.elements[0].index);
  const rest = bars.slice(restPos);

  const abInclude =
    (fxA.high > fxB.high && fxA.low < fxB.low) ||
    (fxA.high < fxB.high && fxA.low > fxB.low);
  if (abInclude || barsA.length < minBiLen) return { bi: null, rest: bars };

  const direction: Direction = fxA.mark === 'D' ? 'up' : 'down';
  return {
    bi: {
      direction,
      fxA,
      fxB,
      fxs: fxs.filter((x) => x.date >= fxA.elements[0].date && x.date <= fxB.elements[2].date),
      bars: barsA,
    },
    rest,
  };
}

function biHigh(bi: Bi): number {
  return Math.max(bi.fxA.high, bi.fxB.high);
}

function biLow(bi: Bi): number {
  return Math.min(bi.fxA.low, bi.fxB.low);
}

// ---------------------------------------------------------------------------
// CZSC 增量分析器（对应 czsc-core/analyze/mod.rs::CZSC）
// ---------------------------------------------------------------------------

interface CzscCore {
  klines: Kline[];
  /** 全量去包含 K 线（不按 max_bi_num 截断，保证图表/策略能看到完整历史） */
  mergedAll: NewBar[];
  /** 尚未成笔的尾部去包含 K 线 */
  barsUbi: NewBar[];
  biList: Bi<NewBar>[];
}

interface CzscUpdate {
  biList: Bi<NewBar>[];
  barsUbi: NewBar[];
  /** 当前处理到的原始 K 线下标 */
  rawIndex: number;
}

function analyzeCzscCore(klines: Kline[], onUpdate?: (state: CzscUpdate) => void): CzscCore {
  const rawBars: RawBar[] = klines.map(rawFromKline);
  const mergedAll: NewBar[] = [];
  let barsUbi: NewBar[] = [];
  const biList: Bi<NewBar>[] = [];

  const processRaw = (raw: RawBar) => {
    if (mergedAll.length < 2) {
      const bar = newBarFromRaw(raw);
      bar.index = mergedAll.length;
      mergedAll.push(bar);
      if (barsUbi.length < 2) barsUbi.push(bar);
      return;
    }

    const { hasInclude, bar } = removeInclude(
      mergedAll[mergedAll.length - 2],
      mergedAll[mergedAll.length - 1],
      raw,
    );

    if (hasInclude) {
      bar.index = mergedAll.length - 1;
      mergedAll[mergedAll.length - 1] = bar;
    } else {
      bar.index = mergedAll.length;
      mergedAll.push(bar);
    }

    // bars_ubi 始终是 mergedAll 的后缀；包含处理结果直接复用同一个对象。
    if (barsUbi.length < 2) {
      barsUbi.push(bar);
    } else if (hasInclude) {
      barsUbi[barsUbi.length - 1] = bar;
    } else {
      barsUbi.push(bar);
    }
  };

  /**
   * 更新笔。对齐 CZSC::__update_bi：
   * - 第一笔：先在候选分型里选出与首个分型同向的极值分型作为起点；
   * - 后续：check_bi 成功后，若最后已完成笔被尾部 K 线破坏，则回滚该笔，
   *   把它的 bars 与 bars_ubi 重新拼接（对应 Rust 中的 merge_point 逻辑）。
   */
  const updateBi = () => {
    if (barsUbi.length < 3) return;

    if (biList.length === 0) {
      const fxs = checkFxs(barsUbi);
      const first = fxs[0];
      if (!first) return;
      let fxA = first;
      for (const x of fxs) {
        if (x.mark !== first.mark) continue;
        if (first.mark === 'D' ? x.low <= fxA.low : x.high >= fxA.high) fxA = x;
      }
      const fromA = barsUbi.filter((b) => b.index >= fxA.elements[0].index);
      const { bi, rest } = checkBi(fromA, MIN_BI_LEN);
      if (bi) biList.push(bi);
      barsUbi = rest;
      return;
    }

    const { bi, rest } = checkBi(barsUbi, MIN_BI_LEN);
    if (bi) biList.push(bi);
    barsUbi = rest;

    const last = biList[biList.length - 1];
    if (!last) return;
    const tail = barsUbi[barsUbi.length - 1];
    if (
      tail &&
      ((last.direction === 'up' && tail.high > biHigh(last)) ||
        (last.direction === 'down' && tail.low < biLow(last)))
    ) {
      const mergeBar = last.bars[last.bars.length - 2];
      const mergeIndex = mergeBar ? mergeBar.index : tail.index;
      barsUbi = [
        ...last.bars.slice(0, Math.max(0, last.bars.length - 2)),
        ...barsUbi.filter((b) => b.index >= mergeIndex),
      ];
      biList.pop();
    }
  };

  for (let i = 0; i < klines.length; i++) {
    const raw = rawBars[i];
    if (i > 0 && raw.date === rawBars[i - 1].date) {
      // 同时间戳延伸：替换最后一根原始 K 线，并重新处理它所在合并 K 线的 elements
      const popped = mergedAll.pop();
      if (barsUbi.length > 0 && barsUbi[barsUbi.length - 1].index === popped?.index) barsUbi.pop();
      const toProcess = popped
        ? popped.rawElements.map((x) => (x.date === raw.date ? raw : x))
        : [raw];
      for (const item of toProcess) processRaw(item);
    } else {
      processRaw(raw);
    }
    updateBi();
    if (onUpdate) onUpdate({ biList, barsUbi, rawIndex: i });
  }

  return { klines, mergedAll, barsUbi, biList };
}

// ---------------------------------------------------------------------------
// 对外结构映射
// ---------------------------------------------------------------------------

function isTopFx(fx: Fx): boolean {
  return fx.mark === 'G';
}

/** 把 FX 映射为旧契约的 Fraction（price/date/originalIndex 与 czsc FX 语义一致） */
function fxToFraction(fx: Fx): Fraction {
  const k2 = fx.elements[1] as NewBar;
  const rawElements = k2.rawElements && k2.rawElements.length > 0 ? k2.rawElements : [];
  let originalIndex = k2.strokeIndex ?? k2.index;
  if (rawElements.length > 0) {
    const matched = rawElements.find((x) => x.date === fx.date);
    if (matched) {
      originalIndex = matched.index;
    } else if (isTopFx(fx)) {
      originalIndex = rawElements.reduce((a, b) => (b.high > a.high ? b : a)).index;
    } else {
      originalIndex = rawElements.reduce((a, b) => (b.low < a.low ? b : a)).index;
    }
  }
  return {
    type: isTopFx(fx) ? 'TOP' : 'BOTTOM',
    price: fx.fx,
    index: k2.index,
    originalIndex,
    date: fx.date,
  };
}

/** 合并 K 线映射为旧契约 MergedKline */
function mergedAllToKlines(mergedAll: NewBar[]): MergedKline[] {
  return mergedAll.map((bar, i) => {
    const direction: Direction =
      i === 0 || bar.high > mergedAll[i - 1].high ? 'up' : 'down';
    const originalIndices = bar.rawElements.map((x) => x.index);
    return {
      high: bar.high,
      low: bar.low,
      direction,
      originalIndices,
      originalHigh: bar.rawElements.reduce((a, b) => Math.max(a, b.high), -Infinity),
      originalLow: bar.rawElements.reduce((a, b) => Math.min(a, b.low), Infinity),
    };
  });
}

/** 原始分型列表（只做 check_fx，不做同标记去重，保持旧契约的“原始分型”语义） */
function mergedAllToFractions(mergedAll: NewBar[]): Fraction[] {
  const fractions: Fraction[] = [];
  for (let i = 1; i < mergedAll.length - 1; i++) {
    const fx = checkFx(mergedAll[i - 1], mergedAll[i], mergedAll[i + 1]);
    if (fx) fractions.push(fxToFraction(fx));
  }
  return fractions;
}

interface StrokeMetric {
  length: number;
  powerPrice: number;
  powerVolume: number;
  /** 对齐 BI::get_high：max(fx_a.high, fx_b.high)，不是起点/终点分型价 */
  high: number;
  /** 对齐 BI::get_low：min(fx_a.low, fx_b.low) */
  low: number;
  /** fx_b 第 3 根合并 K 线内最后一根原始 K 线下标，对齐 fx_raw_bars(&fx_b).last() */
  fxBRawEndIndex: number;
  /** fx_b 全部原始 K 线的倒数第二根下标，对齐 fx_raw_bars(&fx_b)[len-2] */
  fxBPrevRawIndex: number;
  /** fx_a 全部原始 K 线的倒数第二根下标，对齐 fx_raw_bars(&fx_a)[len-2] */
  fxAPrevRawIndex: number;
}

const STROKE_METRICS = new WeakMap<Stroke, StrokeMetric>();
const BI_TO_STROKE = new WeakMap<Bi, Stroke>();

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Bi -> Stroke，并把 czsc BI 的力度指标缓存给买卖点判定使用 */
function biToStroke(bi: Bi): Stroke {
  const start = fxToFraction(bi.fxA);
  const end = fxToFraction(bi.fxB);
  const stroke: Stroke = {
    id: `stroke-${start.originalIndex}-${end.originalIndex}`,
    start,
    end,
    direction: bi.direction,
  };
  const bars = bi.bars;
  const powerVolume =
    bars.length > 2
      ? bars.slice(1, bars.length - 1).reduce((s, b) => s + (b.volume ?? 0), 0)
      : 0;
  const fxBThird = bi.fxB.elements[2] as NewBar;
  const fxBRawEndIndex =
    fxBThird.rawElements && fxBThird.rawElements.length > 0
      ? fxBThird.rawElements[fxBThird.rawElements.length - 1].index
      : end.originalIndex;
  STROKE_METRICS.set(stroke, {
    length: bars.length,
    powerPrice: round2(Math.abs(bi.fxB.fx - bi.fxA.fx)),
    powerVolume,
    high: Math.max(bi.fxA.high, bi.fxB.high),
    low: Math.min(bi.fxA.low, bi.fxB.low),
    fxBRawEndIndex,
    fxBPrevRawIndex: fxPrevRawIndex(bi.fxB),
    fxAPrevRawIndex: fxPrevRawIndex(bi.fxA),
  });
  return stroke;
}

/** fx_raw_bars(fx) 的倒数第二根原始 K 线下标（不足 2 根返回 -1） */
function fxPrevRawIndex(fx: Fx): number {
  const all = fx.elements.flatMap((e) => (e as NewBar).rawElements ?? []);
  return all.length >= 2 ? all[all.length - 2].index : -1;
}

function biToStrokeCached(bi: Bi): Stroke {
  let stroke = BI_TO_STROKE.get(bi);
  if (!stroke) {
    stroke = biToStroke(bi);
    BI_TO_STROKE.set(bi, stroke);
  }
  return stroke;
}

function biListToStrokes(biList: Bi[]): Stroke[] {
  return biList.map(biToStrokeCached);
}

// ---------------------------------------------------------------------------
// 线段：czsc-core 没有线段原语。这里把每笔的终点抽象为一根“无包含”的
// LevelBar（high = low = end.price），复用 check_fx / check_fxs 找出笔端点
// 序列中的顶/底分型（即线段转折点），再按最小 3 笔间隔连接成线段。
// 这是与 czsc 笔算法同构的递归构造，不是 czsc-core 的原有 API。
// ---------------------------------------------------------------------------

function strokesToSegments(strokes: Stroke[]): Segment[] {
  if (strokes.length < MIN_SEG_LEN) return [];

  const endpointBars: LevelBar[] = strokes.map((s, i) => ({
    index: i,
    date: s.end.date,
    high: s.end.price,
    low: s.end.price,
    strokeIndex: i,
  }));
  const fxs = checkFxs(endpointBars);
  if (fxs.length < 2) return [];

  interface TurnPoint {
    type: 'TOP' | 'BOTTOM';
    strokeIndex: number;
    price: number;
  }

  // 单遍连接：同类型保留更极端者，异类型且间隔 >= MIN_SEG_LEN 笔才连成线段
  const points: TurnPoint[] = [];
  for (const fx of fxs) {
    const strokeIndex = fx.elements[1].index;
    const point: TurnPoint = {
      type: isTopFx(fx) ? 'TOP' : 'BOTTOM',
      strokeIndex,
      price: fx.fx,
    };
    const last = points[points.length - 1];
    if (!last) {
      points.push(point);
      continue;
    }
    if (last.type === point.type) {
      const better =
        point.type === 'TOP' ? point.price > last.price : point.price < last.price;
      if (better) points[points.length - 1] = point;
    } else if (strokeIndex - last.strokeIndex >= MIN_SEG_LEN) {
      points.push(point);
    }
  }

  const segments: Segment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const curr = points[i];
    const nxt = points[i + 1];
    const startStroke = strokes[curr.strokeIndex];
    const endStroke = strokes[nxt.strokeIndex];
    if (!startStroke || !endStroke) continue;

    let direction: Direction;
    let start: Fraction;
    let end: Fraction;
    if (curr.type === 'TOP' && nxt.type === 'BOTTOM') {
      direction = 'down';
      // 顶分型取该笔的高点端点；底分型取该笔的低点端点
      start = startStroke.direction === 'down' ? startStroke.start : startStroke.end;
      end = endStroke.direction === 'up' ? endStroke.start : endStroke.end;
    } else if (curr.type === 'BOTTOM' && nxt.type === 'TOP') {
      direction = 'up';
      start = startStroke.direction === 'up' ? startStroke.start : startStroke.end;
      end = endStroke.direction === 'down' ? endStroke.start : endStroke.end;
    } else {
      continue;
    }

    segments.push({
      id: `segment-${start.originalIndex}-${end.originalIndex}`,
      start,
      end,
      direction,
    });
  }
  return segments;
}

// ---------------------------------------------------------------------------
// 中枢：逐行移植 czsc-core/analyze/utils.rs::get_zs_seq 与 objects/zs.rs::ZS
// ---------------------------------------------------------------------------

interface LineLike {
  direction: Direction;
  high: number;
  low: number;
  startIndex: number;
  endIndex: number;
}

interface ZsLike {
  lines: LineLike[];
  zg: number;
  zd: number;
  gg: number;
  dd: number;
}

function strokeToLine(s: Stroke): LineLike {
  return {
    direction: s.direction,
    high: Math.max(s.start.price, s.end.price),
    low: Math.min(s.start.price, s.end.price),
    startIndex: s.start.originalIndex,
    endIndex: s.end.originalIndex,
  };
}

function segmentToLine(s: Segment): LineLike {
  return {
    direction: s.direction,
    high: Math.max(s.start.price, s.end.price),
    low: Math.min(s.start.price, s.end.price),
    startIndex: s.start.originalIndex,
    endIndex: s.end.originalIndex,
  };
}

/** ZS::new：zg/zd 取前三笔，gg/dd 取全部 */
function makeZs(lines: LineLike[]): ZsLike {
  const first3 = lines.slice(0, 3);
  const zg = first3.reduce((a, l) => Math.min(a, l.high), Infinity);
  const zd = first3.reduce((a, l) => Math.max(a, l.low), -Infinity);
  const gg = lines.reduce((a, l) => Math.max(a, l.high), -Infinity);
  const dd = lines.reduce((a, l) => Math.min(a, l.low), Infinity);
  return { lines, zg, zd, gg, dd };
}

/** ZS::is_valid */
function isZsValid(zs: ZsLike): boolean {
  if (zs.zg < zs.zd) return false;
  return zs.lines.every((l) => {
    const highIn = l.high <= zs.zg && l.high >= zs.zd;
    const lowIn = l.low <= zs.zg && l.low >= zs.zd;
    const contains = l.high >= zs.zg && l.low <= zs.zd;
    return highIn || lowIn || contains;
  });
}

/**
 * 连续笔 -> 中枢序列。对齐 get_zs_seq：
 * 当新笔与当前中枢“明显离开”（向上笔高点 < zd，或向下笔低点 > zg）时切分，
 * 否则并入当前中枢并重新用前三笔计算 zg/zd。
 */
function getZsSeq(lines: LineLike[]): ZsLike[] {
  const zsList: ZsLike[] = [];
  for (const line of lines) {
    const last = zsList.pop();
    if (!last) {
      zsList.push(makeZs([line]));
      continue;
    }
    if (
      (line.direction === 'up' && line.high < last.zd) ||
      (line.direction === 'down' && line.low > last.zg)
    ) {
      zsList.push(last);
      zsList.push(makeZs([line]));
    } else {
      zsList.push(makeZs([...last.lines, line]));
    }
  }
  return zsList;
}

function zsSeqToHubs(zsList: ZsLike[], level: number): Hub[] {
  return zsList
    .filter((zs) => zs.lines.length >= 3 && zs.zg > zs.zd && isZsValid(zs))
    .map((zs) => {
      const startIndex = zs.lines[0].startIndex;
      const endIndex = zs.lines[zs.lines.length - 1].endIndex;
      return {
        id: `hub-${startIndex}-${endIndex}`,
        zg: zs.zg,
        zd: zs.zd,
        gg: zs.gg,
        dd: zs.dd,
        startIndex,
        endIndex,
        strokesCount: zs.lines.length,
        level,
      };
    });
}

// ---------------------------------------------------------------------------
// 买卖点
// ---------------------------------------------------------------------------

/** 笔高点 = max(fx_a.high, fx_b.high)，对齐 BI::get_high */
function strokeHigh(s: Stroke): number {
  const metric = STROKE_METRICS.get(s);
  if (metric) return metric.high;
  return Math.max(s.start.price, s.end.price);
}

/** 笔低点 = min(fx_a.low, fx_b.low)，对齐 BI::get_low */
function strokeLow(s: Stroke): number {
  const metric = STROKE_METRICS.get(s);
  if (metric) return metric.low;
  return Math.min(s.start.price, s.end.price);
}

/** 价差力度 = |终点价 - 起点价|，对齐 BI::get_power_price（保留 2 位小数） */
function strokePowerPrice(s: Stroke): number {
  const metric = STROKE_METRICS.get(s);
  if (metric) return metric.powerPrice;
  return round2(Math.abs(s.end.price - s.start.price));
}

/** 笔长度（去包含 K 线数量），对齐 BI::get_length */
function strokeLength(s: Stroke): number {
  const metric = STROKE_METRICS.get(s);
  if (metric) return metric.length;
  return s.end.index - s.start.index + 1;
}

/** 成交量力度：笔内部合并 K 线成交量之和（不含首尾），对齐 BI::get_power_volume */
function strokePowerVolume(s: Stroke, klines: Kline[]): number {
  const metric = STROKE_METRICS.get(s);
  if (metric) return metric.powerVolume;
  let vol = 0;
  for (let i = s.start.originalIndex + 1; i < s.end.originalIndex; i++) {
    vol += klines[i]?.volume ?? 0;
  }
  return vol;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * 一买结构判定（下跌趋势背驰）。逐行移植
 * czsc-signals/src/utils/cxt.rs::check_first_buy。
 */
export function checkFirstBuy(bis: Stroke[], klines: Kline[]): boolean {
  const n = bis.length;
  if (n < 3 || n % 2 !== 1) return false;
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
    Math.max(strokePowerPrice(prev), mean(keyBis.map(strokePowerPrice)));
  const bcVolume =
    strokePowerVolume(last, klines) <
    Math.max(
      strokePowerVolume(prev, klines),
      mean(keyBis.map((b) => strokePowerVolume(b, klines))),
    );
  const bcLength =
    strokeLength(last) < Math.max(strokeLength(prev), mean(keyBis.map(strokeLength)));
  return bcPrice && (bcVolume || bcLength);
}

/**
 * 一卖结构判定（上涨趋势背驰）。逐行移植
 * czsc-signals/src/utils/cxt.rs::check_first_sell。
 */
export function checkFirstSell(bis: Stroke[], klines: Kline[]): boolean {
  const n = bis.length;
  if (n < 3 || n % 2 !== 1) return false;
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
    Math.max(strokePowerPrice(prev), mean(keyBis.map(strokePowerPrice)));
  const bcVolume =
    strokePowerVolume(last, klines) <
    Math.max(
      strokePowerVolume(prev, klines),
      mean(keyBis.map((b) => strokePowerVolume(b, klines))),
    );
  const bcLength =
    strokeLength(last) < Math.max(strokeLength(prev), mean(keyBis.map(strokeLength)));
  return bcPrice && (bcVolume || bcLength);
}

const BS_LABELS: Record<BSPointType, string> = {
  B1: '一买',
  B2: '二买',
  B3: '三买',
  S1: '一卖',
  S2: '二卖',
  S3: '三卖',
};

/** 一类买卖点检测窗口，对齐 cxt_first_buy_V221126 的 [21..5] 奇数序列 */
const BS1_WINDOWS = [21, 19, 17, 15, 13, 11, 9, 7, 5];

/** cxt_third_bs_V230318 的默认均线周期 */
const BS3_MA_PERIOD = 34;
/** cxt_third_bs_V230318 的样本门槛：bi_list.len() >= di + 6（di = 1） */
const BS3_MIN_BI_COUNT = 7;

/**
 * 对齐 czsc-signals/src/utils/ta.rs::calc_sma_cache_style：
 * 前 n-1 位为 NaN；之后按 TA-Lib 的累计顺序（先减旧值、再加新值）求均值。
 */
function smaCacheStyle(series: number[], n: number): number[] {
  const out = new Array<number>(series.length).fill(NaN);
  if (series.length < n || n === 0) return out;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += series[i];
  out[n - 1] = sum / n;
  for (let i = n; i < series.length; i++) {
    sum -= series[i - n];
    sum += series[i];
    out[i] = sum / n;
  }
  return out;
}

/**
 * fx_b 第 3 根合并 K 线内最后一根原始 K 线的下标，对齐
 * cxt_third_bs_V230318 中 `fx_raw_bars(&bi.fx_b).last()` 的取值位置。
 * 快照缺失（外部传入的 Stroke）时退化为笔终点分型所在原始 K 线。
 */
function fxEndRawIndex(s: Stroke): number {
  const metric = STROKE_METRICS.get(s);
  return metric ? metric.fxBRawEndIndex : s.end.originalIndex;
}

export interface BSPointOptions {
  /**
   * 只在“已确认”的笔上判定买卖点：该笔之后必须已经存在下一笔。
   *
   * CZSC 的最后一笔仍可能被后续 K 线破坏并回滚；开启后只输出不会再被改写
   * 的点，与看板用完整数据算出的买卖点保持一致。
   */
  confirmedOnly?: boolean;
}

/**
 * 逐 bar 增量 replay 计算买卖点，对齐 czsc 信号调用的时点语义：
 * 每当 bi_list 状态（长度、最后一笔 sdt/edt）变化时，立即用当前笔表评估
 * cxt_first_buy/check_first_buy、check_first_sell、V230320、V230318，
 * 并记录每个 (类型, 笔下标) 的首次触发。这样最后一笔在延伸/回滚前产生的
 * 瞬时信号不会被最终笔表覆盖掉。
 *
 * - B1/S1：check_first_buy / check_first_sell（21..5 笔窗口）；
 * - B2/S2：cxt_second_bs_V230320（SMA21 辅助，最近 5 笔 + 至少 7 笔）；
 * - B3/S3：cxt_third_bs_V230318（SMA34 辅助，最近 5 笔 + 至少 7 笔）。
 */
const BS_TYPES: BSPointType[] = ['B1', 'S1', 'B2', 'S2', 'B3', 'S3'];

function detectFirstBS(recent: Stroke[], end: number, klines: Kline[]): BSPointType | null {
  for (const w of BS1_WINDOWS) {
    if (end + 1 < w) continue;
    const seg = recent.slice(recent.length - w);
    if (checkFirstBuy(seg, klines)) return 'B1';
    if (checkFirstSell(seg, klines)) return 'S1';
  }
  return null;
}

function detectSecondBS(recent: Stroke[], end: number, ma21: number[]): BSPointType | null {
  // cxt_second_bs_V230320：bi_list.len() >= di + 6（di=1），取最近 5 笔
  if (end < 6 || recent.length < 5) return null;
  const b1 = recent[recent.length - 5];
  const b3 = recent[recent.length - 3];
  const b5 = recent[recent.length - 1];
  const m1 = STROKE_METRICS.get(b1);
  const m3 = STROKE_METRICS.get(b3);
  const m5 = STROKE_METRICS.get(b5);
  if (!m1 || !m3 || !m5) return null;
  if (m1.fxBPrevRawIndex < 0 || m3.fxBPrevRawIndex < 0) return null;
  if (m5.fxAPrevRawIndex < 0 || m5.fxBPrevRawIndex < 0) return null;
  const b1Ma = ma21[m1.fxBPrevRawIndex];
  const b3Ma = ma21[m3.fxBPrevRawIndex];
  const b5MaA = ma21[m5.fxAPrevRawIndex];
  const b5MaB = ma21[m5.fxBPrevRawIndex];
  if (![b1Ma, b3Ma, b5MaA, b5MaB].every(Number.isFinite)) return null;
  const lc1 = m1.low < b1Ma && m3.low < b3Ma;
  if (b5.direction === 'down' && lc1 && b5MaA < b5MaB) return 'B2';
  const sc1 = m1.high > b1Ma && m3.high > b3Ma;
  if (b5.direction === 'up' && sc1 && b5MaA > b5MaB) return 'S2';
  return null;
}

function detectThirdBS(recent: Stroke[], end: number, ma34: number[]): BSPointType | null {
  // cxt_third_bs_V230318：bi_list.len() >= di + 6（di=1），取最近 5 笔
  if (end < BS3_MIN_BI_COUNT - 1 || recent.length < 5) return null;
  const b1 = recent[recent.length - 5];
  const b3 = recent[recent.length - 3];
  const b5 = recent[recent.length - 1];
  const zsZd = Math.max(strokeLow(b1), strokeLow(b3));
  const zsZg = Math.min(strokeHigh(b1), strokeHigh(b3));
  if (zsZd > zsZg) return null;
  const ma1 = ma34[fxEndRawIndex(b1)];
  const ma3 = ma34[fxEndRawIndex(b3)];
  const ma5 = ma34[fxEndRawIndex(b5)];
  if (![ma1, ma3, ma5].every(Number.isFinite)) return null;
  if (b5.direction === 'down' && strokeLow(b5) > zsZg && ma5 > ma3 && ma3 > ma1) return 'B3';
  if (b5.direction === 'up' && strokeHigh(b5) < zsZd && ma5 < ma3 && ma3 < ma1) return 'S3';
  return null;
}

/**
 * 一条命令式的增量回放：一次遍历 K 线同时得到最终笔表与全部信号触发集合。
 * 评估时机与参考实现一致：仅在 bi_list 状态变化时评估，避免逐 bar 重复计算。
 */
function analyzeWithSignals(klines: Kline[]): {
  core: CzscCore;
  events: Map<BSPointType, Set<number>>;
} {
  const closes = klines.map((k) => k.close);
  const ma21 = smaCacheStyle(closes, 21);
  const ma34 = smaCacheStyle(closes, BS3_MA_PERIOD);
  const events = new Map<BSPointType, Set<number>>();
  let prevKey: string | null = null;

  const record = (type: BSPointType | null, strokeIndex: number) => {
    if (!type) return;
    let bucket = events.get(type);
    if (!bucket) {
      bucket = new Set();
      events.set(type, bucket);
    }
    bucket.add(strokeIndex);
  };

  const core = analyzeCzscCore(klines, ({ biList }) => {
    if (biList.length === 0) return;
    const last = biList[biList.length - 1];
    const key = `${biList.length}|${last.fxA.date}|${last.fxB.date}`;
    if (key === prevKey) return;
    prevKey = key;
    const end = biList.length - 1;
    const recent = biList.slice(Math.max(0, end - 20)).map(biToStrokeCached);
    record(detectFirstBS(recent, end, klines), end);
    record(detectSecondBS(recent, end, ma21), end);
    record(detectThirdBS(recent, end, ma34), end);
  });

  return { core, events };
}

export interface BSPointOptions {
  /**
   * 只在“已确认”的笔上输出买卖点：该笔之后必须已经存在下一笔。
   *
   * CZSC 的最后一笔仍可能被后续 K 线破坏并回滚；开启后只输出不会再被改写
   * 的点。注意：信号本身仍按逐 bar replay 计算，此选项只影响输出过滤。
   */
  confirmedOnly?: boolean;
}

/**
 * 计算缠论三类买卖点（在 CZSC 笔序列之上）。内部使用逐 bar 增量 replay，
 * 与 czsc 的 `CZSC.update` + `call_signal` 时点语义一致。
 *
 * 返回按 originalIndex 升序的买卖点列表。
 */
export function calculateBSPoints(
  klines: Kline[],
  strokes: Stroke[],
  options: BSPointOptions = {},
): BSPoint[] {
  if (klines.length === 0 || strokes.length < 5) return [];
  const { events } = analyzeWithSignals(klines);
  return pointsFromEvents(events, strokes, options);
}

function pointsFromEvents(
  events: Map<BSPointType, Set<number>>,
  strokes: Stroke[],
  options: BSPointOptions = {},
): BSPoint[] {
  const points: BSPoint[] = [];
  const seen = new Set<string>();

  for (const type of BS_TYPES) {
    const bucket = events.get(type);
    if (!bucket) continue;
    for (const strokeIndex of [...bucket].sort((a, b) => a - b)) {
      if (options.confirmedOnly && strokeIndex >= strokes.length - 1) continue;
      const stroke = strokes[strokeIndex];
      if (!stroke) continue;
      const key = `${type}-${stroke.end.originalIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      points.push({
        id: `bs-${type}-${stroke.end.originalIndex}`,
        type,
        label: BS_LABELS[type],
        price: stroke.end.price,
        originalIndex: stroke.end.originalIndex,
        date: stroke.end.date,
        strokeIndex,
      });
    }
  }

  points.sort((a, b) => a.originalIndex - b.originalIndex || a.type.localeCompare(b.type));
  return points;
}

// ---------------------------------------------------------------------------
// 对外导出的分步 API（保持旧签名；生产流水线统一走 CZSC 增量分析）
// ---------------------------------------------------------------------------

/**
 * 合并存在包含关系的 K 线。
 * 对齐 czsc-core/analyze/utils.rs::remove_include（逐根推进版本）。
 */
export function mergeKlines(klines: Kline[]): MergedKline[] {
  const merged: NewBar[] = [];
  for (const k of klines) {
    const raw = rawFromKline(k, merged.length);
    if (merged.length < 2) {
      const bar = newBarFromRaw(raw);
      bar.index = merged.length;
      merged.push(bar);
      continue;
    }
    const { hasInclude, bar } = removeInclude(merged[merged.length - 2], merged[merged.length - 1], raw);
    if (hasInclude) {
      bar.index = merged.length - 1;
      merged[merged.length - 1] = bar;
    } else {
      bar.index = merged.length;
      merged.push(bar);
    }
  }
  return mergedAllToKlines(merged);
}

/**
 * 查找原始分型。
 * 对齐 czsc-core/analyze/utils.rs::check_fx（不做 check_fxs 的同标记去重）。
 */
export function findFractions(merged: MergedKline[], original: Kline[]): Fraction[] {
  const fractions: Fraction[] = [];
  for (let i = 1; i < merged.length - 1; i++) {
    const prev = merged[i - 1];
    const curr = merged[i];
    const next = merged[i + 1];
    const isTop =
      curr.high > prev.high && curr.high > next.high && curr.low > prev.low && curr.low > next.low;
    const isBottom =
      curr.low < prev.low && curr.low < next.low && curr.high < prev.high && curr.high < next.high;
    if (!isTop && !isBottom) continue;

    const candidate = curr.originalIndices;
    let best = candidate[0];
    for (const idx of candidate) {
      if (isTop ? original[idx].high > original[best].high : original[idx].low < original[best].low) {
        best = idx;
      }
    }
    fractions.push({
      type: isTop ? 'TOP' : 'BOTTOM',
      price: isTop ? original[best].high : original[best].low,
      index: i,
      originalIndex: best,
      date: original[best].date,
    });
  }
  return fractions;
}

/**
 * 画笔。
 *
 * 传入 klines 时走完整的 CZSC 增量算法（与看板/策略同一份结果）。
 * 未传 klines 时为兼容旧调用保留的分型序列兜底路径（生产流水线不会使用）。
 */
export function calculateStrokes(fractions: Fraction[], klines?: Kline[]): Stroke[] {
  if (klines && klines.length > 0) {
    return biListToStrokes(analyzeCzscCore(klines).biList);
  }
  return connectFractionsByDistance(fractions, 4);
}

/** 旧版按“分型间隔”连接的兜底实现，仅用于 calculateStrokes 的兼容调用 */
function connectFractionsByDistance(fractions: Fraction[], minDistance: number): Stroke[] {
  const points: Fraction[] = [];
  for (const fx of fractions) {
    const last = points[points.length - 1];
    if (!last) {
      points.push(fx);
      continue;
    }
    if (fx.type === last.type) {
      const better = fx.type === 'TOP' ? fx.price > last.price : fx.price < last.price;
      if (better) points[points.length - 1] = fx;
    } else if (Math.abs(fx.index - last.index) >= minDistance) {
      points.push(fx);
    }
  }
  const strokes: Stroke[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const curr = points[i];
    const nxt = points[i + 1];
    if (curr.type === nxt.type) continue;
    strokes.push({
      id: `stroke-${curr.originalIndex}-${nxt.originalIndex}`,
      start: curr,
      end: nxt,
      direction: curr.type === 'TOP' ? 'down' : 'up',
    });
  }
  return strokes;
}

/**
 * 线段：把每笔抽象成一根无包含 K 线，复用 czsc 的 check_fx / check_bi。
 * czsc-core 未提供线段原语，这是与其笔算法保持同构的递归构造。
 */
export function calculateSegments(strokes: Stroke[]): Segment[] {
  return strokesToSegments(strokes);
}

/** 笔中枢：对齐 czsc-core/analyze/utils.rs::get_zs_seq */
export function calculateHubs(strokes: Stroke[]): Hub[] {
  return zsSeqToHubs(getZsSeq(strokes.map(strokeToLine)), 1);
}

/** 线段中枢：同一 get_zs_seq，作用在线段序列上（level = 2） */
export function calculateSegmentHubs(segments: Segment[]): Hub[] {
  return zsSeqToHubs(getZsSeq(segments.map(segmentToLine)), 2);
}

// ---------------------------------------------------------------------------
// 常用流水线组合 (浏览器 / Node 服务 / CLI 脚本共用)
// ---------------------------------------------------------------------------

export interface ChanlunStructures {
  mergedKlines: MergedKline[];
  fractions: Fraction[];
  strokes: Stroke[];
  segments: Segment[];
  hubs: Hub[];
}

function buildStructures(core: CzscCore): ChanlunStructures {
  const strokes = biListToStrokes(core.biList);
  return {
    mergedKlines: mergedAllToKlines(core.mergedAll),
    fractions: mergedAllToFractions(core.mergedAll),
    strokes,
    segments: calculateSegments(strokes),
    hubs: calculateHubs(strokes),
  };
}

/** 完整缠论结构 (合并K线 -> 分型 -> 笔 -> 线段/中枢), 不含买卖点 */
export function computeChanlunStructures(klines: Kline[]): ChanlunStructures {
  return buildStructures(analyzeCzscCore(klines));
}

/** 笔 + 买卖点 (线段/中枢不参与买卖点判定, 跳过两遍计算保持轻量) */
export function computeStrokesAndBSPoints(klines: Kline[]): { strokes: Stroke[]; bsPoints: BSPoint[] } {
  const { core, events } = analyzeWithSignals(klines);
  const strokes = biListToStrokes(core.biList);
  return { strokes, bsPoints: pointsFromEvents(events, strokes) };
}

/** 完整缠论流水线: 结构 + 买卖点（一次增量回放同时产出两者） */
export function runChanlunPipeline(
  klines: Kline[],
): ChanlunStructures & { bsPoints: BSPoint[] } {
  const { core, events } = analyzeWithSignals(klines);
  const structures = buildStructures(core);
  return {
    ...structures,
    bsPoints: pointsFromEvents(events, structures.strokes),
  };
}
