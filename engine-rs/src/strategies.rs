//! Built-in strategies.
//!
//! Each one is a pure function of the framework-provided `DayContext` (plus its
//! own entry bookkeeping) — no data access, no clock, no I/O.

use crate::chanlun::{self, Fraction, FractionKind, Hub, Structures};
use crate::data::Bar;
use crate::indicators;
use crate::strategy::{DayContext, ParamSpec, Params, Signal, Strategy};

// ---------------------------------------------------------------------------
// 1. MA cross
// ---------------------------------------------------------------------------

pub struct MaCross {
    fast: usize,
    slow: usize,
    size_percent: f64,
}

impl MaCross {
    pub fn new(params: &Params) -> Self {
        Self {
            fast: params.f64("fast", 5.0).max(1.0) as usize,
            slow: params.f64("slow", 20.0).max(2.0) as usize,
            size_percent: params.f64("size", 95.0).clamp(1.0, 100.0),
        }
    }
}

impl Strategy for MaCross {
    fn id(&self) -> &'static str {
        "ma-cross"
    }

    fn name(&self) -> &'static str {
        "双均线交叉"
    }

    fn description(&self) -> &'static str {
        "MA5 上穿 MA20 买入, 下穿卖出; 与 TypeScript 引擎的 ma-cross 同口径"
    }

    fn params(&self) -> Vec<ParamSpec> {
        vec![
            ParamSpec::number("fast", "快线", 5.0).with_range(1.0, 60.0, 1.0),
            ParamSpec::number("slow", "慢线", 20.0).with_range(2.0, 250.0, 1.0),
            ParamSpec::number("size", "买入仓位 %", 95.0).with_range(1.0, 100.0, 1.0),
        ]
    }

    fn on_day(&mut self, ctx: &DayContext<'_>) -> Signal {
        let Some(fast) = ctx.sma(self.fast) else {
            return Signal::hold();
        };
        let Some(slow) = ctx.sma(self.slow) else {
            return Signal::hold();
        };
        if ctx.position.shares <= 0.0 {
            if fast > slow {
                return Signal::buy_percent(
                    self.size_percent,
                    format!("MA{} {:.2} > MA{} {:.2}", self.fast, fast, self.slow, slow),
                )
                .with_score((fast / slow - 1.0) * 100.0);
            }
            return Signal::hold();
        }

        if fast < slow {
            return Signal::sell_percent(
                100.0,
                format!("MA{} {:.2} < MA{} {:.2}", self.fast, fast, self.slow, slow),
            );
        }
        Signal::hold()
    }
}

// ---------------------------------------------------------------------------
// 2. Donchian breakout with trailing stop
// ---------------------------------------------------------------------------

pub struct DonchianBreakout {
    entry_window: usize,
    exit_window: usize,
    size_percent: f64,
    stop_percent: f64,
    peak: f64,
}

impl DonchianBreakout {
    pub fn new(params: &Params) -> Self {
        Self {
            entry_window: params.f64("entry", 20.0).max(2.0) as usize,
            exit_window: params.f64("exit", 10.0).max(2.0) as usize,
            size_percent: params.f64("size", 90.0).clamp(1.0, 100.0),
            stop_percent: params.f64("stop", 8.0).clamp(0.0, 50.0),
            peak: 0.0,
        }
    }
}

impl Strategy for DonchianBreakout {
    fn id(&self) -> &'static str {
        "donchian-breakout"
    }

    fn name(&self) -> &'static str {
        "唐奇安通道突破"
    }

    fn description(&self) -> &'static str {
        "创 N 日新高买入, 跌破 M 日新低或回撤止损卖出"
    }

    fn params(&self) -> Vec<ParamSpec> {
        vec![
            ParamSpec::number("entry", "突破周期", 20.0).with_range(3.0, 120.0, 1.0),
            ParamSpec::number("exit", "离场周期", 10.0).with_range(2.0, 60.0, 1.0),
            ParamSpec::number("size", "买入仓位 %", 90.0).with_range(1.0, 100.0, 1.0),
            ParamSpec::number("stop", "移动止损 %", 8.0).with_range(0.0, 50.0, 0.5),
        ]
    }

    fn on_day(&mut self, ctx: &DayContext<'_>) -> Signal {
        let close = ctx.close();

        if ctx.position.shares <= 0.0 {
            self.peak = 0.0;
            let Some(high) = ctx.highest_close(self.entry_window) else {
                return Signal::hold();
            };
            if close > high {
                return Signal::buy_percent(
                    self.size_percent,
                    format!("突破 {} 日新高 {:.2}", self.entry_window, high),
                );
            }
            return Signal::hold();
        }

        self.peak = self.peak.max(close);

        if self.stop_percent > 0.0 && self.peak > 0.0 {
            let drawdown = (close / self.peak - 1.0) * 100.0;
            if drawdown <= -self.stop_percent {
                return Signal::sell_percent(
                    100.0,
                    format!("回撤 {:.1}% 触发止损 (峰值 {:.2})", drawdown, self.peak),
                );
            }
        }

        if let Some(low) = ctx.lowest_close(self.exit_window) {
            if close < low {
                return Signal::sell_percent(
                    100.0,
                    format!("跌破 {} 日新低 {:.2}", self.exit_window, low),
                );
            }
        }
        Signal::hold()
    }
}

// ---------------------------------------------------------------------------
// 3. RSI mean reversion
// ---------------------------------------------------------------------------

pub struct RsiReversion {
    period: usize,
    oversold: f64,
    overbought: f64,
    size_percent: f64,
}

impl RsiReversion {
    pub fn new(params: &Params) -> Self {
        Self {
            period: params.f64("period", 14.0).max(2.0) as usize,
            oversold: params.f64("oversold", 30.0).clamp(1.0, 49.0),
            overbought: params.f64("overbought", 70.0).clamp(51.0, 99.0),
            size_percent: params.f64("size", 90.0).clamp(1.0, 100.0),
        }
    }
}

impl Strategy for RsiReversion {
    fn id(&self) -> &'static str {
        "rsi-reversion"
    }

    fn name(&self) -> &'static str {
        "RSI 均值回归"
    }

    fn description(&self) -> &'static str {
        "RSI 跌破超卖线买入, 升破超买线卖出"
    }

    fn params(&self) -> Vec<ParamSpec> {
        vec![
            ParamSpec::number("period", "RSI 周期", 14.0).with_range(2.0, 60.0, 1.0),
            ParamSpec::number("oversold", "超卖线", 30.0).with_range(1.0, 49.0, 1.0),
            ParamSpec::number("overbought", "超买线", 70.0).with_range(51.0, 99.0, 1.0),
            ParamSpec::number("size", "买入仓位 %", 90.0).with_range(1.0, 100.0, 1.0),
        ]
    }

    fn on_day(&mut self, ctx: &DayContext<'_>) -> Signal {
        let Some(rsi) = ctx.rsi(self.period) else {
            return Signal::hold();
        };

        if ctx.position.shares <= 0.0 {
            if rsi <= self.oversold {
                return Signal::buy_percent(self.size_percent, format!("RSI {rsi:.1} 超卖"));
            }
            return Signal::hold();
        }

        if rsi >= self.overbought {
            return Signal::sell_percent(100.0, format!("RSI {rsi:.1} 超买"));
        }
        Signal::hold()
    }
}

// ---------------------------------------------------------------------------
// 4. Momentum rotation score (rank by N-day return, hold the strongest)
// ---------------------------------------------------------------------------

pub struct Momentum {
    lookback: usize,
    min_return: f64,
    size_percent: f64,
}

impl Momentum {
    pub fn new(params: &Params) -> Self {
        Self {
            lookback: params.f64("lookback", 20.0).max(2.0) as usize,
            min_return: params.f64("min_return", 0.0),
            size_percent: params.f64("size", 90.0).clamp(1.0, 100.0),
        }
    }
}

impl Strategy for Momentum {
    fn id(&self) -> &'static str {
        "momentum"
    }

    fn name(&self) -> &'static str {
        "动量轮动"
    }

    fn description(&self) -> &'static str {
        "按 N 日涨幅打分, 强势买入, 转负离场 (score 可做横截面比较)"
    }

    fn params(&self) -> Vec<ParamSpec> {
        vec![
            ParamSpec::number("lookback", "动量周期", 20.0).with_range(2.0, 250.0, 1.0),
            ParamSpec::number("min_return", "最低涨幅 %", 0.0).with_range(-50.0, 50.0, 0.5),
            ParamSpec::number("size", "买入仓位 %", 90.0).with_range(1.0, 100.0, 1.0),
        ]
    }

    fn on_day(&mut self, ctx: &DayContext<'_>) -> Signal {
        let Some(ret) = ctx.pct_change(self.lookback) else {
            return Signal::hold();
        };

        if ctx.position.shares <= 0.0 {
            if ret > self.min_return {
                return Signal::buy_percent(
                    self.size_percent,
                    format!("{} 日涨幅 {:.2}%", self.lookback, ret),
                )
                .with_score(ret);
            }
            return Signal::hold();
        }

        if ret < 0.0 {
            return Signal::sell_percent(
                100.0,
                format!("{} 日动量转负 ({:.2}%)", self.lookback, ret),
            )
            .with_score(ret);
        }
        Signal::hold().with_score(ret)
    }
}

// ---------------------------------------------------------------------------
// 5. ChanLun 顺势三买（突破回踩）
// ---------------------------------------------------------------------------

/// 缠论结构只在尾部这么长的窗口上重算：中枢有效期是 120 日，320 根足够覆盖，
/// 同时把「逐日全量重算」的代价压成常数（否则整池回测会退化成 O(n²)）。
const CL_WINDOW: usize = 320;

struct B3Config {
    ma_fast: usize,
    ma_mid: usize,
    ma_slow: usize,
    slope_len: usize,
    hub_lookback: usize,
    max_hub_amp: f64,
    breakout_min: f64,
    hub_reentry: f64,
    pullback_min: f64,
    pullback_max: f64,
    vol_shrink: f64,
    confirm_window: usize,
    max_chase: f64,
    stop_buffer: f64,
    max_risk: f64,
    /// 单票仓位（占引擎分配的槽位 %）。池子引擎按等权槽位分配资金，
    /// 风险平价在这里体现为「止损越宽 → 被 max_risk 过滤掉」，而不是缩小仓位，
    /// 否则 1% 风险预算会让 90% 的资金闲置。
    size_pct: f64,
    breakeven_r: f64,
    tp1_r: f64,
    tp1_frac: f64,
    tp2_r: f64,
    tp2_frac: f64,
    trail_atr: f64,
    atr_period: usize,
    max_hold: usize,
    enable_b2: bool,
    div_ratio: f64,
}

impl B3Config {
    fn from_params(p: &Params) -> Self {
        let usize_of = |k: &str, d: f64| p.f64(k, d).max(1.0) as usize;
        Self {
            ma_fast: usize_of("ma_fast", 10.0),
            ma_mid: usize_of("ma_mid", 20.0),
            ma_slow: usize_of("ma_slow", 60.0),
            slope_len: 10,
            hub_lookback: 120,
            max_hub_amp: 30.0,
            breakout_min: p.f64("breakout_min", 3.0),
            hub_reentry: 0.5,
            pullback_min: p.f64("pullback_min", 0.2),
            pullback_max: p.f64("pullback_max", 0.85),
            vol_shrink: p.f64("vol_shrink", 1.0),
            confirm_window: usize_of("confirm_window", 5.0),
            max_chase: p.f64("max_chase", 6.0),
            stop_buffer: p.f64("stop_buffer", 1.5),
            max_risk: p.f64("max_risk", 7.0),
            size_pct: p.f64("size_pct", 100.0).clamp(1.0, 100.0),
            breakeven_r: 1.0,
            tp1_r: p.f64("tp1_r", 2.0),
            tp1_frac: p.f64("tp1_frac", 33.0),
            tp2_r: p.f64("tp2_r", 3.5),
            tp2_frac: p.f64("tp2_frac", 50.0),
            trail_atr: p.f64("trail_atr", 2.5),
            atr_period: 14,
            max_hold: usize_of("max_hold", 60.0),
            enable_b2: p.f64("enable_b2", 1.0) >= 0.5,
            div_ratio: 0.85,
        }
    }
}

/// 一个待执行的买点。
struct Setup {
    label: &'static str,
    stop0: f64,
    reason: String,
    quality: f64,
}

fn avg_vol(bars: &[Bar], from: usize, to: usize) -> f64 {
    if to < from {
        return 0.0;
    }
    let sum: f64 = bars[from..=to].iter().map(|b| b.volume).sum();
    sum / (to - from + 1) as f64
}

/// 分批止盈的比例修正：A 股一手 100 股，按比例拆出来的量不足一手时，
/// 撮合层会算出 0 手直接拒单（决策日志里表现为「无可卖数量」）。
/// 仓位小到没法拆就干脆一次清掉，比分两次都被拒要诚实。
fn tradable_frac(shares: f64, frac: f64) -> f64 {
    if shares * frac / 100.0 < 100.0 {
        100.0
    } else {
        frac
    }
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

/// 三买 = 突破中枢上沿后回踩不回中枢。
fn detect_b3(bars: &[Bar], j: usize, st: &Structures, cfg: &B3Config) -> Option<Setup> {
    let hub: &Hub = st
        .hubs
        .iter()
        .filter(|h| h.zg > h.zd && h.end_index + 1 < j)
        .next_back()?;

    if j - hub.end_index > cfg.hub_lookback {
        return None;
    }
    let amp = (hub.gg - hub.dd) / hub.dd * 100.0;
    if !(amp > 0.0) || amp > cfg.max_hub_amp {
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
    if pull_low < hub.zg * (1.0 - cfg.hub_reentry / 100.0) {
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

    let stop0 = (pull_low * (1.0 - cfg.stop_buffer / 100.0))
        .max(hub.zg * (1.0 - cfg.hub_reentry / 100.0));

    Some(Setup {
        label: "三买·突破回踩",
        stop0,
        reason: format!(
            "三买·突破回踩：中枢 ZG {:.2} 突破至 {:.2} (+{:.1}%)，回踩 {:.2} 未回中枢（深度 {:.0}%，量比 {:.2}）",
            hub.zg,
            brk_high,
            brk_pct,
            pull_low,
            depth * 100.0,
            vol_ratio
        ),
        quality: (0.45 + (brk_pct / 10.0).clamp(0.0, 0.25) + (1.0 - vol_ratio).clamp(0.0, 0.2) * 0.3)
            .clamp(0.0, 1.0),
    })
}

/// 二买 = 一买（底背驰）之后回调不创新低。
fn detect_b2(
    bars: &[Bar],
    j: usize,
    st: &Structures,
    hist: &[f64],
    cfg: &B3Config,
) -> Option<Setup> {
    let bottoms: Vec<&Fraction> = st
        .fractions
        .iter()
        .filter(|f| f.kind == FractionKind::Bottom && f.original_index <= j)
        .collect();
    if bottoms.len() < 3 {
        return None;
    }
    let b3 = bottoms[bottoms.len() - 1];
    let b2 = bottoms[bottoms.len() - 2];
    let b1 = bottoms[bottoms.len() - 3];

    if b3.price <= b2.price || b2.price >= b1.price {
        return None;
    }
    let t2 = last_top_before(&st.fractions, b2.original_index)?;
    let t1 = last_top_before(&st.fractions, b1.original_index)?;
    let a2 = indicators::macd_area(hist, t2.original_index, b2.original_index, false);
    let a1 = indicators::macd_area(hist, t1.original_index, b1.original_index, false);
    if a1 <= 0.0 || a2 >= a1 * cfg.div_ratio {
        return None;
    }

    let since = j - b3.original_index;
    if since < 1 || since > cfg.confirm_window {
        return None;
    }
    let c = bars[j].close;
    if c <= bars[j - 1].high || c <= b3.price * 1.005 {
        return None;
    }

    Some(Setup {
        label: "二买·背驰不创新低",
        stop0: b3.price * (1.0 - cfg.stop_buffer / 100.0),
        reason: format!(
            "二买·背驰后不创新低：一买低点 {:.2}，本次回调 {:.2} 未破前低",
            b2.price, b3.price
        ),
        quality: 0.4,
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
    if a1 <= 0.0 || a2 >= a1 * cfg.div_ratio {
        return None;
    }
    Some((t2.price, a2 / a1))
}

pub struct ChanlunB3Pullback {
    cfg: B3Config,
    /// 持仓跟踪状态（引擎按标的各建一个实例，所以可以直接持有）
    tracked: bool,
    entry_price: f64,
    entry_bar: usize,
    highest: f64,
    stop0: f64,
    risk: f64,
    tp_done: u8,
    div_done: bool,
    last_shares: f64,
    pending_tp: bool,
}

impl ChanlunB3Pullback {
    pub fn new(params: &Params) -> Self {
        Self {
            cfg: B3Config::from_params(params),
            tracked: false,
            entry_price: 0.0,
            entry_bar: 0,
            highest: 0.0,
            stop0: 0.0,
            risk: 0.0,
            tp_done: 0,
            div_done: false,
            last_shares: 0.0,
            pending_tp: false,
        }
    }
}

impl Strategy for ChanlunB3Pullback {
    fn id(&self) -> &'static str {
        "cl-trend-b3-pullback"
    }

    fn name(&self) -> &'static str {
        "缠论顺势三买·突破回踩"
    }

    fn description(&self) -> &'static str {
        "只做三买（突破中枢后回抽不回中枢）/二买，要求 EMA 多头排列的顺势环境；\
         突破幅度+回踩深度+回踩缩量+反包确认四重约束；卖点为结构止损/顶背驰/保本移动/ATR 跟踪/分批止盈"
    }

    fn params(&self) -> Vec<ParamSpec> {
        vec![
            ParamSpec::number("ma_fast", "快线 EMA", 10.0).with_range(3.0, 30.0, 1.0),
            ParamSpec::number("ma_mid", "中线 EMA", 20.0).with_range(10.0, 60.0, 1.0),
            ParamSpec::number("ma_slow", "慢线 EMA", 60.0).with_range(30.0, 120.0, 5.0),
            ParamSpec::number("breakout_min", "最小突破 %", 3.0).with_range(0.5, 15.0, 0.5),
            ParamSpec::number("pullback_min", "回踩深度下限", 0.2).with_range(0.05, 0.6, 0.05),
            ParamSpec::number("pullback_max", "回踩深度上限", 0.85).with_range(0.4, 1.0, 0.05),
            ParamSpec::number("vol_shrink", "回踩量/突破量上限", 1.0).with_range(0.3, 2.0, 0.1),
            ParamSpec::number("confirm_window", "回踩确认窗口 日", 5.0).with_range(1.0, 15.0, 1.0),
            ParamSpec::number("max_chase", "追高上限 %", 6.0).with_range(1.0, 20.0, 1.0),
            ParamSpec::number("stop_buffer", "结构止损缓冲 %", 1.5).with_range(0.0, 5.0, 0.5),
            ParamSpec::number("max_risk", "单笔最大风险 %", 7.0).with_range(2.0, 20.0, 1.0),
            ParamSpec::number("size_pct", "单票仓位 占槽位%", 100.0).with_range(10.0, 100.0, 5.0),
            ParamSpec::number("tp1_r", "第一批止盈 R", 2.0).with_range(1.0, 6.0, 0.5),
            ParamSpec::number("tp1_frac", "第一批比例 %", 33.0).with_range(10.0, 50.0, 1.0),
            ParamSpec::number("tp2_r", "第二批止盈 R", 3.5).with_range(2.0, 10.0, 0.5),
            ParamSpec::number("tp2_frac", "第二批比例 %", 50.0).with_range(10.0, 60.0, 5.0),
            ParamSpec::number("trail_atr", "ATR 跟踪倍数", 2.5).with_range(1.0, 6.0, 0.5),
            ParamSpec::number("max_hold", "最长持仓 日", 60.0).with_range(10.0, 200.0, 5.0),
            ParamSpec::number("enable_b2", "启用二买 1=开", 1.0).with_range(0.0, 1.0, 1.0),
        ]
    }

    fn on_day(&mut self, ctx: &DayContext<'_>) -> Signal {
        let bars = ctx.bars;
        let n = bars.len();
        if n < 80 {
            return Signal::hold();
        }

        // 昨日发出的分批止盈今天确认成交后才计数（被跌停拦下就不算）
        if self.pending_tp && ctx.position.shares < self.last_shares {
            self.tp_done = self.tp_done.saturating_add(1);
        }
        self.pending_tp = false;
        self.last_shares = ctx.position.shares;

        if ctx.position.shares <= 0.0 {
            self.tracked = false;
            self.tp_done = 0;
            self.div_done = false;
            self.highest = 0.0;
        }

        let base = n.saturating_sub(CL_WINDOW);
        let win = &bars[base..];
        let j = win.len() - 1;

        let closes: Vec<f64> = win.iter().map(|b| b.close).collect();
        let highs: Vec<f64> = win.iter().map(|b| b.high).collect();
        let lows: Vec<f64> = win.iter().map(|b| b.low).collect();

        let ef = indicators::ema(&closes, self.cfg.ma_fast);
        let em = indicators::ema(&closes, self.cfg.ma_mid);
        let es = indicators::ema(&closes, self.cfg.ma_slow);
        let hist = indicators::macd_hist(&closes, 12, 26, 9);
        let atr = indicators::atr(&highs, &lows, &closes, self.cfg.atr_period);

        let close = ctx.close();
        if !(close > 0.0) {
            return Signal::hold();
        }

        let slope_ok = j >= self.cfg.slope_len && em[j] > em[j - self.cfg.slope_len];
        let align_ok = ef[j] > em[j] && em[j] > es[j];
        let strong = align_ok && slope_ok;
        let mild = close > em[j]
            && (j < self.cfg.slope_len || em[j] >= em[j - self.cfg.slope_len] * 0.999);

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
            }
            self.highest = self.highest.max(ctx.today().high);

            let r_now = (close - self.entry_price) / self.risk.max(f64::EPSILON);
            let atr_now = if atr[j].is_finite() && atr[j] > 0.0 {
                atr[j]
            } else {
                self.entry_price * 0.02
            };

            let mut stop_line = self.stop0;
            if r_now >= self.cfg.breakeven_r {
                stop_line = stop_line.max(self.entry_price * 1.005);
                stop_line = stop_line.max(self.highest - self.cfg.trail_atr * atr_now);
            }
            if close <= stop_line {
                let tag = if r_now >= self.cfg.breakeven_r {
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
            if !self.div_done && r_now >= 0.5 {
                if let Some((top, ratio)) = top_divergence(&st, &hist, j, &self.cfg) {
                    if close < top {
                        self.div_done = true;
                        let keep = strong && r_now < self.cfg.tp2_r && self.tp_done == 0;
                        let frac = tradable_frac(
                            ctx.position.shares,
                            if keep { 50.0 } else { 100.0 },
                        );
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

            if r_now >= self.cfg.tp2_r && self.tp_done == 1 {
                self.pending_tp = true;
                return Signal::sell_percent(
                    tradable_frac(ctx.position.shares, self.cfg.tp2_frac),
                    format!("分批止盈2：{r_now:.1}R ≥ {:.1}R", self.cfg.tp2_r),
                )
                .with_score(trend_score);
            }
            if r_now >= self.cfg.tp1_r && self.tp_done == 0 {
                self.pending_tp = true;
                return Signal::sell_percent(
                    tradable_frac(ctx.position.shares, self.cfg.tp1_frac),
                    format!("分批止盈1：{r_now:.1}R ≥ {:.1}R", self.cfg.tp1_r),
                )
                .with_score(trend_score);
            }

            let held = n - 1 - self.entry_bar;
            if held >= self.cfg.max_hold && r_now < 1.0 {
                return Signal::sell_percent(
                    100.0,
                    format!("时间止损：持仓 {held} 日仍未走出 1R"),
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

        let mut setup = if strong {
            detect_b3(win, j, &st, &self.cfg)
        } else {
            None
        };
        if setup.is_none() && self.cfg.enable_b2 && mild {
            setup = detect_b2(win, j, &st, &hist, &self.cfg);
        }
        let Some(s) = setup else {
            return Signal::hold().with_score(trend_score);
        };

        let risk_pct = (close - s.stop0) / close * 100.0;
        if !(risk_pct > 0.0) || risk_pct > self.cfg.max_risk {
            return Signal::hold().with_score(trend_score);
        }
        // 仓位 = 槽位的 size_pct%。止损距离只用来过滤（太远就放弃），不用来缩小仓位——
        // 池子引擎是等权槽位模型，缩小仓位只会让资金闲置。
        let pct = self.cfg.size_pct;

        self.tracked = true;
        self.entry_price = close;
        self.entry_bar = n - 1;
        self.stop0 = s.stop0;
        self.risk = (close - s.stop0).max(close * 0.01);
        self.highest = ctx.today().high;
        self.tp_done = 0;
        self.div_done = false;

        Signal::buy_percent(
            pct,
            format!(
                "{}｜风险 {risk_pct:.1}% 仓位 {pct:.0}%{}",
                s.reason,
                if hub_up { "｜中枢上移" } else { "" }
            ),
        )
        .with_score((s.quality * 0.7 + trend_score * 0.3).clamp(0.0, 1.0))
    }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

pub struct StrategyMeta {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub params: fn() -> Vec<ParamSpec>,
    pub build: fn(&Params) -> Box<dyn Strategy>,
}

pub const STRATEGIES: &[StrategyMeta] = &[
    StrategyMeta {
        id: "ma-cross",
        name: "双均线交叉",
        description: "MA5 上穿 MA20 买入, 下穿卖出",
        params: || MaCross::new(&Params::new()).params(),
        build: |p| Box::new(MaCross::new(p)),
    },
    StrategyMeta {
        id: "donchian-breakout",
        name: "唐奇安通道突破",
        description: "创 N 日新高买入, 跌破 M 日新低或回撤止损卖出",
        params: || DonchianBreakout::new(&Params::new()).params(),
        build: |p| Box::new(DonchianBreakout::new(p)),
    },
    StrategyMeta {
        id: "rsi-reversion",
        name: "RSI 均值回归",
        description: "RSI 跌破超卖线买入, 升破超买线卖出",
        params: || RsiReversion::new(&Params::new()).params(),
        build: |p| Box::new(RsiReversion::new(p)),
    },
    StrategyMeta {
        id: "momentum",
        name: "动量轮动",
        description: "按 N 日涨幅打分, 强势买入, 转负离场",
        params: || Momentum::new(&Params::new()).params(),
        build: |p| Box::new(Momentum::new(p)),
    },
    StrategyMeta {
        id: "cl-trend-b3-pullback",
        name: "缠论顺势三买·突破回踩",
        description: "只做缠论三买(突破中枢后回抽不回中枢)/二买, EMA 多头排列过滤趋势, 结构止损+顶背驰+ATR跟踪+分批止盈",
        params: || ChanlunB3Pullback::new(&Params::new()).params(),
        build: |p| Box::new(ChanlunB3Pullback::new(p)),
    },
];

pub fn build_strategy(id: &str, params: &Params) -> Option<Box<dyn Strategy>> {
    STRATEGIES
        .iter()
        .find(|m| m.id == id)
        .map(|m| (m.build)(params))
}
