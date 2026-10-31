/**
 * 缠论 · 顺势三买（突破回踩）
 * id: cl-trend-b3-pullback
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 设计取舍（对齐 chanlun-pro 的三买定义 + 本仓库的 UserStrategyDefinition）
 *
 * 1. 买点只认缠论买点
 *    三买：向上离开中枢、回抽不回中枢（chanlun-pro 文档原义，
 *          strategy_zs_tupo / strategy_last_zs_3mmd 的实现口径）。
 *    二买曾经做过（一买底背驰后回调不创新低），信号级实测单笔期望
 *    +1.7%（沪深300）/ +0.7%（中证500），远低于三买的 +7.9% / +1.2%，
 *    却要占掉一半以上的信号量，已整段删除。
 *
 * 2. 顺势
 *    EMA 10/20/60 多头排列 + EMA20 上行 + 中枢上移。这三个周期是「顺势」的
 *    定义，不做成参数——扫过，改了要么更差要么没差别。
 *
 * 3. 突破回踩
 *    三买本身就是「突破—回踩—不回中枢」的几何结构。这里把它量化成
 *    五个可调约束：突破幅度、回踩深度、回踩时长、回踩缩量、追高上限。
 *    另外要求「反包确认」（收盘站上前一根高点），避免在下跌途中接刀。
 *
 * 4. 卖点（不设固定止盈）
 *    结构止损（回踩低点 − N×ATR / 跌回中枢）
 *      → 顶背驰（MACD 红柱面积衰竭，+2R 以上才响应，每笔只响应一次）
 *      → 保本移动（+1R 后止损抬到成本）
 *      → 跟踪止盈（Chandelier：最高价 - 5×ATR）
 *      → 时间止损（120 日仍走不出 1R）
 *
 *    带 2R/3.5R 固定止盈的一组单笔期望只有 +2.6%，去掉固定止盈、让利润
 *    奔跑的一组是 +7.9%——固定止盈把右尾切掉了。所以止盈档位整段删除。
 *
 * 5. 仓位
 *    按 R 风险平价：单笔风险 = 权益 × riskPerTradePct%，除以每股风险得到股数，
 *    再折算成 percent 交给撮合层（100 股整手由引擎处理）。
 *    每股风险超过 maxRiskPct 直接放弃这笔交易——止损太远说明买点结构不干净。
 *    （这是回测面板的单标的引擎；Rust 池子引擎用等权槽位，没有这个参数。）
 *
 * 6. 止损距离与确认阳线（2026-10-31 归因结论）
 *    结构止损的缓冲按 ATR 计价（stopAtr = 2，即回踩低点下方 2 个 ATR）。
 *    固定 1.5% 在 A 股日线上只有 0.5~0.7 个 ATR，正常回踩就会被打掉：
 *    把止损距离按倍数放大后，两个股票池的三买信号收益同向单调改善。
 *    另外确认阳线本身要限幅（maxEntryBar）：入场日涨 2~4% 的一组比涨 0~2% 的
 *    一组差 3~4 个百分点，大阳线是「一日游」的典型形态，而追高上限（maxChasePct）
 *    衡量的是「离回踩低点多远」，管不住这件事。
 *
 * 7. 参数只留 11 个（+ 面板专有的仓位预算）
 *    46 个参数 / 80 笔来回，自由度比样本还大，多留一个旋钮就是多一次过拟合的机会。
 *    审计结果：46 个里 28 个拨动后输出完全不变（死旋钮），剩下的也只有
 *    突破/回踩/止损/跟踪四个方向是真活的。其余全部下沉成常量。
 *
 * 约束：不引入任何模块、不访问网络与 DOM、不使用异步语法；纯函数、只读输入。
 *      （注释里也不能出现沙箱的禁用词，否则保存时会被正则误判。）
 * ───────────────────────────────────────────────────────────────────────────
 */

// ---------------------------------------------------------------------------
// 设计常量（不是旋钮）
// ---------------------------------------------------------------------------
const MA_FAST = 10;
const MA_MID = 20;
const MA_SLOW = 60;
const SLOPE_LEN = 10;
const HUB_LOOKBACK_BARS = 120;
const MAX_HUB_AMP_PCT = 30;
const HUB_REENTRY_TOL = 0.5;
const ATR_PERIOD = 14;
const DIV_RATIO = 0.85;
const BREAKEVEN_R = 1;
const DIV_MIN_R = 2;
const TIME_STOP_R = 1;
const MAX_POSITION_PCT = 100;
const STOP_BUFFER_FALLBACK = 1.5;

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

/** 结构止损缓冲（%）：stopAtr > 0 时按 ATR 计价，否则回落到固定百分比 */
function structBufferPct(cfg, atrNow, price) {
  if (cfg.stopAtr > 0 && isFinite(atrNow) && atrNow > 0 && price > 0) {
    return Math.min(((cfg.stopAtr * atrNow) / price) * 100, 15);
  }
  return STOP_BUFFER_FALLBACK;
}

/** 确认阳线限幅：单日涨幅与振幅都不能超过 maxEntryBar（0 = 关闭） */
function entryBarOk(klines, i, cfg) {
  if (!(cfg.maxEntryBar > 0) || i < 1) return true;
  const prev = klines[i - 1].close;
  if (!(prev > 0)) return true;
  const barRet = (klines[i].close / prev - 1) * 100;
  const barRange = ((klines[i].high - klines[i].low) / prev) * 100;
  return barRet <= cfg.maxEntryBar && barRange <= cfg.maxEntryBar * 1.5;
}

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
  if (i - hub.endIndex > HUB_LOOKBACK_BARS) return null;

  // 中枢振幅过大的不参与（chanlun-pro: zf() <= 30 的经验值）
  const amp = ((hub.gg - hub.dd) / hub.dd) * 100;
  if (!(amp > 0) || amp > MAX_HUB_AMP_PCT) return null;

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
  if (pullLow < hub.zg * (1 - HUB_REENTRY_TOL / 100)) return null;

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
  if (!(c > klines[i].open)) return null; // 阳线
  if (c <= pullLow * 1.005) return null; // 离低点太近，没有确认力度

  const chase = ((c - pullLow) / pullLow) * 100;
  if (chase > cfg.maxChasePct) return null; // 追高保护
  if (!entryBarOk(klines, i, cfg)) return null; // 确认阳线本身太大

  // 6) 结构止损：回踩低点下方留缓冲（ATR 或固定百分比），且不低于中枢上沿的容忍位
  const buf = structBufferPct(cfg, ctx.atrNow, pullLow);
  const stop0 = Math.max(
    pullLow * (1 - buf / 100),
    hub.zg * (1 - HUB_REENTRY_TOL / 100),
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
  if (!(a1 > 0) || a2 >= a1 * DIV_RATIO) return null;

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
    '突破幅度/回踩深度/回踩缩量/回踩时长/确认阳线幅度五重约束过滤假突破；' +
    '卖点为结构止损（ATR 计价）+ 顶背驰 + 保本移动 + ATR 跟踪止盈，默认不设固定止盈。',
  defaultSelected: false,
  requiresChanLun: true,

  params: [
    // 11 个真正影响信号的参数，与 Rust 侧同名同默认值。
    // 均线周期 / 中枢参数 / 背驰阈值 / 保本与顶背驰门槛都下沉成常量了：
    // 46 个参数 / 80 笔来回，多留一个旋钮就是多一次过拟合的机会。
    { key: 'breakoutMinPct', label: '最小突破幅度(%)', type: 'number', defaultValue: 3, min: 0.5, max: 15, step: 0.5 },
    { key: 'pullbackMinRatio', label: '回踩深度下限', type: 'number', defaultValue: 0.3, min: 0.05, max: 0.6, step: 0.05 },
    { key: 'pullbackMaxRatio', label: '回踩深度上限', type: 'number', defaultValue: 0.7, min: 0.4, max: 1.0, step: 0.05 },
    { key: 'volShrinkRatio', label: '回踩量/突破量上限', type: 'number', defaultValue: 1.0, min: 0.3, max: 2.0, step: 0.1 },
    { key: 'confirmWindow', label: '回踩确认窗口(日)', type: 'number', defaultValue: 5, min: 1, max: 15, step: 1 },
    { key: 'maxChasePct', label: '追高上限(%)', type: 'number', defaultValue: 6, min: 1, max: 20, step: 1 },
    { key: 'maxEntryBar', label: '确认阳线最大涨幅%(0=关)', type: 'number', defaultValue: 4, min: 0, max: 10, step: 0.5 },
    { key: 'stopAtr', label: '结构止损 ATR 倍数', type: 'number', defaultValue: 2, min: 0, max: 4, step: 0.5 },
    { key: 'maxRiskPct', label: '单笔最大风险(%)', type: 'number', defaultValue: 12, min: 2, max: 20, step: 1 },
    { key: 'trailAtrMult', label: 'ATR 跟踪倍数', type: 'number', defaultValue: 5, min: 1, max: 8, step: 0.5 },
    { key: 'maxHoldBars', label: '最长持仓(日)', type: 'number', defaultValue: 120, min: 20, max: 250, step: 5 },
    // 面板专有：单标的引擎按 R 风险平价定仓位（Rust 池子引擎用等权槽位）
    { key: 'riskPerTradePct', label: '单笔风险预算(权益%)', type: 'number', defaultValue: 1, min: 0.2, max: 5, step: 0.1 },
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
      breakoutMinPct: numParam(params, 'breakoutMinPct', 3),
      pullbackMinRatio: numParam(params, 'pullbackMinRatio', 0.3),
      pullbackMaxRatio: numParam(params, 'pullbackMaxRatio', 0.7),
      volShrinkRatio: numParam(params, 'volShrinkRatio', 1.0),
      confirmWindow: Math.round(numParam(params, 'confirmWindow', 5)),
      maxChasePct: numParam(params, 'maxChasePct', 6),
      maxEntryBar: numParam(params, 'maxEntryBar', 4),
      stopAtr: numParam(params, 'stopAtr', 2),
      maxRiskPct: numParam(params, 'maxRiskPct', 12),
      trailAtrMult: numParam(params, 'trailAtrMult', 5),
      maxHoldBars: Math.round(numParam(params, 'maxHoldBars', 120)),
      riskPerTradePct: numParam(params, 'riskPerTradePct', 1),
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

    const ef = emaSeries(closes, MA_FAST);
    const em = emaSeries(closes, MA_MID);
    const es = emaSeries(closes, MA_SLOW);
    const macd = macdSeries(closes, 12, 26, 9);
    const atr = atrSeries(highs, lows, closes, ATR_PERIOD);

    const j = i - base;
    const c = currentKline.close;
    if (!(c > 0)) return { action: 'HOLD' };

    // ---- 趋势环境 ----
    const alignOk = ef[j] > em[j] && em[j] > es[j];
    const slopeOk = j - SLOPE_LEN >= 0 && em[j] > em[j - SLOPE_LEN];
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

      // 止损距离同样按 ATR 还原，否则回测中途止损线会比建仓时更紧，
      // 与「建仓那一刻算出来的 R」不是同一个东西。
      const atrNow = isFinite(atr[j]) && atr[j] > 0 ? atr[j] : entryPrice * 0.02;
      const bufPct = structBufferPct(cfg, atrNow, structLow);
      const stop0 = Math.min(structLow * (1 - bufPct / 100), entryPrice * 0.999);
      const R = Math.max(entryPrice - stop0, entryPrice * 0.01);
      const unrealizedR = (c - entryPrice) / R;

      let highest = -Infinity;
      for (let t = entryIdx; t <= i; t++) {
        if (klines[t].high > highest) highest = klines[t].high;
      }

      // 止损线：结构止损 → 保本 → Chandelier 跟踪
      let stopLine = stop0;
      if (unrealizedR >= BREAKEVEN_R) {
        stopLine = Math.max(stopLine, entryPrice * 1.005); // 覆盖双边费用
        stopLine = Math.max(stopLine, highest - cfg.trailAtrMult * atrNow);
      }

      // 顶背驰只响应一次：数「本次建仓之后」卖过几次，换仓后不会把上一笔的次数带过来
      let divDone = 0;
      for (let t = lastBuyPos + 1; t < trades.length; t++) {
        const tr = trades[t];
        if (tr.action === 'SELL' && tr.reason && tr.reason.indexOf('顶背驰') === 0) divDone++;
      }

      if (c <= stopLine) {
        const tag = unrealizedR >= BREAKEVEN_R ? '跟踪止盈' : '结构止损';
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
      if (div && divDone === 0 && unrealizedR >= DIV_MIN_R && c < div.topPrice) {
        const keepRunner = strongTrend;
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
      atrNow: atr[j],
      cfg,
    };

    let setup = null;
    if (strongTrend) setup = detectBreakoutPullback(ctx);
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
    pct = clamp(pct, 0, Math.min(MAX_POSITION_PCT, 99.5));
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
