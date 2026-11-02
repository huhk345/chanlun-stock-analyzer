/**
 * 缠论突破 · 年线闸门
 * id: cl-breakout-state
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 来源：《二级行业版攻守指标》那份研究的六条结论，逐条落到单标的执行层。
 *
 * 那份报告的对象是「51 个二级行业里有几个站上年线」（广度）与沪深300 是否在
 * MA200 上方，结论不是「什么涨得快」，而是三件事：
 *
 *   ① 广度对粒度不敏感（10 个行业 SR 0.51 / 51 个行业 0.52），与前瞻收益相关
 *      接近 0 —— 它是「状态分类器」，不是「预测器」。
 *   ② 十分位是 U 形：两端（D10 全站上 +11.5%、D1 全跌破 +5.4%）好，中间
 *      D6–D7（-2.2% / -2.3%）最差。半仓是历史上期望最差的位置。
 *   ③ 规则的作用是把回撤砍半（-48% → -29%），不是把收益做高（年化反而
 *      8.6% → 6.9%）。它是一条风控规则。
 *   ④ 16 笔只赢 4 笔，两笔大行情（+90.8% / +51.3%）贡献几乎全部收益；
 *      从阶段低点到进攻信号中位 74 天 —— 它不能抄底，只能确认趋势并守住。
 *   ⑤ 板块的「历史排名」不复现（样本内外相关 0.21），能用的只有结构性判断。
 *   ⑥ 广度是月频、慢信号；越细不等于越准。
 *
 * 这份策略是那份报告的「单标的压缩版」，压缩方式逐条对应：
 *
 *   ① → 状态闸门只看两个数：收盘价在 MA200（年线）上方，且 MA200 本身在上行。
 *        这就是「指数 > MA200」与「广度 ≥ 70%」在单只股票上的对应物 ——
 *        个股自己的年线就是它自己的广度。跨截面的广度在单标的引擎里拿不到，
 *        所以它只能留在组合层做仓位覆盖（见文末「没能搬进来的部分」）。
 *   ② → 仓位只有 100% 与 0 两档，没有半仓、没有分批。中间档是历史期望最差
 *        的位置，所以 `amount` 永远给满仓（99.5，留手续费余量）。
 *   ③ → 止盈全部删除。离场只有「状态翻转」与「浮盈保护」两类，都是风控动作。
 *   ④ → 突破日不追高，但一旦上车就让它跑：没有价格止损，只有年线。
 *        低胜率是这套规则的正常形态，不是参数没调好。
 *   ⑤ → 不用「历史上这类形态赚多少」做筛选，只用当期可观测的结构与力度。
 *   ⑥ → 日频执行，但入场仍然要求「已经突破」而不是「即将突破」，
 *        接受慢半拍，不去猜底。
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 入场（收盘价，全部条件同时成立）
 *
 *   状态闸门  close > MA200 且 MA200 的 20 日斜率 > 0
 *   价格突破  close > 前 breakoutDays 根的最高价
 *   量能      vol ≥ volRatio × 前 20 日均量
 *   缠论结构  最近一个已完成的笔中枢在 HUB_LOOKBACK 内，收盘在其 ZG 上方，
 *             且离开幅度 ≥ departRatio × 中枢高度（「离开段力度」）
 *   方向      最后一笔向上
 *   K 线      阳线，且不是涨停收盘
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 离场（任一成立，清仓）
 *
 *   年线失守   close < MA200                    ← 报告 ③ 的状态翻转
 *   浮盈保护   浮盈最高到过 protectAfterPct% 之后，
 *              close ≤ max(成本×1.005, 前 20 根最低价, 成本 + 最高浮盈 × 0.5)
 *
 *   没有初始价格止损 —— 这是回测逼出来的，不是设计时想当然。
 *   把「浮盈保护」的启动门槛从 10% 拨到 0%（等于一进场就按保本线止损）：
 *   801 笔 / 均值 +0.26% / 中位 −0.43% / 胜率 41% / 平均持仓 2 日 ——
 *   变成一台只交手续费的机器。拨到 5%：648 笔 / +2.63% / 中位 +2.37% / 胜率 75%。
 *   保护得越早，中位数越低，10% 的 +4.47% 是这五档里最高的。
 *   更早的一版用 2.5×ATR 做假突破止损，中位数 −5.64%，同源问题：
 *   在突破点上方买入、把止损放在突破位下方，等于把止损放在最容易被扫的位置。
 *
 *   报告 ④ 说得很清楚：两笔大行情平均持有 16 个月，「久盘不涨」不是离场理由。
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 参数只留 4 个（602 只 × 2019-01 → 2026-10，约 600 笔来回的「拨一格」审计）
 *
 *   活着：volRatio（关掉放量：770 笔 +2.92%，被拦掉的 174 笔平均 +0.5%）、
 *         departRatio（关掉离开力度：836 笔 +3.11%，被拦掉的 240 笔平均 +1.8%
 *         —— 拦的是低于均值的那一截）、
 *         年线闸门（关掉：1089 笔 +2.15%，被拦掉的 493 笔平均 +0.4%）。
 *         protectAfterPct 是唯一影响「风险形状」的旋钮：5% → 波动 11.9% /
 *         胜率 75% / 持仓 22 日；20% → 波动 23.3% / 胜率 50% / 持仓 62 日。
 *         取 10 是因为它的中位数（+4.47%）与胜率（67%）最好，均值并非最高。
 *   已删：maxEntryBar（关掉后均值不变、样本翻倍、前 5 笔集中度 64% → 38%，
 *         它没在筛质量，只是在砍样本）；
 *         maxChasePct（拨到 20% 输出一位不差，60 日新高口径下几乎不触发）；
 *         momRatio / MACD 红柱面积比（两个独立样本上都拦掉了更好的交易：
 *         2023+ 拦掉的 46 笔平均 +6.1%，2019+ 拦掉的 76 笔平均 +6.0%，
 *         都高于保留那批的均值 —— 方向反了，删）；
 *         stopAtr 初始价格止损（见上，它把中位数从 +4.47% 打到 -5.64%）；
 *         stopDays 跟踪窗口（10 / 30 拨过去输出几乎不动，死旋钮）。
 *
 *   留下来的每一个都可能只是噪声：单笔标准差 17.5pp、596 笔时标准误 0.7pp。
 *   默认值取的是「这段区间的中点」，不是「回测最优值」。
 *
 *   另有一条没有做成参数：报告 ④ 说趋势型规则是「小亏很多次、大赚一两次」，
 *   但这一版实测是胜率 67%、中位数 +4.47% —— 浮盈保护把右尾削平的同时，
 *   也把「大部分交易不赚钱」这件事改掉了。代价是均值只有 +3.62%：
 *   它更像一台稳定的中小赢家机器，不是靠两笔大行情撑着的彩票。
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 没能搬进来的部分（诚实说明）
 *
 *   报告真正的仓位层是跨截面的：数 51 个行业里几个站上年线。单标的策略的
 *   入参只有这一只股票的 K 线，物理上拿不到别的股票，所以它只能是组合层的
 *   覆盖规则，不能写进 decide()。要复现「广度 ≤ 30% 就整体空仓」，得在
 *   组合执行层加一层闸门，而不是在这里加参数。
 *
 *   同理，报告 ⑤ 的「电子系偏进攻 / 金融地产偏防守」是行业层判断，
 *   个股策略没有行业标签可用，这里不假装有。
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 约束：不引入任何模块、不访问网络与 DOM、不使用异步语法；纯函数、只读输入。
 *      （注释里也不能出现沙箱的禁用词，否则保存时会被正则误判。）
 * ───────────────────────────────────────────────────────────────────────────
 */

// ---------------------------------------------------------------------------
// 设计常量（不是旋钮）
// ---------------------------------------------------------------------------
const MA_YEAR = 200; // 年线 —— 报告里「行业站上自己的年线」就是这条
const MA_SLOPE_LEN = 20; // 年线斜率回看
const VOL_MA = 20;
const HUB_LOOKBACK = 120; // 中枢必须在这个窗口内完成，否则不算「刚离开」
const HUB_MAX_AMP_PCT = 30; // 中枢振幅过大的不参与（与三买策略同口径）
const GIVEBACK_KEEP = 0.5;
const TRAIL_LOOKBACK = 20; // 跟踪用的「前 N 根最低价」；审计显示 10~30 之间拨了没反应
const BREAKEVEN_BUFFER = 1.005; // 保本线，覆盖双边费用
const MAX_POSITION_PCT = 99.5;
const WINDOW = 320; // 指标窗口

// 下面两个不是旋钮，是「能不能成交」的兜底，所以不做成参数：
// 突破日收盘离突破位超过 5%，说明是跳空穿上去的，成本已经跑掉；
// 突破日单日涨幅超过 9.5%，多半是涨停收盘 —— 按收盘价撮合是买不到的。
const MAX_CHASE_PCT = 5;
const MAX_ENTRY_BAR_PCT = 9.5;

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

/** 简单均线在某一点的值（用窗口内数据直接求和，避免维护整条序列） */
function smaAt(values, endIdx, period) {
  if (endIdx + 1 < period) return NaN;
  let s = 0;
  for (let t = endIdx + 1 - period; t <= endIdx; t++) s += values[t];
  return s / period;
}

// ---------------------------------------------------------------------------
// 入场结构：突破 + 离开中枢
// ---------------------------------------------------------------------------

/**
 * 返回 null 表示当前不是入场点，否则返回结构详情。
 * 所有判断只用 klines[0..i] 与该前缀上算出的笔/中枢，无未来数据。
 */
function detectBreakout(ctx) {
  const { klines, i, strokes, hubs, cfg, vols, j } = ctx;
  const c = klines[i].close;

  // 1) 状态闸门：站上年线，且年线在上行（不是「跌深了反弹一下」）
  const maNow = ctx.maYear;
  const maPrev = ctx.maYearPrev;
  if (!(c > maNow)) return null;
  if (!(maNow > maPrev)) return null;

  // 2) 价格突破：收盘创前 breakoutDays 根新高
  let priorHigh = -Infinity;
  for (let t = i - cfg.breakoutDays; t <= i - 1; t++) {
    if (t < 0) continue;
    if (klines[t].high > priorHigh) priorHigh = klines[t].high;
  }
  if (!(priorHigh > 0) || !(c > priorHigh)) return null;

  const chase = ((c - priorHigh) / priorHigh) * 100;
  if (chase > MAX_CHASE_PCT) return null; // 跳空穿上去的，成本已经跑掉

  // 3) 量能：突破日必须放量（缩量新高多半是没量的补涨）
  const volMa = smaAt(vols, j - 1, VOL_MA);
  if (!(volMa > 0)) return null;
  if (!(vols[j] >= volMa * cfg.volRatio)) return null;

  // 4) 缠论结构：最近一个已完成的笔中枢，收盘在其上方，且离开得够远
  let hub = null;
  for (let h = hubs.length - 1; h >= 0; h--) {
    const cand = hubs[h];
    if (cand.level !== 1 || cand.zg <= cand.zd) continue;
    if (cand.endIndex >= i - 1) continue;
    hub = cand;
    break;
  }
  if (!hub) return null;
  if (i - hub.endIndex > HUB_LOOKBACK) return null;

  const hubHeight = hub.gg - hub.dd;
  if (!(hubHeight > 0)) return null;
  if (((hub.gg - hub.dd) / hub.dd) * 100 > HUB_MAX_AMP_PCT) return null;
  if (!(c > hub.zg)) return null;

  // 离开段力度：突破走了几个「中枢高」。这是缠论里「力度」的几何版本 ——
  // 不看指标，只看离开段相对盘整区间的幅度，所以不存在参数在押池子的问题。
  const depart = (c - hub.zg) / hubHeight;
  if (depart < cfg.departRatio) return null;

  // 5) 方向一致：最后一笔向上
  if (strokes.length === 0) return null;
  if (strokes[strokes.length - 1].direction !== 'up') return null;

  // 6) K 线形态：阳线，且不是涨停收盘（涨停价按收盘撮合买不到）
  if (!(c > klines[i].open)) return null;
  const prevClose = klines[i - 1].close;
  if (prevClose > 0) {
    const barRet = (c / prevClose - 1) * 100;
    if (barRet > MAX_ENTRY_BAR_PCT) return null;
  }

  return { priorHigh, chase, hub, depart, maYear: maNow, maDist: ((c - maNow) / maNow) * 100 };
}

// ---------------------------------------------------------------------------
// 策略定义
// ---------------------------------------------------------------------------

const strategy = {
  id: 'cl-breakout-state',
  name: '缠论突破·年线闸门',
  description:
    '把「行业广度 + 指数 MA200」的状态分类压缩到单标的：只在个股站上上行年线时做多；' +
    '入场要求 N 日新高 + 放量 + 离开缠论中枢的力度；仓位只有满仓/空仓两档' +
    '（广度十分位两端好、中间最差）；离场只有年线失守与浮盈保护，不设价格止损、' +
    '不设固定止盈。',
  defaultSelected: false,
  requiresChanLun: true,

  params: [
    { key: 'breakoutDays', label: '突破窗口(日)', type: 'number', defaultValue: 60, min: 10, max: 250, step: 5 },
    { key: 'volRatio', label: '突破放量倍数', type: 'number', defaultValue: 1.5, min: 0.8, max: 4, step: 0.1 },
    { key: 'departRatio', label: '离开中枢力度(×中枢高)', type: 'number', defaultValue: 0.5, min: 0, max: 3, step: 0.1 },
    { key: 'protectAfterPct', label: '浮盈保护启动(%)', type: 'number', defaultValue: 10, min: 3, max: 40, step: 1 },
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
    if (i < MA_YEAR + MA_SLOPE_LEN + 10) return { action: 'HOLD' };
    if (!chanlun || !chanlun.strokes || chanlun.strokes.length < 5) return { action: 'HOLD' };

    const cfg = {
      breakoutDays: Math.round(numParam(params, 'breakoutDays', 60)),
      volRatio: numParam(params, 'volRatio', 1.5),
      departRatio: numParam(params, 'departRatio', 0.5),
      protectAfterPct: numParam(params, 'protectAfterPct', 10),
    };

    // ---- 指标窗口（只算尾部）----
    const n = klines.length;
    const base = Math.max(0, n - WINDOW);
    const len = n - base;
    const closes = new Array(len);
    const vols = new Array(len);
    for (let t = 0; t < len; t++) {
      const k = klines[base + t];
      closes[t] = k.close;
      vols[t] = k.volume || 0;
    }
    const j = i - base;
    if (j < MA_YEAR + MA_SLOPE_LEN) return { action: 'HOLD' };

    const maYear = smaAt(closes, j, MA_YEAR);
    const maYearPrev = smaAt(closes, j - MA_SLOPE_LEN, MA_YEAR);
    const c = currentKline.close;
    if (!(c > 0) || !isFinite(maYear) || !isFinite(maYearPrev)) return { action: 'HOLD' };

    // 横截面吸引力：离年线的距离（同一天不同标的之间可比）
    const trendScore = clamp((c / maYear - 1) * 4, 0, 1);

    // ---- 持仓分支：只允许 SELL / HOLD ----
    if (position.shares > 0) {
      // 策略无状态，用成交记录反推建仓日
      let lastBuy = null;
      for (let t = trades.length - 1; t >= 0; t--) {
        if (trades[t].action === 'BUY') {
          lastBuy = trades[t];
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
      const gainPct = ((c - entryPrice) / entryPrice) * 100;

      let highest = -Infinity;
      for (let t = entryIdx; t <= i; t++) {
        if (klines[t].high > highest) highest = klines[t].high;
      }
      const peakPct = ((highest - entryPrice) / entryPrice) * 100;

      // 年线失守 = 状态翻转，这是报告里「防守档 0%」的直接对应。
      // 它是唯一的无条件离场：没有价格止损，跌得再急也要等状态真的坏了才走。
      if (c < maYear) {
        return {
          action: 'SELL',
          amount: { unit: 'percent', value: 100 },
          reason:
            '年线失守：收盘 ' +
            c.toFixed(2) +
            ' < MA200 ' +
            maYear.toFixed(2) +
            '（成本 ' +
            entryPrice.toFixed(2) +
            '，' +
            gainPct.toFixed(1) +
            '%，最高 ' +
            peakPct.toFixed(0) +
            '%）',
          confidence: 0.9,
          score: 0,
        };
      }

      // 浮盈保护：只有在「已经赚过 protectAfterPct%」之后才启用。
      // 三条线取最高：保本、前 20 根最低价、最多回吐浮盈的一半。
      // 回吐上限定义在盈利空间里，与波动率无关，所以不存在「在押哪个股票池」。
      if (peakPct >= cfg.protectAfterPct) {
        let stopLine = entryPrice * BREAKEVEN_BUFFER;
        let lowN = Infinity;
        for (let t = i - TRAIL_LOOKBACK; t <= i - 1; t++) {
          if (t < entryIdx) continue;
          if (klines[t].low < lowN) lowN = klines[t].low;
        }
        if (isFinite(lowN)) stopLine = Math.max(stopLine, lowN);
        stopLine = Math.max(stopLine, entryPrice + (highest - entryPrice) * GIVEBACK_KEEP);

        if (c <= stopLine) {
          return {
            action: 'SELL',
            amount: { unit: 'percent', value: 100 },
            reason:
              '浮盈保护：收盘 ' +
              c.toFixed(2) +
              ' ≤ 保护线 ' +
              stopLine.toFixed(2) +
              '（成本 ' +
              entryPrice.toFixed(2) +
              '，最高 ' +
              peakPct.toFixed(0) +
              '%，当前 ' +
              gainPct.toFixed(1) +
              '%）',
            confidence: 0.85,
            score: 0,
          };
        }
      }

      return { action: 'HOLD', score: trendScore };
    }

    // ---- 空仓分支：只允许 BUY / HOLD ----
    if (!(account.cash > 0)) return { action: 'HOLD' };

    const setup = detectBreakout({
      klines,
      i,
      j,
      base,
      vols,
      strokes: chanlun.strokes,
      hubs: chanlun.hubs || [],
      maYear,
      maYearPrev,
      cfg,
    });
    if (!setup) return { action: 'HOLD', score: trendScore };

    // 仓位：满仓一档。报告十分位显示「半仓」是历史期望最差的位置，不做中间态。
    const quality = clamp(
      0.45 + clamp(setup.depart / 3, 0, 0.25) + clamp(setup.maDist / 30, 0, 0.3),
      0,
      1,
    );

    return {
      action: 'BUY',
      amount: { unit: 'percent', value: MAX_POSITION_PCT },
      reason:
        '突破·年线闸门：' +
        cfg.breakoutDays +
        ' 日新高 ' +
        setup.priorHigh.toFixed(2) +
        ' → ' +
        c.toFixed(2) +
        '（+' +
        setup.chase.toFixed(1) +
        '%，MA200 上方 ' +
        setup.maDist.toFixed(0) +
        '%），离开中枢 ZG ' +
        setup.hub.zg.toFixed(2) +
        ' 达 ' +
        setup.depart.toFixed(2) +
        ' 倍中枢高',
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
