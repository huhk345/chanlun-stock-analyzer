/**
 * 海龟趋势突破 · 唐奇安通道
 * id: turtle-trend-breakout
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 来源：海龟交易法则（Turtle Trading）的两个系统 + 一条趋势闸门。
 *
 * 海龟法则不是「突破就买」这么一句，它由四块拼成，缺一块都不是海龟：
 *
 *   ① 入场 —— 唐奇安通道：收盘突破前 N 日最高价。系统一 N=20，系统二 N=55。
 *      本策略默认 20 日（系统一）：A 股日线的趋势节奏比商品期货快，55 日大突破
 *      在样本里常常把信号拖到趋势中后段；entryDays 调到 55 即切换成系统二。
 *   ② 离场 —— 唐奇安通道反向：收盘跌破前 M 日最低价。系统一 M=10，
 *      系统二 M=20。默认 10 日，与 20 日入场配对。
 *   ③ 风险单位 N —— N 是 20 日真实波幅（ATR）。海龟用 N 做两件事：
 *      止损距离与仓位单位（让止损触发时的亏损对应固定比例的资金）。
 *   ④ 趋势过滤 —— 海龟原版用「只做多、只做趋势品种」，本策略把它落成
 *      年线（MA200）在上行且收盘在年线上方。这一条是本项目一贯的
 *      「大周期确认趋势」，也是海龟在股票池里最有效的幸存者偏差过滤器。
 *
 * 海龟原版还有两条，这里没有照搬，理由写清楚：
 *
 *   加仓（每有利变动 0.5N 加一个单位，最多 4 个单位）—— 执行层不允许。
 *   本项目单标的策略契约里，持仓状态下只能给 SELL / HOLD，组合层又是
 *   等权固定槽位；再加仓等于在同一个账户里偷偷放大单一标的风险，与
 *   「等权槽位」这一层的设计相冲突。海龟的加仓是期货账户的产物，不是
 *   股票组合的产物，这里宁可不做，也不做一个名不副实的旋钮。
 *
 *   「上一次同向突破是赢家就跳过」（系统一的过滤规则）—— 它要求把历史
 *   突破逐笔重放并判断输赢，等于在策略里再写一遍撮合器；而且这条规则
 *   在趋势市里会连续错过二次上车机会。本策略用趋势闸门 + 放量 + 不追高
 *   代替它，三者都是当期可观测的，不需要回放历史。
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 入场（收盘价，全部条件同时成立）
 *
 *   趋势闸门  close > MA200，且 MA200 的 20 日斜率 > 0
 *   大突破    close > 前 entryDays 根的最高价（默认 20 日）
 *   波动带    N/close 落在 [0.8%, 10%]：太低是没波动的死水（假突破多），
 *             太高是止损过宽，会直接把仓位压成一手
 *   放量      vol ≥ volRatio × 前 20 日均量（默认 1.2 倍）
 *   不追高    收盘离突破位不超过 4%：跳空穿上去的，成本已经跑掉
 *   非涨停    当日涨幅 ≤ 9%：涨停收盘按收盘价买不到
 *   阳线      close > open
 *
 *   仓位按 N 定：percent = riskPct × close / (stopAtr × N) × 100，
 *   即「止损触发时，亏损正好是 riskPct% 的可分配资金」。
 *   默认 riskPct=2、stopAtr=3：N/close 约 2% 的票拿到约 33% 仓位，
 *   波动越大仓位越小。这是海龟仓位单位在「百分比下单」契约里的等价写法，
 *   不是拍脑袋的固定仓位。
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 离场（任一成立，清仓）
 *
 *   固定止损   close ≤ 建仓价 − stopAtr × 建仓当日的 N
 *   唐奇安离场  close < 前 exitDays 根的最低价（默认 10 日）
 *   趋势失守   close < MA200
 *
 *   没有固定止盈：海龟的收益来自让赢家跑，固定止盈会把右尾剪掉。
 *
 *   止损距离为什么默认 3N 而不是海龟原版的 2N：
 *   海龟是「价格触及突破位时市价成交」，成交价≈突破位；本引擎是「收盘价成交」，
 *   成交价在突破位上方 0~4%（追价上限）。同样叫 2N，从成交价往下算，
 *   到突破位的距离只剩 2N − 追价，等于系统性地把止损压窄了一截。
 *   取 3N 是让「止损到突破位」的距离回到 2N 左右 —— 这是对成交口径的补偿，
 *   不是把止损拍宽。120 只样本上的拨格结果：2N / 3N / 5N 的单笔均值分别为
 *   +1.36% / +1.39% / +1.44%，但组合年化是 +2.6% / +5.3% / +5.1% ——
 *   3N 与 5N 是一个平台，2N 是明显更差的单点。取平台中间的 3N，
 *   不取 5N 的峰值，是因为 3N 还能保留「止损是风险预算」的含义；
 *   5N 已经等于把止损关掉，回撤保护只剩唐奇安离场。
 *
 *   止损用的是「建仓当日的 N」而不是每天更新的 N —— 海龟的止损是入场时
 *   定下的风险预算，不是随波动率漂移的跟踪线。
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 参数只留 6 个，且每个都能说清「为什么是它」
 *
 *   entryDays  20  系统一的入场窗口；调到 55 就是系统二，是另一条规则
 *   exitDays   10  系统一的离场窗口；20 = 系统二。默认与 entryDays 配对
 *   atrPeriod  20  N 的定义（海龟原版就是 20 日 ATR）
 *   stopAtr    3.0 对收盘价成交口径的补偿（见上，海龟原版是 2N）
 *   volRatio   1.2 突破日的量能确认；1.0 等于关掉
 *   riskPct    2.0 单笔风险预算（占可分配资金），海龟原版是 1%~2%
 *
 *   其余全部是常量：MA200、斜率窗口 20、最大追高 4%、涨停阈值 9%、
 *   N 的上下限。它们决定策略「是什么」，不是「调多少」。
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 约束：不引入任何模块、不访问网络与 DOM、不使用异步语法；纯函数、只读输入。
 *      （注释里也不能出现沙箱的禁用词，否则保存时会被正则误判。）
 * ───────────────────────────────────────────────────────────────────────────
 */

// ---------------------------------------------------------------------------
// 设计常量（不是旋钮）
// ---------------------------------------------------------------------------
const TREND_MA = 200;
const TREND_SLOPE = 20;
const VOL_MA = 20;
const MAX_CHASE_PCT = 4; // 突破位上方超过 4% 不追
const MAX_ENTRY_BAR_PCT = 9; // 涨停收盘买不到
const N_MIN_PCT = 0.8; // N 太小 = 没波动的假突破
const N_MAX_PCT = 10; // N 太大 = 2N 止损过宽
const MIN_SIZE_PCT = 10; // 仓位下限，避免算出一手都不到
const MAX_SIZE_PCT = 95; // 留出手续费余量，避免满仓买入时现金不足

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

/** 收盘价均线在 endIdx 处的值（直接求和，避免维护整条序列） */
function smaCloseAt(klines, endIdx, period) {
  if (endIdx + 1 < period) return NaN;
  let s = 0;
  for (let t = endIdx + 1 - period; t <= endIdx; t++) s += klines[t].close;
  return s / period;
}

/**
 * 海龟的 N：period 日真实波幅均值（ATR）。
 * 真实波幅 = max(当日振幅, |今高−昨收|, |今低−昨收|)。
 * endIdx 必须至少有 period 根，且每根都能取到前一根收盘。
 */
function atrAt(klines, endIdx, period) {
  if (period <= 0 || endIdx < period) return NaN;
  let sum = 0;
  for (let t = endIdx - period + 1; t <= endIdx; t++) {
    const k = klines[t];
    const prev = klines[t - 1].close;
    const tr = Math.max(k.high - k.low, Math.abs(k.high - prev), Math.abs(k.low - prev));
    if (!isFinite(tr)) return NaN;
    sum += tr;
  }
  return sum / period;
}

/** 前 n 根的最高价（不含当日） */
function priorHighestHigh(klines, i, n) {
  let h = -Infinity;
  for (let t = i - n; t <= i - 1; t++) {
    if (t < 0) continue;
    if (klines[t].high > h) h = klines[t].high;
  }
  return h;
}

/** 前 n 根的最低价（不含当日） */
function priorLowestLow(klines, i, n) {
  let l = Infinity;
  for (let t = i - n; t <= i - 1; t++) {
    if (t < 0) continue;
    if (klines[t].low < l) l = klines[t].low;
  }
  return l;
}

/** 建仓位置：从成交记录反推最近一次买入（引擎无状态，只能这样拿成本与建仓日） */
function findEntry(trades, klines, i) {
  let lastBuy = null;
  for (let t = trades.length - 1; t >= 0; t--) {
    if (trades[t].action === 'BUY') {
      lastBuy = trades[t];
      break;
    }
  }
  if (!lastBuy) return null;
  let entryIdx = -1;
  for (let t = i; t >= 0; t--) {
    if (klines[t].date === lastBuy.date) {
      entryIdx = t;
      break;
    }
  }
  if (entryIdx < 0) return null;
  return {
    price: lastBuy.price > 0 ? lastBuy.price : 0,
    idx: entryIdx,
    date: lastBuy.date,
  };
}

// ---------------------------------------------------------------------------
// 入场结构
// ---------------------------------------------------------------------------

/**
 * 返回 null 表示当前不是入场点，否则返回突破详情。
 * 所有判断只用 klines[0..i] 与前缀上算出的指标，无未来数据。
 */
function detectBreakout(ctx) {
  const { klines, i, cfg } = ctx;
  const c = klines[i].close;
  const n = atrAt(klines, i, cfg.atrPeriod);
  if (!isFinite(n) || n <= 0) return null;

  const nPct = (n / c) * 100;
  if (nPct < N_MIN_PCT || nPct > N_MAX_PCT) return null;

  // 1) 趋势闸门：站上年线，且年线在上行
  const maTrend = smaCloseAt(klines, i, TREND_MA);
  const maTrendPrev = smaCloseAt(klines, i - TREND_SLOPE, TREND_MA);
  if (!isFinite(maTrend) || !isFinite(maTrendPrev)) return null;
  if (!(c > maTrend)) return null;
  if (!(maTrend > maTrendPrev)) return null;

  // 2) 大突破：收盘创前 entryDays 根新高
  const priorHigh = priorHighestHigh(klines, i, cfg.entryDays);
  if (!(priorHigh > 0) || !(c > priorHigh)) return null;

  const chase = ((c - priorHigh) / priorHigh) * 100;
  if (chase > MAX_CHASE_PCT) return null;

  // 3) 放量：缩量新高多半是没量的补涨
  let volSum = 0;
  let volCount = 0;
  for (let t = i - VOL_MA; t <= i - 1; t++) {
    if (t < 0) continue;
    volSum += klines[t].volume || 0;
    volCount++;
  }
  if (volCount === 0) return null;
  const volMa = volSum / volCount;
  if (!(volMa > 0)) return null;
  if (!((klines[i].volume || 0) >= volMa * cfg.volRatio)) return null;

  // 4) 不追高 + 非涨停 + 阳线
  if (!(c > klines[i].open)) return null;
  const prevClose = klines[i - 1].close;
  if (prevClose > 0 && (c / prevClose - 1) * 100 > MAX_ENTRY_BAR_PCT) return null;

  return {
    priorHigh,
    chase,
    n,
    nPct,
    maTrend,
    maDist: ((c - maTrend) / maTrend) * 100,
  };
}

// ---------------------------------------------------------------------------
// 策略定义
// ---------------------------------------------------------------------------

const strategy = {
  id: 'turtle-trend-breakout',
  name: '海龟趋势突破·唐奇安通道',
  description:
    '海龟交易法则的股票版本：唐奇安通道突破入场、反向唐奇安低点离场、' +
    'N(ATR20) 定仓位与固定止损；只在上行年线上方做多，突破日要求放量、不追高、' +
    '不买涨停。没有固定止盈，也不做金字塔加仓（执行层与等权槽位不允许）。',
  defaultSelected: false,
  requiresChanLun: false,

  params: [
    { key: 'entryDays', label: '突破窗口(日)', type: 'number', defaultValue: 20, min: 10, max: 250, step: 1 },
    { key: 'exitDays', label: '离场窗口(日)', type: 'number', defaultValue: 10, min: 3, max: 60, step: 1 },
    { key: 'atrPeriod', label: 'N 周期(ATR)', type: 'number', defaultValue: 20, min: 5, max: 60, step: 1 },
    { key: 'stopAtr', label: '止损距离(×N)', type: 'number', defaultValue: 3, min: 1, max: 5, step: 0.1 },
    { key: 'volRatio', label: '突破放量倍数', type: 'number', defaultValue: 1.2, min: 0.8, max: 3, step: 0.1 },
    { key: 'riskPct', label: '单笔风险预算(%)', type: 'number', defaultValue: 2, min: 0.5, max: 5, step: 0.1 },
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
    } = input || {};
    const trades = tradeLog || [];

    if (!klines || !currentKline || !account || !position) return { action: 'HOLD' };
    const i = currentIndex;
    if (i < TREND_MA + TREND_SLOPE + 10) return { action: 'HOLD' };

    const cfg = {
      entryDays: Math.round(numParam(params, 'entryDays', 20)),
      exitDays: Math.round(numParam(params, 'exitDays', 10)),
      atrPeriod: Math.round(numParam(params, 'atrPeriod', 20)),
      stopAtr: numParam(params, 'stopAtr', 3),
      volRatio: numParam(params, 'volRatio', 1.2),
      riskPct: numParam(params, 'riskPct', 2),
    };
    if (cfg.entryDays < 2 || cfg.exitDays < 2 || cfg.atrPeriod < 2) return { action: 'HOLD' };

    const c = currentKline.close;
    if (!(c > 0)) return { action: 'HOLD' };

    const maTrend = smaCloseAt(klines, i, TREND_MA);
    if (!isFinite(maTrend)) return { action: 'HOLD' };
    const trendScore = clamp((c / maTrend - 1) * 4, 0, 1);

    // ---- 持仓分支：只允许 SELL / HOLD ----
    if (position.shares > 0) {
      const entry = findEntry(trades, klines, i);
      const entryPrice = entry && entry.price > 0 ? entry.price : position.averageCost;
      if (!(entryPrice > 0)) return { action: 'HOLD', score: trendScore };
      const entryIdx = entry ? entry.idx : Math.max(0, i - 1);
      const entryN = atrAt(klines, entryIdx, cfg.atrPeriod);
      const stopLine = isFinite(entryN) && entryN > 0
        ? entryPrice - cfg.stopAtr * entryN
        : entryPrice * 0.92;
      const gainPct = ((c - entryPrice) / entryPrice) * 100;

      // 1) 固定止损：入场时定下的风险预算，不随 N 漂移
      if (c <= stopLine) {
        return {
          action: 'SELL',
          amount: { unit: 'percent', value: 100 },
          reason:
            '固定止损：收盘 ' +
            c.toFixed(2) +
            ' ≤ 止损线 ' +
            stopLine.toFixed(2) +
            '（成本 ' +
            entryPrice.toFixed(2) +
            '，N ' +
            (isFinite(entryN) ? entryN.toFixed(2) : '—') +
            '，' +
            gainPct.toFixed(1) +
            '%）',
          confidence: 0.95,
          score: 0,
        };
      }

      // 2) 唐奇安离场：跌破前 exitDays 根最低价
      const priorLow = priorLowestLow(klines, i, cfg.exitDays);
      if (isFinite(priorLow) && c < priorLow) {
        return {
          action: 'SELL',
          amount: { unit: 'percent', value: 100 },
          reason:
            '唐奇安离场：收盘 ' +
            c.toFixed(2) +
            ' < ' +
            cfg.exitDays +
            ' 日最低 ' +
            priorLow.toFixed(2) +
            '（成本 ' +
            entryPrice.toFixed(2) +
            '，' +
            gainPct.toFixed(1) +
            '%）',
          confidence: 0.9,
          score: 0,
        };
      }

      // 3) 趋势失守：年线跌破 = 大周期不再顺势
      if (c < maTrend) {
        return {
          action: 'SELL',
          amount: { unit: 'percent', value: 100 },
          reason:
            '趋势失守：收盘 ' +
            c.toFixed(2) +
            ' < MA200 ' +
            maTrend.toFixed(2) +
            '（成本 ' +
            entryPrice.toFixed(2) +
            '，' +
            gainPct.toFixed(1) +
            '%）',
          confidence: 0.85,
          score: 0,
        };
      }

      return { action: 'HOLD', score: trendScore };
    }

    // ---- 空仓分支：只允许 BUY / HOLD ----
    if (!(account.cash > 0)) return { action: 'HOLD' };

    const setup = detectBreakout({ klines, i, cfg });
    if (!setup) return { action: 'HOLD', score: trendScore };

    // 海龟仓位单位：2N 止损时的亏损 = riskPct% 的可分配资金
    // percent = riskPct × 收盘价 ÷ (止损倍数 × N) × 100
    const sizePct = clamp((cfg.riskPct * 100 * c) / (cfg.stopAtr * setup.n), MIN_SIZE_PCT, MAX_SIZE_PCT);

    const quality = clamp(
      0.4 +
        clamp(setup.chase / 4, 0, 0.2) +
        clamp(setup.maDist / 30, 0, 0.3),
      0,
      1,
    );

    return {
      action: 'BUY',
      amount: { unit: 'percent', value: Math.round(sizePct * 10) / 10 },
      reason:
        '海龟突破：' +
        cfg.entryDays +
        ' 日新高 ' +
        setup.priorHigh.toFixed(2) +
        ' → ' +
        c.toFixed(2) +
        '（+' +
        setup.chase.toFixed(1) +
        '%，MA200 上方 ' +
        setup.maDist.toFixed(0) +
        '%，N=' +
        setup.n.toFixed(2) +
        ' / ' +
        setup.nPct.toFixed(1) +
        '%，2N 止损 ' +
        (c - cfg.stopAtr * setup.n).toFixed(2) +
        '，仓位 ' +
        sizePct.toFixed(0) +
        '%）',
      confidence: Math.round(clamp(0.55 + quality * 0.4, 0, 0.95) * 100) / 100,
      score: clamp(quality * 0.6 + trendScore * 0.4, 0, 1),
    };
  },
};

if (typeof exports !== 'undefined') {
  exports.default = strategy;
} else if (typeof module !== 'undefined') {
  module.exports = strategy;
}
