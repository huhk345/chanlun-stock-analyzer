/**
 * 缠论 · 顺势三买（突破回踩）
 * id: cl-trend-b3-pullback
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 设计取舍（对齐 chanlun-pro 的三买定义 + 本仓库的 UserStrategyDefinition）
 *
 * 1. 买点只认缠论买点
 *    主信号 = 三买：向上离开中枢、回抽不回中枢（chanlun-pro 文档原义，
 *             strategy_zs_tupo / strategy_last_zs_3mmd 的实现口径）。
 *    辅信号 = 二买：一买（底背驰）之后回调不创新低。
 *    一买逆势，与「顺势」冲突，本策略不做。
 *
 * 2. 顺势
 *    EMA 多头排列 + 中期均线上行 + 中枢上移/线段向上 作为环境过滤。
 *    环境不对时，再标准的三买也不做（这是本策略与裸三买最大的区别）。
 *
 * 3. 突破回踩
 *    三买本身就是「突破—回踩—不回中枢」的几何结构。这里把它量化成
 *    五个可调约束：突破幅度、回踩深度、回踩时长、回踩缩量、追高上限。
 *    另外要求「反包确认」（收盘站上前一根高点），避免在下跌途中接刀。
 *
 * 4. 卖点动态化（不设固定止盈百分比）
 *    结构止损（跌破回踩低点/跌回中枢）
 *      → 顶背驰（MACD 红柱面积衰竭）
 *      → 保本移动（+1R 后止损抬到成本）
 *      → 跟踪止盈（Chandelier：最高价 - N×ATR）
 *      → 分批止盈（+2R 卖 1/3，+3.5R 再卖一半）
 *      → 时间止损（久盘不涨）
 *
 * 5. 仓位
 *    按 R 风险平价：单笔风险 = 权益 × riskPerTradePct%，除以每股风险得到股数，
 *    再折算成 percent 交给撮合层（100 股整手由引擎处理）。
 *    每股风险超过 maxRiskPct 直接放弃这笔交易——止损太远说明买点结构不干净。
 *
 * 约束：不引入任何模块、不访问网络与 DOM、不使用异步语法；纯函数、只读输入。
 *      （注释里也不能出现沙箱的禁用词，否则保存时会被正则误判。）
 * ───────────────────────────────────────────────────────────────────────────
 */

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 参数取数：非有限数字时回落到默认值 */
function numParam(params, key, def) {
  const v = params ? params[key] : undefined;
  return typeof v === 'number' && isFinite(v) ? v : def;
}

function boolParam(params, key, def) {
  const v = params ? params[key] : undefined;
  return typeof v === 'boolean' ? v : def;
}

/** EMA，用首值做种子；配合 300 根左右的窗口，EMA60 的预热偏差可忽略 */
function emaSeries(values, period) {
  const out = new Array(values.length);
  if (values.length === 0) return out;
  const k = 2 / (period + 1);
  let prev = values[0];
  out[0] = prev;
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** MACD(12,26,9)，hist = (DIF - DEA) × 2，与前端 MACD 口径一致 */
function macdSeries(closes, fast, slow, signal) {
  const ef = emaSeries(closes, fast);
  const es = emaSeries(closes, slow);
  const dif = new Array(closes.length);
  for (let i = 0; i < closes.length; i++) dif[i] = ef[i] - es[i];
  const dea = emaSeries(dif, signal);
  const hist = new Array(closes.length);
  for (let i = 0; i < closes.length; i++) hist[i] = (dif[i] - dea[i]) * 2;
  return { dif, dea, hist };
}

/** Wilder ATR */
function atrSeries(highs, lows, closes, period) {
  const n = closes.length;
  const out = new Array(n);
  if (n === 0) return out;
  let sum = 0;
  for (let i = 1; i < n; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    );
    if (i <= period) {
      sum += tr;
      out[i] = sum / i;
    } else {
      out[i] = (out[i - 1] * (period - 1) + tr) / period;
    }
  }
  out[0] = highs[0] - lows[0];
  return out;
}

function avgRange(arr, from, to) {
  const a = Math.max(0, from);
  const b = Math.min(arr.length - 1, to);
  if (b < a) return 0;
  let s = 0;
  for (let i = a; i <= b; i++) s += arr[i];
  return s / (b - a + 1);
}

/** 区间内 MACD 柱面积（positive=true 取红柱，false 取绿柱绝对值） */
function macdArea(hist, fromAbs, toAbs, base, positive) {
  let a = fromAbs + 1 - base;
  let b = toAbs - base;
  if (a < 0) a = 0;
  if (b > hist.length - 1) b = hist.length - 1;
  if (b < a) return 0;
  let s = 0;
  for (let i = a; i <= b; i++) {
    const h = hist[i];
    if (positive ? h > 0 : h < 0) s += Math.abs(h);
  }
  return s;
}

/** 取某个原始索引之前最近的顶分型 */
function lastTopBefore(fractions, absIdx) {
  for (let i = fractions.length - 1; i >= 0; i--) {
    const f = fractions[i];
    if (f.type === 'TOP' && f.originalIndex < absIdx) return f;
  }
  return null;
}

/**
 * 分型去重（两遍过滤，与 chanlun.ts 的 _connectFenxingToStroke 同规则）。
 *
 * `chanlun.fractions` 是原始分型，不保证顶底交替——同一段上涨里可能连着出现
 * 两个顶分型，拿它们做背驰比较等于比较两根相邻 K 线，必然误判。背驰必须在
 * 严格交替的分型序列上算，所以这里先做一次与「画笔」相同的去重。
 */
function connectFractions(points, minDistance) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const fx = points[i];
    if (out.length === 0) {
      out.push(fx);
      continue;
    }
    const last = out[out.length - 1];
    if (fx.type === last.type) {
      const better = fx.type === 'TOP' ? fx.price > last.price : fx.price < last.price;
      if (better) out[out.length - 1] = fx;
    } else if (Math.abs(fx.index - last.index) >= minDistance) {
      out.push(fx);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 买点一：三买（突破中枢 → 回踩不回中枢）
// ---------------------------------------------------------------------------

/**
 * 返回 null 表示当前不是「三买·突破回踩」的入场点，否则返回结构详情。
 * 所有判断都只用 klines[0..i] 与在该前缀上算出的笔/中枢，无未来数据。
 */
function detectBreakoutPullback(ctx) {
  const { klines, i, strokes, hubs, cfg } = ctx;

  // 1) 最近一个已成立、且已经离开的笔中枢
  const validHubs = [];
  for (let h = 0; h < hubs.length; h++) {
    const hub = hubs[h];
    if (hub.level === 1 && hub.zg > hub.zd && hub.endIndex < i - 1) validHubs.push(hub);
  }
  if (validHubs.length === 0) return null;
  const hub = validHubs[validHubs.length - 1];
  if (i - hub.endIndex > cfg.hubLookbackBars) return null;

  // 中枢振幅过大的不参与（chanlun-pro: zf() <= 30 的经验值）
  const amp = ((hub.gg - hub.dd) / hub.dd) * 100;
  if (!(amp > 0) || amp > cfg.maxHubAmpPct) return null;

  // 2) 突破笔 = 中枢之后的第一根向上笔
  let brk = null;
  for (let s = 0; s < strokes.length; s++) {
    const st = strokes[s];
    if (st.start.originalIndex < hub.endIndex) continue;
    if (st.direction === 'up') {
      brk = st;
      break;
    }
  }
  if (!brk) return null;
  const brkHigh = Math.max(brk.start.price, brk.end.price);
  const brkEnd = brk.end.originalIndex;
  if (brkEnd > i - 1) return null; // 突破笔还没走完，谈不上回踩

  const range = brkHigh - hub.zg;
  if (range <= 0) return null;
  const brkPct = (range / hub.zg) * 100;
  if (brkPct < cfg.breakoutMinPct) return null; // 突破幅度不够，容易是假突破

  // 3) 回踩 = 突破笔结束之后的最低点
  let pullLow = Infinity;
  let pullIdx = -1;
  for (let t = brkEnd; t <= i; t++) {
    if (klines[t].low < pullLow) {
      pullLow = klines[t].low;
      pullIdx = t;
    }
  }
  if (!isFinite(pullLow) || pullIdx < 0) return null;

  const depth = (brkHigh - pullLow) / range;
  if (depth < cfg.pullbackMinRatio || depth > cfg.pullbackMaxRatio) return null;

  // 回踩不能跌回中枢——这是三买的定义本身
  if (pullLow < hub.zg * (1 - cfg.hubReentryTol / 100)) return null;

  const barsSinceLow = i - pullIdx;
  if (barsSinceLow < 1) return null; // 今天就是最低点，还没确认
  if (barsSinceLow > cfg.confirmWindow) return null; // 拖太久，已经不是「刚回踩完」

  // 4) 回踩必须缩量（突破放量、回踩缩量 = 筹码没散）
  const brkVol = avgRange(ctx.vols, brk.start.originalIndex - ctx.base, brkEnd - ctx.base);
  const pullVol = avgRange(ctx.vols, brkEnd - ctx.base, pullIdx - ctx.base);
  if (brkVol > 0 && pullVol > brkVol * cfg.volShrinkRatio) return null;

  // 5) 今日反包确认
  const c = klines[i].close;
  if (c <= hub.zg) return null;
  if (!(c > klines[i - 1].high)) return null; // 收盘站上前一根高点
  if (cfg.requireYang && !(c > klines[i].open)) return null; // 阳线
  if (c <= pullLow * 1.005) return null; // 离低点太近，没有确认力度

  const chase = ((c - pullLow) / pullLow) * 100;
  if (chase > cfg.maxChasePct) return null; // 追高保护

  // 6) 结构止损：回踩低点下方，且不低于中枢上沿的容忍位
  const stop0 = Math.max(
    pullLow * (1 - cfg.stopBufferPct / 100),
    hub.zg * (1 - cfg.hubReentryTol / 100),
  );

  return {
    type: 'B3',
    hub,
    brkHigh,
    brkPct,
    pullLow,
    pullIdx,
    depth,
    chase,
    volRatio: brkVol > 0 ? pullVol / brkVol : 1,
    stop0,
  };
}

// ---------------------------------------------------------------------------
// 买点二：二买（一买底背驰之后，回调不创新低）
// ---------------------------------------------------------------------------

function detectSecondBuy(ctx) {
  const { fractions, hist, base, i, klines, cfg } = ctx;
  const bottoms = [];
  for (let f = 0; f < fractions.length; f++) {
    const fr = fractions[f];
    if (fr.type === 'BOTTOM' && fr.originalIndex <= i) bottoms.push(fr);
  }
  if (bottoms.length < 3) return null;

  const b3 = bottoms[bottoms.length - 1]; // 二买（本次回调低点）
  const b2 = bottoms[bottoms.length - 2]; // 一买（背驰低点）
  const b1 = bottoms[bottoms.length - 3];

  if (!(b3.price > b2.price)) return null; // 二买必须不创新低
  if (!(b2.price < b1.price)) return null; // 一买必须创新低

  const t2 = lastTopBefore(fractions, b2.originalIndex);
  const t1 = lastTopBefore(fractions, b1.originalIndex);
  if (!t2 || !t1) return null;

  // 一买处必须底背驰：价格新低，但绿柱面积衰竭
  const a2 = macdArea(hist, t2.originalIndex, b2.originalIndex, base, false);
  const a1 = macdArea(hist, t1.originalIndex, b1.originalIndex, base, false);
  if (!(a1 > 0) || a2 >= a1 * cfg.divRatio) return null;

  const barsSinceLow = i - b3.originalIndex;
  if (barsSinceLow < 1 || barsSinceLow > cfg.confirmWindow) return null;

  const c = klines[i].close;
  if (!(c > klines[i - 1].high)) return null;
  if (!(c > b3.price * 1.005)) return null;

  return {
    type: 'B2',
    oneBuyLow: b2.price,
    low: b3.price,
    stop0: b3.price * (1 - cfg.stopBufferPct / 100),
  };
}

// ---------------------------------------------------------------------------
// 卖点：顶背驰
// ---------------------------------------------------------------------------

function detectTopDivergence(ctx) {
  const { fractions, hist, base, i, cfg } = ctx;
  const tops = [];
  const bottoms = [];
  for (let f = 0; f < fractions.length; f++) {
    const fr = fractions[f];
    if (fr.originalIndex > i) continue;
    if (fr.type === 'TOP') tops.push(fr);
    else bottoms.push(fr);
  }
  if (tops.length < 2) return null;
  const t2 = tops[tops.length - 1];
  const t1 = tops[tops.length - 2];
  if (i - t2.originalIndex > cfg.confirmWindow) return null; // 顶分型要新鲜
  if (!(t2.price > t1.price)) return null; // 必须创新高

  let b2 = null;
  let b1 = null;
  for (let k = bottoms.length - 1; k >= 0; k--) {
    if (!b2 && bottoms[k].originalIndex < t2.originalIndex) b2 = bottoms[k];
    else if (b2 && !b1 && bottoms[k].originalIndex < t1.originalIndex) b1 = bottoms[k];
    if (b1) break;
  }
  if (!b1 || !b2) return null;

  const a2 = macdArea(hist, b2.originalIndex, t2.originalIndex, base, true);
  const a1 = macdArea(hist, b1.originalIndex, t1.originalIndex, base, true);
  if (!(a1 > 0) || a2 >= a1 * cfg.divRatio) return null;

  return { topPrice: t2.price, areaRatio: a2 / a1 };
}

// ---------------------------------------------------------------------------
// 策略定义
// ---------------------------------------------------------------------------

const strategy = {
  id: 'cl-trend-b3-pullback',
  name: '缠论顺势三买·突破回踩',
  description:
    '只做缠论三买（突破中枢后回抽不回中枢），要求 EMA 多头排列的顺势环境；' +
    '突破幅度/回踩深度/回踩缩量/回踩时长四重约束过滤假突破；' +
    '卖点为结构止损 + 顶背驰 + 保本移动 + ATR 跟踪止盈 + R 倍数分批止盈。',
  defaultSelected: false,
  requiresChanLun: true,

  params: [
    // ---- 趋势环境 ----
    { key: 'maFast', label: '快线 EMA', type: 'number', defaultValue: 10, min: 3, max: 30, step: 1 },
    { key: 'maMid', label: '中线 EMA', type: 'number', defaultValue: 20, min: 10, max: 60, step: 1 },
    { key: 'maSlow', label: '慢线 EMA', type: 'number', defaultValue: 60, min: 30, max: 120, step: 5 },
    { key: 'slopeLen', label: '均线斜率回看(日)', type: 'number', defaultValue: 10, min: 3, max: 30, step: 1 },

    // ---- 中枢 / 突破 ----
    { key: 'hubLookbackBars', label: '中枢有效期(日)', type: 'number', defaultValue: 120, min: 30, max: 250, step: 10 },
    { key: 'maxHubAmpPct', label: '中枢最大振幅(%)', type: 'number', defaultValue: 30, min: 10, max: 80, step: 5 },
    { key: 'breakoutMinPct', label: '最小突破幅度(%)', type: 'number', defaultValue: 3, min: 0.5, max: 15, step: 0.5 },
    { key: 'hubReentryTol', label: '回踩入中枢容忍(%)', type: 'number', defaultValue: 0.5, min: 0, max: 3, step: 0.5 },

    // ---- 回踩 ----
    { key: 'pullbackMinRatio', label: '回踩深度下限', type: 'number', defaultValue: 0.2, min: 0.05, max: 0.6, step: 0.05 },
    { key: 'pullbackMaxRatio', label: '回踩深度上限', type: 'number', defaultValue: 0.85, min: 0.4, max: 1.0, step: 0.05 },
    { key: 'volShrinkRatio', label: '回踩量/突破量上限', type: 'number', defaultValue: 1.0, min: 0.3, max: 2.0, step: 0.1 },
    { key: 'confirmWindow', label: '回踩确认窗口(日)', type: 'number', defaultValue: 5, min: 1, max: 15, step: 1 },
    { key: 'maxChasePct', label: '追高上限(%)', type: 'number', defaultValue: 6, min: 1, max: 20, step: 1 },
    { key: 'requireYang', label: '要求阳线确认', type: 'boolean', defaultValue: true },

    // ---- 风险与仓位 ----
    { key: 'stopBufferPct', label: '结构止损缓冲(%)', type: 'number', defaultValue: 1.5, min: 0, max: 5, step: 0.5 },
    { key: 'maxRiskPct', label: '单笔最大风险(%)', type: 'number', defaultValue: 7, min: 2, max: 20, step: 1 },
    { key: 'riskPerTradePct', label: '单笔风险预算(权益%)', type: 'number', defaultValue: 1, min: 0.2, max: 5, step: 0.1 },
    { key: 'maxPositionPct', label: '单票仓位上限(%)', type: 'number', defaultValue: 100, min: 10, max: 100, step: 5 },

    // ---- 动态止盈 ----
    { key: 'breakevenR', label: '保本触发(R)', type: 'number', defaultValue: 1, min: 0.5, max: 3, step: 0.5 },
    { key: 'tp1R', label: '第一批止盈(R)', type: 'number', defaultValue: 2, min: 1, max: 6, step: 0.5 },
    { key: 'tp1Frac', label: '第一批比例(%)', type: 'number', defaultValue: 33, min: 10, max: 50, step: 1 },
    { key: 'tp2R', label: '第二批止盈(R)', type: 'number', defaultValue: 3.5, min: 2, max: 10, step: 0.5 },
    { key: 'tp2Frac', label: '第二批比例(%)', type: 'number', defaultValue: 50, min: 10, max: 60, step: 5 },
    { key: 'trailAtrMult', label: 'ATR 跟踪倍数', type: 'number', defaultValue: 2.5, min: 1, max: 6, step: 0.5 },
    { key: 'atrPeriod', label: 'ATR 周期', type: 'number', defaultValue: 14, min: 5, max: 40, step: 1 },
    { key: 'maxHoldBars', label: '最长持仓(日)', type: 'number', defaultValue: 60, min: 10, max: 200, step: 5 },

    // ---- 辅助买点 ----
    { key: 'enableB2', label: '启用二买(背驰回调)', type: 'boolean', defaultValue: true },
    { key: 'divRatio', label: '背驰衰竭阈值', type: 'number', defaultValue: 0.85, min: 0.5, max: 1.0, step: 0.05 },
  ],

  availableIndicators: [],
  requiredIndicators: [],

  decide(input) {
    const {
      klines,
      currentIndex,
      currentKline,
      account,
      position,
      trades: tradeLog,
      params,
      chanlun,
    } = input || {};
    const trades = tradeLog || [];

    if (!klines || !currentKline || !account || !position) return { action: 'HOLD' };
    const i = currentIndex;
    if (i < 80) return { action: 'HOLD' };
    if (!chanlun || !chanlun.strokes || chanlun.strokes.length < 5) return { action: 'HOLD' };

    // ---- 参数 ----
    const cfg = {
      maFast: numParam(params, 'maFast', 10),
      maMid: numParam(params, 'maMid', 20),
      maSlow: numParam(params, 'maSlow', 60),
      slopeLen: numParam(params, 'slopeLen', 10),
      hubLookbackBars: numParam(params, 'hubLookbackBars', 120),
      maxHubAmpPct: numParam(params, 'maxHubAmpPct', 30),
      breakoutMinPct: numParam(params, 'breakoutMinPct', 3),
      hubReentryTol: numParam(params, 'hubReentryTol', 0.5),
      pullbackMinRatio: numParam(params, 'pullbackMinRatio', 0.2),
      pullbackMaxRatio: numParam(params, 'pullbackMaxRatio', 0.85),
      volShrinkRatio: numParam(params, 'volShrinkRatio', 1.0),
      confirmWindow: Math.round(numParam(params, 'confirmWindow', 5)),
      maxChasePct: numParam(params, 'maxChasePct', 6),
      requireYang: boolParam(params, 'requireYang', true),
      stopBufferPct: numParam(params, 'stopBufferPct', 1.5),
      maxRiskPct: numParam(params, 'maxRiskPct', 7),
      riskPerTradePct: numParam(params, 'riskPerTradePct', 1),
      maxPositionPct: numParam(params, 'maxPositionPct', 100),
      breakevenR: numParam(params, 'breakevenR', 1),
      tp1R: numParam(params, 'tp1R', 2),
      tp1Frac: numParam(params, 'tp1Frac', 33),
      tp2R: numParam(params, 'tp2R', 3.5),
      tp2Frac: numParam(params, 'tp2Frac', 50),
      trailAtrMult: numParam(params, 'trailAtrMult', 2.5),
      atrPeriod: Math.round(numParam(params, 'atrPeriod', 14)),
      maxHoldBars: Math.round(numParam(params, 'maxHoldBars', 60)),
      enableB2: boolParam(params, 'enableB2', true),
      divRatio: numParam(params, 'divRatio', 0.85),
    };

    // ---- 指标窗口（只算尾部，保证逐日调用不至于 O(n²) 爆炸）----
    const n = klines.length;
    const base = Math.max(0, n - 320);
    const len = n - base;
    const closes = new Array(len);
    const highs = new Array(len);
    const lows = new Array(len);
    const vols = new Array(len);
    for (let t = 0; t < len; t++) {
      const k = klines[base + t];
      closes[t] = k.close;
      highs[t] = k.high;
      lows[t] = k.low;
      vols[t] = k.volume || 0;
    }

    const ef = emaSeries(closes, cfg.maFast);
    const em = emaSeries(closes, cfg.maMid);
    const es = emaSeries(closes, cfg.maSlow);
    const macd = macdSeries(closes, 12, 26, 9);
    const atr = atrSeries(highs, lows, closes, cfg.atrPeriod);

    const j = i - base;
    const c = currentKline.close;
    if (!(c > 0)) return { action: 'HOLD' };

    // ---- 趋势环境 ----
    const alignOk = ef[j] > em[j] && em[j] > es[j];
    const slopeOk = j - cfg.slopeLen >= 0 && em[j] > em[j - cfg.slopeLen];
    const strongTrend = alignOk && slopeOk;

    const segments = chanlun.segments || [];
    const segUp = segments.length > 0 && segments[segments.length - 1].direction === 'up';
    const hubs = chanlun.hubs || [];
    let prevHub = null;
    let lastHub = null;
    for (let h = 0; h < hubs.length; h++) {
      const hub = hubs[h];
      if (hub.level !== 1 || hub.endIndex >= i) continue;
      prevHub = lastHub;
      lastHub = hub;
    }
    const hubUp = !!(prevHub && lastHub && lastHub.zg > prevHub.zg);

    // 二买用更宽松的环境门槛：一买刚出现时均线还没排列好，要求「价格站上中线 + 中线不再下行」
    const mildTrend = c > em[j] && (j - cfg.slopeLen < 0 || em[j] >= em[j - cfg.slopeLen] * 0.999);

    // 背驰比较要用「严格交替」的分型序列（原始分型不保证交替）
    const swingPoints = connectFractions(connectFractions(chanlun.fractions || [], 4), 4);

    // 横截面吸引力：趋势强度 + 结构强度（供组合轮动比较，同一量纲 0~1）
    const trendScore = clamp(
      (ef[j] / em[j] - 1) * 250 +
        (em[j] / es[j] - 1) * 250 +
        (slopeOk ? 0.2 : 0) +
        (hubUp ? 0.15 : 0) +
        (segUp ? 0.1 : 0),
      0,
      1,
    );

    // ---- 持仓分支：只允许 SELL / HOLD ----
    if (position.shares > 0) {
      // 找到建仓那根 K 线（策略无状态，用成交记录反推）
      let lastBuy = null;
      let lastBuyPos = -1;
      for (let t = trades.length - 1; t >= 0; t--) {
        if (trades[t].action === 'BUY') {
          lastBuy = trades[t];
          lastBuyPos = t;
          break;
        }
      }
      let entryIdx = -1;
      if (lastBuy) {
        for (let t = i; t >= 0; t--) {
          if (klines[t].date === lastBuy.date) {
            entryIdx = t;
            break;
          }
        }
      }
      if (entryIdx < 0) entryIdx = Math.max(0, i - 1);

      const entryPrice = lastBuy && lastBuy.price > 0 ? lastBuy.price : position.averageCost;

      // 结构止损位：复现建仓时的「回踩低点」。
      // 先找建仓前最近的突破高点，再取它之后到建仓日的最低价——
      // 不能简单地取「最近 N 根最低价」，否则会把中枢内部的低点算进来，止损被无声放宽。
      let brkIdx = entryIdx;
      const scanFrom = Math.max(0, entryIdx - 40);
      for (let t = entryIdx - 1; t >= scanFrom; t--) {
        if (klines[t].high > klines[brkIdx].high) brkIdx = t;
      }
      let structLow = Infinity;
      for (let t = brkIdx; t <= entryIdx; t++) {
        if (klines[t].low < structLow) structLow = klines[t].low;
      }
      if (!isFinite(structLow)) structLow = entryPrice * (1 - cfg.maxRiskPct / 100);

      const stop0 = Math.min(structLow * (1 - cfg.stopBufferPct / 100), entryPrice * 0.999);
      const R = Math.max(entryPrice - stop0, entryPrice * 0.01);
      const unrealizedR = (c - entryPrice) / R;

      let highest = -Infinity;
      for (let t = entryIdx; t <= i; t++) {
        if (klines[t].high > highest) highest = klines[t].high;
      }
      const atrNow = isFinite(atr[j]) && atr[j] > 0 ? atr[j] : entryPrice * 0.02;

      // 止损线：结构止损 → 保本 → Chandelier 跟踪
      let stopLine = stop0;
      if (unrealizedR >= cfg.breakevenR) {
        stopLine = Math.max(stopLine, entryPrice * 1.005); // 覆盖双边费用
        stopLine = Math.max(stopLine, highest - cfg.trailAtrMult * atrNow);
      }

      // 分批止盈：只数「本次建仓之后」执行过几次，否则换仓后会把上一笔的止盈次数带过来
      let tpDone = 0;
      let divDone = 0;
      for (let t = lastBuyPos + 1; t < trades.length; t++) {
        const tr = trades[t];
        if (tr.action !== 'SELL' || !tr.reason) continue;
        if (tr.reason.indexOf('分批止盈') === 0) tpDone++;
        if (tr.reason.indexOf('顶背驰') === 0) divDone++;
      }

      if (c <= stopLine) {
        const tag = unrealizedR >= cfg.breakevenR ? '跟踪止盈' : '结构止损';
        return {
          action: 'SELL',
          amount: { unit: 'percent', value: 100 },
          reason:
            tag +
            '：收盘 ' +
            c.toFixed(2) +
            ' ≤ 止损线 ' +
            stopLine.toFixed(2) +
            '（成本 ' +
            entryPrice.toFixed(2) +
            '，' +
            unrealizedR.toFixed(1) +
            'R）',
          confidence: 0.9,
          score: trendScore,
        };
      }

      // 顶背驰：创新高但 MACD 红柱面积衰竭 → 缠论卖点。
      // 缠论里背驰是「力度衰竭」而非「立刻反转」：强趋势中先减半，趋势走坏或已到第二目标才清仓。
      // divDone 保证同一笔仓位只响应一次，否则顶分型在 5 日窗口内会天天成立，把仓位碎成渣。
      const div = detectTopDivergence({
        fractions: swingPoints,
        hist: macd.hist,
        base,
        i,
        cfg,
      });
      if (div && divDone === 0 && unrealizedR >= 0.5 && c < div.topPrice) {
        const keepRunner = strongTrend && unrealizedR < cfg.tp2R && tpDone === 0;
        return {
          action: 'SELL',
          amount: { unit: 'percent', value: keepRunner ? 50 : 100 },
          reason:
            '顶背驰：新高 ' +
            div.topPrice.toFixed(2) +
            ' 力度仅前段的 ' +
            (div.areaRatio * 100).toFixed(0) +
            '%，浮盈 ' +
            unrealizedR.toFixed(1) +
            'R' +
            (keepRunner ? '，趋势仍强减半留仓' : '，清仓'),
          confidence: 0.85,
          score: trendScore,
        };
      }

      if (unrealizedR >= cfg.tp2R && tpDone === 1) {
        return {
          action: 'SELL',
          amount: { unit: 'percent', value: cfg.tp2Frac },
          reason:
            '分批止盈2：' + unrealizedR.toFixed(1) + 'R ≥ ' + cfg.tp2R + 'R，减 ' + cfg.tp2Frac + '%',
          confidence: 0.8,
          score: trendScore,
        };
      }
      if (unrealizedR >= cfg.tp1R && tpDone === 0) {
        return {
          action: 'SELL',
          amount: { unit: 'percent', value: cfg.tp1Frac },
          reason:
            '分批止盈1：' + unrealizedR.toFixed(1) + 'R ≥ ' + cfg.tp1R + 'R，减 ' + cfg.tp1Frac + '%',
          confidence: 0.75,
          score: trendScore,
        };
      }

      // 时间止损：久盘不涨，占着仓位没有意义
      const heldBars = i - entryIdx;
      if (heldBars >= cfg.maxHoldBars && unrealizedR < 1) {
        return {
          action: 'SELL',
          amount: { unit: 'percent', value: 100 },
          reason: '时间止损：持仓 ' + heldBars + ' 日仍未走出 1R',
          confidence: 0.6,
          score: trendScore,
        };
      }

      return { action: 'HOLD', score: trendScore };
    }

    // ---- 空仓分支：只允许 BUY / HOLD ----
    if (!(account.cash > 0)) return { action: 'HOLD' };

    const ctx = {
      klines,
      i,
      base,
      vols,
      strokes: chanlun.strokes,
      hubs,
      fractions: swingPoints,
      hist: macd.hist,
      cfg,
    };

    let setup = null;
    if (strongTrend) setup = detectBreakoutPullback(ctx);
    if (!setup && cfg.enableB2 && mildTrend) setup = detectSecondBuy(ctx);
    if (!setup) return { action: 'HOLD', score: trendScore };

    // ---- R 风险平价仓位 ----
    const entry = c;
    const perShareRisk = entry - setup.stop0;
    if (!(perShareRisk > 0)) return { action: 'HOLD', score: trendScore };

    const riskPct = (perShareRisk / entry) * 100;
    if (riskPct > cfg.maxRiskPct) return { action: 'HOLD', score: trendScore };

    const equity = account.cash + (position.marketValue || 0);
    const riskCash = equity * (cfg.riskPerTradePct / 100);
    let pct = (riskCash / (perShareRisk * entry)) * 100;
    // 99.5 而非 100：给佣金/过户费留出余量，否则「按可用资金 100% 买入」会被费用顶穿
    pct = clamp(pct, 0, Math.min(cfg.maxPositionPct, 99.5));
    if (pct < 5) return { action: 'HOLD', score: trendScore }; // 仓位太小，不值得开

    const quality = clamp(
      (setup.type === 'B3'
        ? 0.45 +
          clamp(setup.brkPct / 10, 0, 0.25) +
          clamp((1 - setup.volRatio) * 0.3, 0, 0.2) +
          (hubUp ? 0.1 : 0)
        : 0.4) +
        trendScore * 0.3,
      0,
      1,
    );

    const reason =
      setup.type === 'B3'
        ? '三买·突破回踩：中枢 ZG ' +
          setup.hub.zg.toFixed(2) +
          ' 突破至 ' +
          setup.brkHigh.toFixed(2) +
          ' (+' +
          setup.brkPct.toFixed(1) +
          '%)，回踩 ' +
          setup.pullLow.toFixed(2) +
          ' 未回中枢（深度 ' +
          (setup.depth * 100).toFixed(0) +
          '%，量比 ' +
          setup.volRatio.toFixed(2) +
          '），反包确认' +
          (hubUp ? '｜中枢上移' : '')
        : '二买·背驰后不创新低：一买低点 ' +
          setup.oneBuyLow.toFixed(2) +
          '，本次回调 ' +
          setup.low.toFixed(2) +
          ' 未破前低，反包确认';

    return {
      action: 'BUY',
      amount: { unit: 'percent', value: Math.round(pct * 10) / 10 },
      reason: reason + '｜风险 ' + riskPct.toFixed(1) + '% 仓位 ' + pct.toFixed(0) + '%',
      confidence: Math.round(clamp(0.55 + quality * 0.4, 0, 0.95) * 100) / 100,
      score: clamp(quality * 0.7 + trendScore * 0.3, 0, 1),
    };
  },
};

if (typeof exports !== 'undefined') {
  exports.default = strategy;
} else if (typeof module !== 'undefined') {
  module.exports = strategy;
}
