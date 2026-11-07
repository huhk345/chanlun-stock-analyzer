//! Shared mechanics for the ChanLun B3 strategies.
//!
//! The B3 detection, position tracking and exit rules live here; each
//! registered strategy has its own file and supplies its own entry gate.

use crate::chanlun::{self, Fraction, FractionKind, Hub, Structures};
use crate::data::Bar;
use crate::indicators;
use crate::strategy::{DayContext, ParamSpec, Params, Signal};

use super::common::{
    avg_vol, tradable_frac, CL_WINDOW, GIVEBACK_KEEP, HUB_LOOKBACK, MAX_HUB_AMP,
};

pub(super) trait EntryGate {
    /// `Some(原因)` = 拒绝；`None` = 放行。
    fn block(
        &self,
        ctx: &DayContext<'_>,
        win: &[Bar],
        j: usize,
        setup: &Setup,
        atr_now: f64,
        closes: &[f64],
    ) -> Option<&'static str>;
}

// ---------------------------------------------------------------------------
// 5. ChanLun 顺势三买（突破回踩）
// ---------------------------------------------------------------------------

// ---- 设计常量（不是旋钮）---------------------------------------------------
// 这些值决定策略「是什么」，而不是「调多少」：
//   均线周期 = 顺势的定义；中枢参数 = 缠论的定义；背驰阈值 = 缠论的定义。
// 放在这里当常量，是因为它们从来没有被扫出过平台（改了要么更差要么没差别），
// 留在面板上只会诱导人去调一个没有信息量的旋钮。
const MA_FAST: usize = 10;
const MA_MID: usize = 20;
const MA_SLOW: usize = 60;
const SLOPE_LEN: usize = 10;
const HUB_REENTRY: f64 = 0.5;
const ATR_PERIOD: usize = 14;
const DIV_RATIO: f64 = 0.85;
const BREAKEVEN_R: f64 = 1.0;
const TIME_STOP_R: f64 = 1.0;
const DIV_MIN_R: f64 = 2.0;
/// 单笔仓位占权益的硬上限：不放大杠杆，满仓即止。
const MAX_SIZE_PCT: f64 = 99.5;
/// `stop_atr` 取不到 ATR 时的备用缓冲（%）
const STOP_BUFFER_FALLBACK: f64 = 1.5;
/// PQ 驱动的离场松紧（`pq_exit > 0` 才生效）：只对高分放宽，低分不动。
/// 锚点 45 是样本 PQ 中位，跨度 25 分到端点，k 夹在 [0, +1]。
/// 与 JS 侧 `PQ_EXIT_ANCHOR` / `PQ_EXIT_SPAN` 同名同值，改一边必须改另一边。
const PQ_EXIT_ANCHOR: f64 = 45.0;
const PQ_EXIT_SPAN: f64 = 25.0;

/// 真正影响信号的参数 + 一个仓位参数（`risk_pct` 只定仓，不影响买卖点）。
/// 其余全部下沉成常量或删掉：46 个参数 / 80 笔来回，自由度比样本还大，
/// 多留一个旋钮就是多一次过拟合的机会。
struct B3Config {
    breakout_min: f64,
    pullback_min: f64,
    pullback_max: f64,
    vol_shrink: f64,
    confirm_window: usize,
    max_chase: f64,
    max_entry_bar: f64,
    stop_atr: f64,
    max_risk: f64,
    trail_atr: f64,
    max_hold: usize,
    /// 单笔风险预算（权益 %）。仓位 = 预算 / 结构止损距离，参考海龟的 N 定仓。
    risk_pct: f64,
    /// 回踩质量分下限（0 = 关闭）
    min_pq: f64,
    /// 质量分调仓强度（0 = 等权，1 = 阈值处半仓）
    pq_sizing: f64,
    /// 质量分驱动的离场松紧（0 = 关闭，与改动前完全一致）
    pq_exit: f64,
}

impl B3Config {
    fn from_params(p: &Params) -> Self {
        let usize_of = |k: &str, d: f64| p.f64(k, d).max(1.0) as usize;
        Self {
            breakout_min: p.f64("breakout_min", 3.0),
            pullback_min: p.f64("pullback_min", 0.3),
            pullback_max: p.f64("pullback_max", 0.7),
            vol_shrink: p.f64("vol_shrink", 1.0),
            confirm_window: usize_of("confirm_window", 5.0),
            max_chase: p.f64("max_chase", 6.0),
            max_entry_bar: p.f64("max_entry_bar", 4.0).max(0.0),
            stop_atr: p.f64("stop_atr", 2.0).max(0.0),
            max_risk: p.f64("max_risk", 12.0),
            trail_atr: p.f64("trail_atr", 5.0).max(0.0),
            max_hold: usize_of("max_hold", 120.0),
            risk_pct: p.f64("risk_pct", 1.0).clamp(0.1, 10.0),
            min_pq: p.f64("min_pq", 0.0).clamp(0.0, 90.0),
            pq_sizing: p.f64("pq_sizing", 0.0).clamp(0.0, 1.0),
            pq_exit: p.f64("pq_exit", 0.0).clamp(0.0, 1.0),
        }
    }
}

/// 一个待执行的买点。
pub(super) struct Setup {
    label: &'static str,
    stop0: f64,
    reason: String,
    /// 0~1，由回踩质量分 PQ 归一化而来（与 JS 侧 `quality` 同义）
    quality: f64,
    /// 回踩质量分 0~100，仅用于展示与门控
    pub(super) pq: f64,
    /// 突破段的平均成交量 / 突破前 20 日均量（VMA 因子）
    pub(super) brk_vol_ratio: f64,
}

/// 回踩质量分 PQ（0~100），与 `src/strategies/cl-trend-b3-pullback.js` 的
/// `pullbackQuality()` 逐项对应，改一边必须改另一边。
///
///   深度分  回踩深度 30% → 65% 线性映射到 0~1（越深越好）
///   突破分  以 ATR 计的突破幅度，倒 U，峰值 5.8 ATR，3.0 / 8.6 两端归零
///   动量分  前 60 日涨幅除以其自身 60 日波动，越低越好
/// 权重 0.5 / 0.3 / 0.2。
///
/// 标定（沪深300 290 只 / 121 个信号 / 2019-2026，60 日超额）：
///   PQ<40 → −5.0%  PQ 40~50 → +4.2%  PQ 60~70 → +7.7%  PQ≥70 → +10.3%
///   分年 6/6 方向一致；前后两段 ρ 分别 +0.31 / +0.30。
/// PQ 与标的年化波动 (ρ=0.00)、年份 (ρ=+0.02) 无关 —— 它描述的是「这一次回踩的形态」。
fn pullback_quality(bars: &[Bar], j: usize, depth: f64, brk_pct: f64, atr_now: f64) -> f64 {
    const DEPTH_LO: f64 = 30.0;
    const DEPTH_HI: f64 = 65.0;
    const BRK_PEAK: f64 = 5.8;
    const BRK_LO: f64 = 3.0;
    const BRK_HI: f64 = 8.6;
    const MOM_CENTER: f64 = 1.5;
    const MOM_WIDTH: f64 = 1.2;

    let close = bars[j].close;
    if !(close > 0.0) {
        return 0.0;
    }

    // 1) 回踩深度
    let s_depth = ((depth * 100.0 - DEPTH_LO) / (DEPTH_HI - DEPTH_LO)).clamp(0.0, 1.0);

    // 2) 突破幅度（ATR 计）：倒 U
    let atr_pct = if atr_now > 0.0 {
        atr_now / close * 100.0
    } else {
        0.0
    };
    let s_brk = if atr_pct > 0.0 {
        let brk_atr = brk_pct / atr_pct;
        if brk_atr <= BRK_PEAK {
            ((brk_atr - BRK_LO) / (BRK_PEAK - BRK_LO)).clamp(0.0, 1.0)
        } else {
            ((BRK_HI - brk_atr) / (BRK_HI - BRK_PEAK)).clamp(0.0, 1.0)
        }
    } else {
        0.5
    };

    // 3) 前 60 日涨幅 / 自身 60 日波动
    let mut s_mom = 0.5;
    if j >= 61 {
        let ret60 = (close / bars[j - 60].close - 1.0) * 100.0;
        let mut sum = 0.0;
        let mut sum2 = 0.0;
        for t in (j - 19)..=j {
            let prev = bars[t - 1].close;
            if prev > 0.0 {
                let r = bars[t].close / prev - 1.0;
                sum += r;
                sum2 += r * r;
            }
        }
        let mean = sum / 20.0;
        let vol20 = (sum2 / 20.0 - mean * mean).max(0.0).sqrt() * 252f64.sqrt() * 100.0;
        if vol20 > 1.0 {
            let mom_z = ret60 / (vol20 * (60.0f64 / 252.0).sqrt());
            s_mom = ((MOM_CENTER - mom_z) / MOM_WIDTH).clamp(0.0, 1.0);
        }
    }

    100.0 * (0.5 * s_depth + 0.3 * s_brk + 0.2 * s_mom)
}

fn last_top_before(points: &[Fraction], idx: usize) -> Option<Fraction> {
    points
        .iter()
        .rev()
        .find(|f| f.kind == FractionKind::Top && f.original_index < idx)
        .copied()
}

fn last_bottom_before(points: &[Fraction], idx: usize) -> Option<Fraction> {
    points
        .iter()
        .rev()
        .find(|f| f.kind == FractionKind::Bottom && f.original_index < idx)
        .copied()
}

/// 确认阳线的形态门槛。
///
/// 「收盘 > 前一根最高价」这条反包确认，在弱势股上往往只能靠一根大阳线满足，
/// 而大阳线本身是「一日游 / 尾盘拉抬」的典型形态。信号级实测（沪深300 92 个
/// 三买信号、中证500 129 个）显示：入场日涨幅 2~4% 的一组 40 日收益比 0~2%
/// 的一组低 3~4 个百分点，且两个股票池方向一致。
fn entry_bar_ok(bars: &[Bar], j: usize, cfg: &B3Config) -> bool {
    if cfg.max_entry_bar <= 0.0 || j == 0 {
        return true;
    }
    let prev = bars[j - 1].close;
    if !(prev > 0.0) {
        return true;
    }
    let bar_ret = (bars[j].close / prev - 1.0) * 100.0;
    let bar_range = (bars[j].high - bars[j].low) / prev * 100.0;
    bar_ret <= cfg.max_entry_bar && bar_range <= cfg.max_entry_bar * 1.5
}

/// 结构止损位：回踩低点下方留 ATR 缓冲，且不低于中枢上沿的回踩容忍线。
///
/// 固定 1.5% 缓冲在 A 股日线上只有 0.5~0.7 个 ATR，正常回踩就会被打掉
/// （54% 的止损单在 20 日内反弹超过 5%）。改成按 ATR 计价后，止损距离与
/// 标的自身的噪声匹配；把止损距离按倍数放大时，两个股票池的三买信号收益
/// 都是同向单调改善的。
fn structural_stop(pull_low: f64, hub_zg: f64, cfg: &B3Config, atr_now: f64) -> f64 {
    let buffer_pct = if cfg.stop_atr > 0.0 && atr_now.is_finite() && atr_now > 0.0 && pull_low > 0.0 {
        (cfg.stop_atr * atr_now / pull_low * 100.0).min(15.0)
    } else {
        STOP_BUFFER_FALLBACK
    };
    (pull_low * (1.0 - buffer_pct / 100.0)).max(hub_zg * (1.0 - HUB_REENTRY / 100.0))
}

/// 三买 = 突破中枢上沿后回踩不回中枢。
fn detect_b3(bars: &[Bar], j: usize, st: &Structures, cfg: &B3Config, atr_now: f64) -> Option<Setup> {
    let hub: &Hub = st
        .hubs
        .iter()
        .filter(|h| h.zg > h.zd && h.end_index + 1 < j)
        .next_back()?;

    if j - hub.end_index > HUB_LOOKBACK {
        return None;
    }
    let amp = (hub.gg - hub.dd) / hub.dd * 100.0;
    if !(amp > 0.0) || amp > MAX_HUB_AMP {
        return None;
    }

    // 突破笔 = 中枢之后的第一根向上笔
    let brk = st
        .strokes
        .iter()
        .find(|s| s.start.original_index >= hub.end_index && s.up)?;
    let brk_high = brk.high();
    let brk_end = brk.end.original_index;
    if brk_end >= j {
        return None; // 突破笔还没走完
    }

    let range = brk_high - hub.zg;
    if range <= 0.0 {
        return None;
    }
    let brk_pct = range / hub.zg * 100.0;
    if brk_pct < cfg.breakout_min {
        return None;
    }

    // 回踩 = 突破笔结束之后的最低价
    let mut pull_low = f64::INFINITY;
    let mut pull_idx = 0usize;
    for t in brk_end..=j {
        if bars[t].low < pull_low {
            pull_low = bars[t].low;
            pull_idx = t;
        }
    }
    if !pull_low.is_finite() {
        return None;
    }

    let depth = (brk_high - pull_low) / range;
    if depth < cfg.pullback_min || depth > cfg.pullback_max {
        return None;
    }
    if pull_low < hub.zg * (1.0 - HUB_REENTRY / 100.0) {
        return None; // 回踩进了中枢，不是三买
    }
    let since_low = j - pull_idx;
    if since_low < 1 || since_low > cfg.confirm_window {
        return None;
    }

    let brk_vol = avg_vol(bars, brk.start.original_index, brk_end);
    let pull_vol = avg_vol(bars, brk_end, pull_idx);
    let vol_ratio = if brk_vol > 0.0 { pull_vol / brk_vol } else { 1.0 };
    if brk_vol > 0.0 && pull_vol > brk_vol * cfg.vol_shrink {
        return None;
    }

    let c = bars[j].close;
    if c <= hub.zg || c <= bars[j - 1].high || c <= bars[j].open {
        return None;
    }
    if c <= pull_low * 1.005 {
        return None;
    }
    let chase = (c - pull_low) / pull_low * 100.0;
    if chase > cfg.max_chase {
        return None;
    }
    if !entry_bar_ok(bars, j, cfg) {
        return None;
    }

    let stop0 = structural_stop(pull_low, hub.zg, cfg, atr_now);

    // 突破放量：突破段均量 / 突破前 20 日均量（VMA）
    let base_from = brk.start.original_index.saturating_sub(20);
    let base_to = brk.start.original_index.saturating_sub(1);
    let base_vol = if brk.start.original_index > base_from {
        avg_vol(bars, base_from, base_to)
    } else {
        0.0
    };
    let brk_vol_ratio = if base_vol > 0.0 { brk_vol / base_vol } else { 1.0 };

    let pq = pullback_quality(bars, j, depth, brk_pct, atr_now);

    Some(Setup {
        label: "三买·突破回踩",
        stop0,
        reason: format!(
            "三买·突破回踩：中枢 ZG {:.2} 突破至 {:.2} (+{:.1}%)，回踩 {:.2} 未回中枢（深度 {:.0}%，量比 {:.2}，突破量比 {:.2}x）｜质量 {:.0}",
            hub.zg,
            brk_high,
            brk_pct,
            pull_low,
            depth * 100.0,
            vol_ratio,
            brk_vol_ratio,
            pq
        ),
        // quality 直接取 PQ/100，on_day 里再与趋势强度合成 score。
        // 旧版这里是 0.45 + clamp(brk_pct/10) —— 奖励突破越远越好，实测方向是反的，已纠正。
        quality: (pq / 100.0).clamp(0.0, 1.0),
        pq,
        brk_vol_ratio,
    })
}

/// 顶背驰：创新高但 MACD 红柱面积衰竭。
fn top_divergence(
    st: &Structures,
    hist: &[f64],
    j: usize,
    cfg: &B3Config,
) -> Option<(f64, f64)> {
    let tops: Vec<&Fraction> = st
        .fractions
        .iter()
        .filter(|f| f.kind == FractionKind::Top && f.original_index <= j)
        .collect();
    if tops.len() < 2 {
        return None;
    }
    let t2 = tops[tops.len() - 1];
    let t1 = tops[tops.len() - 2];
    if j - t2.original_index > cfg.confirm_window || t2.price <= t1.price {
        return None;
    }
    let b2 = last_bottom_before(&st.fractions, t2.original_index)?;
    let b1 = last_bottom_before(&st.fractions, t1.original_index)?;
    let a2 = indicators::macd_area(hist, b2.original_index, t2.original_index, true);
    let a1 = indicators::macd_area(hist, b1.original_index, t1.original_index, true);
    if a1 <= 0.0 || a2 >= a1 * DIV_RATIO {
        return None;
    }
    Some((t2.price, a2 / a1))
}

pub(super) fn base_params() -> Vec<ParamSpec> {
    vec![
        ParamSpec::number("breakout_min", "最小突破 %", 3.0).with_range(0.5, 15.0, 0.5),
        ParamSpec::number("pullback_min", "回踩深度下限", 0.3).with_range(0.05, 0.6, 0.05),
        ParamSpec::number("pullback_max", "回踩深度上限", 0.7).with_range(0.4, 1.0, 0.05),
        ParamSpec::number("vol_shrink", "回踩量/突破量上限", 1.0).with_range(0.3, 2.0, 0.1),
        ParamSpec::number("confirm_window", "回踩确认窗口 日", 5.0).with_range(1.0, 15.0, 1.0),
        ParamSpec::number("max_chase", "追高上限 %", 6.0).with_range(1.0, 20.0, 1.0),
        ParamSpec::number("max_entry_bar", "确认阳线最大涨幅 % (0=关)", 4.0)
            .with_range(0.0, 10.0, 0.5),
        ParamSpec::number("stop_atr", "结构止损 ATR 倍数", 2.0).with_range(0.0, 4.0, 0.5),
        ParamSpec::number("max_risk", "单笔最大风险 %", 12.0).with_range(2.0, 20.0, 1.0),
        ParamSpec::number("trail_atr", "ATR 跟踪倍数", 5.0).with_range(1.0, 8.0, 0.5),
        ParamSpec::number("max_hold", "最长持仓 日", 120.0).with_range(20.0, 250.0, 5.0),
        ParamSpec::number("risk_pct", "单笔风险预算 (权益 %)", 1.0)
            .with_range(0.2, 5.0, 0.1),
        ParamSpec::number("min_pq", "回踩质量分下限 (0=关)", 0.0).with_range(0.0, 90.0, 5.0),
        ParamSpec::number("pq_sizing", "质量分调仓强度 (0=等权)", 0.0).with_range(0.0, 1.0, 0.1),
        ParamSpec::number("pq_exit", "质量分离场强度 (0=关)", 0.0).with_range(0.0, 1.0, 0.25),
    ]
}

pub(super) struct B3Core {
    cfg: B3Config,
    /// 持仓跟踪状态（引擎按标的各建一个实例，所以可以直接持有）
    tracked: bool,
    entry_price: f64,
    entry_bar: usize,
    highest: f64,
    stop0: f64,
    risk: f64,
    div_done: bool,
    /// 入场时的回踩质量分，离场松紧按它缩放（取不到时等于锚点 = 不缩放）
    entry_pq: f64,
}

impl B3Core {
    pub(super) fn new(params: &Params) -> Self {
        Self {
            cfg: B3Config::from_params(params),
            tracked: false,
            entry_price: 0.0,
            entry_bar: 0,
            highest: 0.0,
            stop0: 0.0,
            risk: 0.0,
            div_done: false,
            entry_pq: PQ_EXIT_ANCHOR,
        }
    }

    pub(super) fn on_day(&mut self, ctx: &DayContext<'_>, gate: Option<&dyn EntryGate>) -> Signal {
        let bars = ctx.bars;
        let n = bars.len();
        if n < 80 {
            return Signal::hold();
        }

        if ctx.position.shares <= 0.0 {
            self.tracked = false;
            self.div_done = false;
            self.highest = 0.0;
        }

        let base = n.saturating_sub(CL_WINDOW);
        let win = &bars[base..];
        let j = win.len() - 1;

        let closes: Vec<f64> = win.iter().map(|b| b.close).collect();
        let highs: Vec<f64> = win.iter().map(|b| b.high).collect();
        let lows: Vec<f64> = win.iter().map(|b| b.low).collect();

        let ef = indicators::ema(&closes, MA_FAST);
        let em = indicators::ema(&closes, MA_MID);
        let es = indicators::ema(&closes, MA_SLOW);
        let hist = indicators::macd_hist(&closes, 12, 26, 9);
        let atr = indicators::atr(&highs, &lows, &closes, ATR_PERIOD);

        let close = ctx.close();
        if !(close > 0.0) {
            return Signal::hold();
        }

        let slope_ok = j >= SLOPE_LEN && em[j] > em[j - SLOPE_LEN];
        let strong = ef[j] > em[j] && em[j] > es[j] && slope_ok;

        let st = chanlun::compute(win);

        // 中枢上移（最近两个已离开的中枢 ZG 抬高）
        let mut prev_zg: Option<f64> = None;
        let mut last_zg: Option<f64> = None;
        for h in st.hubs.iter().filter(|h| h.end_index < j) {
            prev_zg = last_zg;
            last_zg = Some(h.zg);
        }
        let hub_up = matches!((prev_zg, last_zg), (Some(p), Some(l)) if l > p);

        let trend_score = ((ef[j] / em[j] - 1.0) * 250.0
            + (em[j] / es[j] - 1.0) * 250.0
            + if slope_ok { 0.2 } else { 0.0 }
            + if hub_up { 0.15 } else { 0.0 })
        .clamp(0.0, 1.0);

        // ---- 持仓分支 ----
        if ctx.position.shares > 0.0 {
            if !self.tracked {
                // 引擎里没有成交记录，只能从持仓均价反推（换仓/重启后自愈）
                self.tracked = true;
                self.entry_price = if ctx.position.avg_cost > 0.0 {
                    ctx.position.avg_cost
                } else {
                    close
                };
                self.entry_bar = n - 1;
                self.stop0 = self.entry_price * (1.0 - self.cfg.max_risk / 100.0);
                self.risk = (self.entry_price - self.stop0).max(self.entry_price * 0.01);
                self.highest = ctx.today().high;
                // 反推不到入场 PQ，退回锚点：离场松紧不缩放，与改动前一致
                self.entry_pq = PQ_EXIT_ANCHOR;
            }
            self.highest = self.highest.max(ctx.today().high);

            let r_now = (close - self.entry_price) / self.risk.max(f64::EPSILON);
            let atr_now = if atr[j].is_finite() && atr[j] > 0.0 {
                atr[j]
            } else {
                self.entry_price * 0.02
            };

            // 止损线：结构止损 → +1R 保本 → Chandelier 跟踪 → 回吐上限（不设固定止盈）
            // 跟踪倍数与回吐保留只对高分放宽（低分不动）：收紧低分段实测更差，
            // 因为这套策略的全部正期望来自让赢家跑。
            // pq_exit = 0 时 k = 0，两处都等于原常量，行为与改动前完全一致。
            let pq_k = if self.cfg.pq_exit > 0.0 {
                ((self.entry_pq - PQ_EXIT_ANCHOR) / PQ_EXIT_SPAN).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let trail_mult = self.cfg.trail_atr * (1.0 + self.cfg.pq_exit * 0.5 * pq_k);
            let keep_frac = (GIVEBACK_KEEP + self.cfg.pq_exit * 0.15 * pq_k).clamp(GIVEBACK_KEEP, 0.8);
            let mut stop_line = self.stop0;
            if r_now >= BREAKEVEN_R {
                stop_line = stop_line.max(self.entry_price * 1.005);
                stop_line = stop_line.max(self.highest - trail_mult * atr_now);
                // 只在小/中赢家上生效：大趋势的回吐空间本来就大于这条线
                stop_line = stop_line
                    .max(self.entry_price + (self.highest - self.entry_price) * keep_frac);
            }
            if close <= stop_line {
                let tag = if r_now >= BREAKEVEN_R {
                    "跟踪止盈"
                } else {
                    "结构止损"
                };
                return Signal::sell_percent(
                    100.0,
                    format!(
                        "{tag}：收盘 {close:.2} ≤ 止损线 {stop_line:.2}（成本 {:.2}，{r_now:.1}R）",
                        self.entry_price
                    ),
                )
                .with_score(trend_score);
            }

            // 顶背驰：每笔仓位只响应一次，否则顶分型在确认窗口内天天成立
            if !self.div_done && r_now >= DIV_MIN_R {
                if let Some((top, ratio)) = top_divergence(&st, &hist, j, &self.cfg) {
                    if close < top {
                        self.div_done = true;
                        let keep = strong;
                        let frac = tradable_frac(ctx.position.shares, if keep { 50.0 } else { 100.0 });
                        return Signal::sell_percent(
                            frac,
                            format!(
                                "顶背驰：新高 {top:.2} 力度仅前段的 {:.0}%，浮盈 {r_now:.1}R{}",
                                ratio * 100.0,
                                if frac < 100.0 {
                                    "，趋势仍强减半留仓"
                                } else {
                                    "，清仓"
                                }
                            ),
                        )
                        .with_score(trend_score);
                    }
                }
            }

            let held = n - 1 - self.entry_bar;
            if held >= self.cfg.max_hold && r_now < TIME_STOP_R {
                return Signal::sell_percent(
                    100.0,
                    format!(
                        "时间止损：持仓 {held} 日仍未走出 {TIME_STOP_R:.1}R"
                    ),
                )
                .with_score(trend_score);
            }

            return Signal::hold().with_score(trend_score);
        }

        // ---- 空仓分支 ----
        // 现金连一手都不够时不再发买入信号：撮合层一定会拒单，
        // 决策日志里留一堆「现金不足」只会盖住真正有意义的信号。
        if ctx.account.cash < close * 100.0 {
            return Signal::hold().with_score(trend_score);
        }

        let setup = if strong {
            detect_b3(win, j, &st, &self.cfg, atr[j])
        } else {
            None
        };
        let Some(s) = setup else {
            return Signal::hold().with_score(trend_score);
        };

        // 回踩质量分门控：低于阈值的信号直接放弃。
        if self.cfg.min_pq > 0.0 && s.pq < self.cfg.min_pq {
            return Signal::hold().with_score(trend_score);
        }

        let risk_pct = (close - s.stop0) / close * 100.0;
        if !(risk_pct > 0.0) || risk_pct > self.cfg.max_risk {
            return Signal::hold().with_score(trend_score);
        }

        // 结构上已经是三买，这里再问一次「是不是顺势的突破」。
        // 门控放在状态赋值之前，被拒时不会留下幽灵持仓标记。
        if let Some(gate) = gate {
            if gate
                .block(ctx, win, j, &s, atr[j], &closes)
                .is_some()
            {
                return Signal::hold().with_score(trend_score);
            }
        }

        self.tracked = true;
        self.entry_price = close;
        self.entry_bar = n - 1;
        self.stop0 = s.stop0;
        self.risk = (close - s.stop0).max(close * 0.01);
        self.highest = ctx.today().high;
        self.div_done = false;
        self.entry_pq = s.pq;

        // 海龟式的「风险平价」定仓：单笔亏损预算除以结构止损距离，
        // 得到占权益的仓位比例；`min_position_value` 只是下限，不设单只上限。
        let mut size_pct = (self.cfg.risk_pct * 100.0 / risk_pct).clamp(0.0, MAX_SIZE_PCT);

        // 质量分调仓：阈值处 0.5 倍，阈值 +25 分以上回到 1 倍。pq_sizing=0 时系数恒为 1。
        let pq_ramp = ((s.pq - self.cfg.min_pq) / 25.0).clamp(0.0, 1.0);
        size_pct *= 1.0 - self.cfg.pq_sizing * (0.5 - 0.5 * pq_ramp);

        Signal::buy_equity_percent(
            size_pct,
            format!(
                "{}｜风险 {risk_pct:.1}% 仓位 {size_pct:.0}%（权益）{}",
                s.reason,
                if hub_up { "｜中枢上移" } else { "" }
            ),
        )
        .with_score((s.quality * 0.7 + trend_score * 0.3).clamp(0.0, 1.0))
    }
}
