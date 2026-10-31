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
    /// 结构止损缓冲用 ATR 的倍数（0 = 用固定的 stop_buffer %）。
    /// 固定 1.5% 在 ATR 3% 的票上只有半个 ATR，正常回踩就会打掉止损；
    /// 换成波动率单位后，止损距离与标的自身的噪声匹配。
    stop_atr: f64,
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
    /// 0 = 原版「中枢后第一根向上笔 + 突破以来最低点」
    /// 1 = 「最近一段向上笔 + 最近一根向下笔的低点」（趋势中的连续回踩）
    b3_mode: u8,
    /// v2 模式下，向上笔起点距今天数上限（太老的突破腿不算）
    leg_lookback: usize,
    /// 波动率带（ATR/收盘 %），0 表示不启用下限/上限
    atr_min_pct: f64,
    atr_max_pct: f64,
    /// 收盘距 EMA60 的最大正偏离（%），0 表示不启用
    ema60_max_dist: f64,
    /// 顶背驰只在浮盈达到该 R 倍数后才允许触发
    div_min_r: f64,
    /// 确认阳线的最大单日涨幅（%），0 = 不限制。
    /// 「收盘 > 前一根最高价」这条反包确认在弱势股上只能靠一根大阳线满足，
    /// 而大阳线恰恰是尾盘拉抬/一日游的典型形态：实测入场日涨幅 2~4% 的信号
    /// 在沪深300 与中证500 上的 40 日收益都显著低于 0~2% 的信号。
    max_entry_bar: f64,
    /// 二买是否要求最近中枢上移
    b2_require_hub_up: bool,
    /// 0 = 所有买点共用一套离场参数（旧行为）
    /// 1 = 按买点类型分治：二买做均值回归（紧止盈/短持有），三买做趋势（宽跟踪/不止盈）
    exit_mode: u8,
    exit_shared: ExitPolicy,
    exit_b2: ExitPolicy,
    exit_b3: ExitPolicy,
    /// 0 = 不做市场状态过滤
    /// 1 = 只过滤二买（均值回归在弱市里最容易被套）
    /// 2 = 只过滤三买
    /// 3 = 两类买点都过滤
    regime_mode: u8,
    regime_breadth_min: f64,
    regime_index_ma60_min: f64,
}

/// 一套离场规则。二买与三买的赔率结构完全不同，必须分开调：
/// 二买是背驰后的反弹，期望值靠「快速兑现」，拿久了利润回吐；
/// 三买是趋势起点，期望值靠「让利润奔跑」，固定止盈会把最肥的尾部切掉。
#[derive(Clone, Copy)]
struct ExitPolicy {
    breakeven_r: f64,
    tp1_r: f64,
    tp1_frac: f64,
    tp2_r: f64,
    tp2_frac: f64,
    trail_atr: f64,
    /// 跟踪止盈的最大回吐幅度（占最高价 %），0 = 不限制。
    /// ATR 倍数在高低波动标的上代表的回吐完全不同：4 ATR 在 3% ATR 的股票是
    /// 12%，在 5% ATR 的股票是 20%。用绝对百分比封顶可以避免小盘高波动池
    /// 把利润全部还回去。
    trail_max_pct: f64,
    max_hold: usize,
    div_min_r: f64,
    /// 超过 max_hold 时，浮盈低于该 R 倍数就离场（防止僵尸仓位）
    time_stop_r: f64,
}

impl ExitPolicy {
    fn from_params(p: &Params, prefix: &str, d: ExitDefaults) -> Self {
        let key = |k: &str| {
            if prefix.is_empty() {
                k.to_string()
            } else {
                format!("{prefix}_{k}")
            }
        };
        let usize_of = |k: &str, dv: f64| p.f64(&key(k), dv).max(1.0) as usize;
        Self {
            breakeven_r: p.f64(&key("breakeven_r"), d.breakeven_r),
            tp1_r: p.f64(&key("tp1_r"), d.tp1_r),
            tp1_frac: p.f64(&key("tp1_frac"), d.tp1_frac).clamp(1.0, 100.0),
            tp2_r: p.f64(&key("tp2_r"), d.tp2_r),
            tp2_frac: p.f64(&key("tp2_frac"), d.tp2_frac).clamp(1.0, 100.0),
            trail_atr: p.f64(&key("trail_atr"), d.trail_atr).max(0.0),
            trail_max_pct: p.f64(&key("trail_max_pct"), d.trail_max_pct).max(0.0),
            max_hold: usize_of("max_hold", d.max_hold as f64),
            div_min_r: p.f64(&key("div_min_r"), d.div_min_r).max(0.0),
            time_stop_r: p.f64(&key("time_stop_r"), d.time_stop_r),
        }
    }
}

struct ExitDefaults {
    breakeven_r: f64,
    tp1_r: f64,
    tp1_frac: f64,
    tp2_r: f64,
    tp2_frac: f64,
    trail_atr: f64,
    trail_max_pct: f64,
    max_hold: usize,
    div_min_r: f64,
    time_stop_r: f64,
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
            pullback_min: p.f64("pullback_min", 0.3),
            pullback_max: p.f64("pullback_max", 0.7),
            vol_shrink: p.f64("vol_shrink", 1.0),
            confirm_window: usize_of("confirm_window", 5.0),
            max_chase: p.f64("max_chase", 6.0),
            stop_buffer: p.f64("stop_buffer", 1.5),
            max_risk: p.f64("max_risk", 12.0),
            stop_atr: p.f64("stop_atr", 2.0).max(0.0),
            size_pct: p.f64("size_pct", 100.0).clamp(1.0, 100.0),
            breakeven_r: 1.0,
            tp1_r: p.f64("tp1_r", 2.0),
            tp1_frac: p.f64("tp1_frac", 33.0),
            tp2_r: p.f64("tp2_r", 3.5),
            tp2_frac: p.f64("tp2_frac", 50.0),
            trail_atr: p.f64("trail_atr", 2.5),
            atr_period: 14,
            max_hold: usize_of("max_hold", 60.0),
            enable_b2: p.f64("enable_b2", 0.0) >= 0.5,
            div_ratio: 0.85,
            b3_mode: p.f64("b3_mode", 0.0).round().clamp(0.0, 1.0) as u8,
            leg_lookback: usize_of("leg_lookback", 60.0),
            atr_min_pct: p.f64("atr_min_pct", 0.0).max(0.0),
            atr_max_pct: {
                let v = p.f64("atr_max_pct", 100.0);
                if v <= 0.0 { 100.0 } else { v }
            },
            ema60_max_dist: {
                let v = p.f64("ema60_max_dist", 0.0);
                if v <= 0.0 { 1e9 } else { v }
            },
            div_min_r: p.f64("div_min_r", 0.5).max(0.0),
            max_entry_bar: p.f64("max_entry_bar", 4.0).max(0.0),
            b2_require_hub_up: p.f64("b2_require_hub_up", 1.0) >= 0.5,
            exit_mode: p.f64("exit_mode", 1.0).round().clamp(0.0, 1.0) as u8,
            exit_shared: ExitPolicy::from_params(
                p,
                "",
                ExitDefaults {
                    breakeven_r: 1.0,
                    tp1_r: p.f64("tp1_r", 2.0),
                    tp1_frac: p.f64("tp1_frac", 33.0),
                    tp2_r: p.f64("tp2_r", 3.5),
                    tp2_frac: p.f64("tp2_frac", 50.0),
                    trail_atr: 2.5,
                    trail_max_pct: 0.0,
                    max_hold: 60,
                    div_min_r: p.f64("div_min_r", 0.5).max(0.0),
                    time_stop_r: 1.0,
                },
            ),
            exit_b2: ExitPolicy::from_params(
                p,
                "b2",
                ExitDefaults {
                    breakeven_r: 0.7,
                    tp1_r: 1.5,
                    tp1_frac: 50.0,
                    tp2_r: 2.5,
                    tp2_frac: 100.0,
                    trail_atr: 2.0,
                    trail_max_pct: 0.0,
                    max_hold: 20,
                    div_min_r: 0.5,
                    time_stop_r: 0.5,
                },
            ),
            exit_b3: ExitPolicy::from_params(
                p,
                "b3",
                ExitDefaults {
                    breakeven_r: 1.0,
                    tp1_r: 99.0,
                    tp1_frac: 100.0,
                    tp2_r: 99.0,
                    tp2_frac: 100.0,
                    trail_atr: 5.0,
                    trail_max_pct: 0.0,
                    max_hold: 120,
                    div_min_r: 2.0,
                    time_stop_r: 1.0,
                },
            ),
            regime_mode: p.f64("regime_mode", 0.0).round().clamp(0.0, 3.0) as u8,
            regime_breadth_min: p.f64("regime_breadth_min", 0.40).clamp(0.0, 1.0),
            regime_index_ma60_min: p.f64("regime_index_ma60_min", -2.0),
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

/// 确认阳线的形态门槛。
///
/// 「收盘 > 前一根最高价」这条反包确认，在弱势股上往往只能靠一根大阳线满足，
/// 而大阳线本身是「一日游 / 尾盘拉抬」的典型形态。信号级实测（沪深300 92 个
/// 三买信号、中证500 129 个）显示：入场日涨幅 2~4% 的一组 40 日收益比 0~2%
/// 的一组低 3~4 个百分点，且两个股票池方向一致。所以把「确认日涨幅」和
/// 「确认日振幅」都纳入门槛，而不是只限制「距回踩低点的追高幅度」。
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

/// 结构止损位：回踩低点下方留缓冲，且不低于中枢上沿的回踩容忍线。
/// `stop_atr > 0` 时缓冲按 ATR 计价，否则用固定百分比。
fn structural_stop(pull_low: f64, hub_zg: f64, cfg: &B3Config, atr_now: f64) -> f64 {
    let buffer_pct = if cfg.stop_atr > 0.0 && atr_now.is_finite() && pull_low > 0.0 {
        (cfg.stop_atr * atr_now / pull_low * 100.0).min(15.0)
    } else {
        cfg.stop_buffer
    };
    (pull_low * (1.0 - buffer_pct / 100.0))
        .max(hub_zg * (1.0 - cfg.hub_reentry / 100.0))
}

/// 三买 = 突破中枢上沿后回踩不回中枢。
fn detect_b3(bars: &[Bar], j: usize, st: &Structures, cfg: &B3Config, atr_now: f64) -> Option<Setup> {
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
    if !entry_bar_ok(bars, j, cfg) {
        return None;
    }

    let stop0 = structural_stop(pull_low, hub.zg, cfg, atr_now);

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

/// 三买 v2 = 最近一段向上笔之后的回踩。
///
/// 与 v1 的差别：v1 永远锚定「中枢之后第一根向上笔」和「突破以来最低点」，
/// 一旦第一次回踩没有在 5 日内给出反包，后面更高的回踩就永远抓不到；趋势走了
/// 两个月后，突破以来最低点更是远在下方，`since_low` 直接超窗。v2 改为：
///   突破腿 = 中枢之后、最近一根已完成的向上笔（高点仍须越过 ZG）
///   回踩   = 突破腿之后、最近一根已完成的向下笔的低点
///   深度   = 回踩幅度 / 该向上笔自身的长度
/// 这样同一轮趋势里的第二、第三次「回踩不破前低」也能入场，同时仍然要求
/// 回踩低点在中枢上沿之上（没有跌回中枢）。
fn detect_b3_v2(bars: &[Bar], j: usize, st: &Structures, cfg: &B3Config, atr_now: f64) -> Option<Setup> {
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

    // 最近一根已完成、且高点越过中枢上沿的向上笔
    let brk = st
        .strokes
        .iter()
        .rev()
        .find(|s| {
            s.up
                && s.start.original_index >= hub.end_index
                && s.end.original_index < j
                && s.high() > hub.zg * (1.0 + cfg.breakout_min / 100.0)
                && j.saturating_sub(s.start.original_index) <= cfg.leg_lookback
        })?;
    let brk_high = brk.high();
    let brk_end = brk.end.original_index;
    let leg_range = brk_high - brk.start.price;
    if leg_range <= 0.0 {
        return None;
    }

    // 突破腿之后最近一根已完成的向下笔 = 本次回踩
    let pull = st
        .strokes
        .iter()
        .rev()
        .find(|s| !s.up && s.start.original_index >= brk_end && s.end.original_index < j)?;
    let pull_low = pull.end.price;
    let pull_idx = pull.end.original_index;
    if pull_low < hub.zg * (1.0 - cfg.hub_reentry / 100.0) {
        return None; // 回踩进了中枢，不是三买
    }
    if pull_low <= brk.start.price {
        return None; // 回踩跌破向上笔起点，趋势结构已坏
    }

    let depth = (brk_high - pull_low) / leg_range;
    if depth < cfg.pullback_min || depth > cfg.pullback_max {
        return None;
    }
    let since_low = j - pull_idx;
    if since_low < 1 || since_low > cfg.confirm_window {
        return None;
    }

    let brk_vol = avg_vol(bars, brk.start.original_index, brk_end);
    let pull_vol = avg_vol(bars, pull.start.original_index, pull_idx);
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

    let brk_pct = (brk_high / hub.zg - 1.0) * 100.0;
    let stop0 = structural_stop(pull_low, hub.zg, cfg, atr_now);

    Some(Setup {
        label: "三买·突破回踩",
        stop0,
        reason: format!(
            "三买·突破回踩：中枢 ZG {:.2} 突破至 {:.2} (+{:.1}%)，最近向上笔回踩 {:.2} 未回中枢（深度 {:.0}%，量比 {:.2}）",
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
    /// 当前持仓来自哪个买点：1=三买（趋势），2=二买（反弹）。
    /// 离场规则按这个分流，而不是让两类赔率完全不同的交易共用一套止损。
    setup_kind: u8,
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
            setup_kind: 0,
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
            ParamSpec::number("pullback_min", "回踩深度下限", 0.3).with_range(0.05, 0.6, 0.05),
            ParamSpec::number("pullback_max", "回踩深度上限", 0.7).with_range(0.4, 1.0, 0.05),
            ParamSpec::number("vol_shrink", "回踩量/突破量上限", 1.0).with_range(0.3, 2.0, 0.1),
            ParamSpec::number("confirm_window", "回踩确认窗口 日", 5.0).with_range(1.0, 15.0, 1.0),
            ParamSpec::number("max_chase", "追高上限 %", 6.0).with_range(1.0, 20.0, 1.0),
            ParamSpec::number("stop_buffer", "结构止损缓冲 %", 1.5).with_range(0.0, 5.0, 0.5),
            ParamSpec::number("max_risk", "单笔最大风险 %", 12.0).with_range(2.0, 20.0, 1.0),
            ParamSpec::number("stop_atr", "结构止损 ATR 缓冲 (0=用%)", 2.0).with_range(0.0, 4.0, 0.5),
            ParamSpec::number("size_pct", "单票仓位 占槽位%", 100.0).with_range(10.0, 100.0, 5.0),
            ParamSpec::number("tp1_r", "第一批止盈 R", 2.0).with_range(1.0, 6.0, 0.5),
            ParamSpec::number("tp1_frac", "第一批比例 %", 33.0).with_range(10.0, 50.0, 1.0),
            ParamSpec::number("tp2_r", "第二批止盈 R", 3.5).with_range(2.0, 10.0, 0.5),
            ParamSpec::number("tp2_frac", "第二批比例 %", 50.0).with_range(10.0, 60.0, 5.0),
            ParamSpec::number("trail_atr", "ATR 跟踪倍数", 2.5).with_range(1.0, 6.0, 0.5),
            ParamSpec::number("max_hold", "最长持仓 日", 60.0).with_range(10.0, 200.0, 5.0),
            ParamSpec::number("enable_b2", "启用二买 1=开", 0.0).with_range(0.0, 1.0, 1.0),
            ParamSpec::number("b3_mode", "三买锚点 0=首笔 1=最近笔", 0.0).with_range(0.0, 1.0, 1.0),
            ParamSpec::number("leg_lookback", "向上笔有效期 日", 60.0).with_range(20.0, 250.0, 10.0),
            ParamSpec::number("atr_min_pct", "ATR% 下限", 0.0).with_range(0.0, 10.0, 0.25),
            ParamSpec::number("atr_max_pct", "ATR% 上限", 100.0).with_range(1.0, 20.0, 0.5),
            ParamSpec::number("ema60_max_dist", "距 EMA60 上限 %", 0.0).with_range(0.0, 50.0, 1.0),
            ParamSpec::number("div_min_r", "顶背驰最低浮盈 R", 0.5).with_range(0.0, 6.0, 0.5),
            ParamSpec::number("max_entry_bar", "确认阳线最大涨幅 % (0=关)", 4.0)
                .with_range(0.0, 10.0, 0.5),
            ParamSpec::number("b2_require_hub_up", "二买要求中枢上移", 1.0).with_range(0.0, 1.0, 1.0),
            ParamSpec::number("exit_mode", "离场分治 1=按买点类型", 1.0).with_range(0.0, 1.0, 1.0),
            ParamSpec::number("b2_breakeven_r", "二买保本 R", 0.7).with_range(0.0, 5.0, 0.1),
            ParamSpec::number("b2_tp1_r", "二买止盈1 R", 1.5).with_range(0.5, 6.0, 0.5),
            ParamSpec::number("b2_tp1_frac", "二买止盈1 比例%", 50.0).with_range(10.0, 100.0, 10.0),
            ParamSpec::number("b2_tp2_r", "二买止盈2 R", 2.5).with_range(1.0, 10.0, 0.5),
            ParamSpec::number("b2_trail_atr", "二买 ATR 跟踪", 2.0).with_range(1.0, 6.0, 0.5),
            ParamSpec::number("b2_max_hold", "二买最长持仓 日", 20.0).with_range(5.0, 120.0, 5.0),
            ParamSpec::number("b2_time_stop_r", "二买时间止损阈值 R", 0.5).with_range(0.0, 3.0, 0.25),
            ParamSpec::number("b3_breakeven_r", "三买保本 R", 1.0).with_range(0.0, 5.0, 0.1),
            ParamSpec::number("b3_tp1_r", "三买止盈1 R", 99.0).with_range(1.0, 99.0, 1.0),
            ParamSpec::number("b3_tp2_r", "三买止盈2 R", 99.0).with_range(1.0, 99.0, 1.0),
            ParamSpec::number("b3_trail_atr", "三买 ATR 跟踪", 5.0).with_range(1.0, 8.0, 0.5),
            ParamSpec::number("b3_trail_max_pct", "三买最大回吐 % (0=关)", 0.0).with_range(0.0, 30.0, 1.0),
            ParamSpec::number("b3_max_hold", "三买最长持仓 日", 120.0).with_range(20.0, 250.0, 5.0),
            ParamSpec::number("b3_div_min_r", "三买背驰最低浮盈 R", 2.0).with_range(0.0, 6.0, 0.5),
            ParamSpec::number("b3_time_stop_r", "三买时间止损阈值 R", 1.0).with_range(0.0, 3.0, 0.25),
            ParamSpec::number("regime_mode", "市场状态过滤 0关/1二买/2三买/3全部", 0.0)
                .with_range(0.0, 3.0, 1.0),
            ParamSpec::number("regime_breadth_min", "MA60 上方占比下限", 0.40).with_range(0.0, 1.0, 0.05),
            ParamSpec::number("regime_index_ma60_min", "等权净值距 MA60 下限 %", -2.0)
                .with_range(-15.0, 5.0, 1.0),
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

        // 结构质量门槛：波动率过低/过高、离 EMA60 太远的突破都不做。
        // 这两条在 HS300 与 ZZ500 的信号级样本上方向一致：ATR% 2.4~3.0 最好，
        // 收盘偏离 EMA60 超过 10% 后胜率与 40 日收益明显下滑。
        let atr_pct = if atr[j] > 0.0 { atr[j] / close * 100.0 } else { 0.0 };
        let ema60_dist = (close / es[j] - 1.0) * 100.0;
        let quality_ok = atr_pct >= self.cfg.atr_min_pct
            && atr_pct <= self.cfg.atr_max_pct
            && ema60_dist <= self.cfg.ema60_max_dist;

        // 池子级市场状态：breadth 低 = 多数成分股在自己的 MA60 下方，
        // 此时「顺势突破」大多是下跌中继的假突破。二买是逆势抄底型信号，
        // 对市场环境更敏感，所以允许只闸二买、保留三买在弱市里的反弹机会。
        let regime_ok = if self.cfg.regime_mode == 0 {
            true
        } else {
            ctx.regime.valid
                && ctx.regime.breadth_ma60 >= self.cfg.regime_breadth_min
                && ctx.regime.index_ma60_dist >= self.cfg.regime_index_ma60_min
        };
        let gate_b2 = matches!(self.cfg.regime_mode, 1 | 3);
        let gate_b3 = matches!(self.cfg.regime_mode, 2 | 3);

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

            // 按买点类型选离场规则。旧行为（exit_mode=0）三类共用一套。
            let ex = match (self.cfg.exit_mode, self.setup_kind) {
                (1, 2) => self.cfg.exit_b2,
                (1, 1) => self.cfg.exit_b3,
                _ => self.cfg.exit_shared,
            };

            let r_now = (close - self.entry_price) / self.risk.max(f64::EPSILON);
            let atr_now = if atr[j].is_finite() && atr[j] > 0.0 {
                atr[j]
            } else {
                self.entry_price * 0.02
            };

            let mut stop_line = self.stop0;
            if r_now >= ex.breakeven_r {
                stop_line = stop_line.max(self.entry_price * 1.005);
                let mut trail = self.highest - ex.trail_atr * atr_now;
                if ex.trail_max_pct > 0.0 {
                    // 绝对百分比封顶：高波动标的不允许回吐超过这个幅度
                    trail = trail.max(self.highest * (1.0 - ex.trail_max_pct / 100.0));
                }
                stop_line = stop_line.max(trail);
            }
            if close <= stop_line {
                let tag = if r_now >= ex.breakeven_r {
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
            if !self.div_done && r_now >= ex.div_min_r {
                if let Some((top, ratio)) = top_divergence(&st, &hist, j, &self.cfg) {
                    if close < top {
                        self.div_done = true;
                        let keep = strong && r_now < ex.tp2_r && self.tp_done == 0;
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

            if r_now >= ex.tp2_r && self.tp_done == 1 {
                self.pending_tp = true;
                return Signal::sell_percent(
                    tradable_frac(ctx.position.shares, ex.tp2_frac),
                    format!("分批止盈2：{r_now:.1}R ≥ {:.1}R", ex.tp2_r),
                )
                .with_score(trend_score);
            }
            if r_now >= ex.tp1_r && self.tp_done == 0 {
                self.pending_tp = true;
                return Signal::sell_percent(
                    tradable_frac(ctx.position.shares, ex.tp1_frac),
                    format!("分批止盈1：{r_now:.1}R ≥ {:.1}R", ex.tp1_r),
                )
                .with_score(trend_score);
            }

            let held = n - 1 - self.entry_bar;
            if held >= ex.max_hold && r_now < ex.time_stop_r {
                return Signal::sell_percent(
                    100.0,
                    format!(
                        "时间止损：持仓 {held} 日仍未走出 {:.1}R",
                        ex.time_stop_r
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

        let mut setup = if strong && (!gate_b3 || regime_ok) {
            let raw = if self.cfg.b3_mode == 1 {
                detect_b3_v2(win, j, &st, &self.cfg, atr[j])
            } else {
                detect_b3(win, j, &st, &self.cfg, atr[j])
            };
            if quality_ok { raw } else { None }
        } else {
            None
        };
        let mut kind = 1u8;
        if setup.is_none()
            && self.cfg.enable_b2
            && mild
            && (!self.cfg.b2_require_hub_up || hub_up)
            && (!gate_b2 || regime_ok)
        {
            if let Some(s) = detect_b2(win, j, &st, &hist, &self.cfg) {
                setup = Some(s);
                kind = 2;
            }
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
        self.setup_kind = kind;
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
