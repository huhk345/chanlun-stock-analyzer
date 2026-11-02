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

// ---- 设计常量（不是旋钮）---------------------------------------------------
// 这些值决定策略「是什么」，而不是「调多少」：
//   均线周期 = 顺势的定义；中枢参数 = 缠论的定义；背驰阈值 = 缠论的定义。
// 放在这里当常量，是因为它们从来没有被扫出过平台（改了要么更差要么没差别），
// 留在面板上只会诱导人去调一个没有信息量的旋钮。
const MA_FAST: usize = 10;
const MA_MID: usize = 20;
const MA_SLOW: usize = 60;
const SLOPE_LEN: usize = 10;
const HUB_LOOKBACK: usize = 120;
const MAX_HUB_AMP: f64 = 30.0;
const HUB_REENTRY: f64 = 0.5;
const ATR_PERIOD: usize = 14;
const DIV_RATIO: f64 = 0.85;
const BREAKEVEN_R: f64 = 1.0;
const TIME_STOP_R: f64 = 1.0;
const DIV_MIN_R: f64 = 2.0;
const SIZE_PCT: f64 = 100.0;
/// 回吐上限：浮盈见顶后最多回吐一半。
///
/// Chandelier 跟踪是 `最高价 − trail_atr × ATR`，在 2.3% ATR 的票上等于 11% 的回吐空间，
/// 也就是说**浮盈不到 11% 时这条线根本不存在**，赢家只能靠保本线兜着。把它换成 R 单位
/// 看是 `trail_atr × ATR / 风险`，每个股票池都是不同的数 —— 这正是「参数在押池子」的来源：
/// 沪深300 的赢家能跑到 +21%（跟踪线有效），中证500 的赢家只到 +9%（跟踪线是死代码），
/// 同一套规则在后者上等于没有止盈。
///
/// 这条线改在**盈利空间**里定义：`成本 + (最高浮盈) × 0.5`。因为止损线取各条线的最大值，
/// 它只在「ATR 跟踪线比它更松」时生效 —— 也就是只在小/中赢家上收紧，大趋势碰不到它。
/// 沪深300 实测：均值 10.72%→10.50%，中位数 4.95%→8.17%，胜率 53%→59%；
/// 低趋势效率（震荡）子样本 2.14%→4.31%，胜率 33%→47%。
const GIVEBACK_KEEP: f64 = 0.5;
/// `stop_atr` 取不到 ATR 时的备用缓冲（%）
const STOP_BUFFER_FALLBACK: f64 = 1.5;

/// 11 个真正影响信号的参数。其余全部下沉成常量或删掉：
/// 46 个参数 / 80 笔来回，自由度比样本还大，多留一个旋钮就是多一次过拟合的机会。
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
        }
    }
}

/// 一个待执行的买点。
struct Setup {
    label: &'static str,
    stop0: f64,
    reason: String,
    quality: f64,
    /// 突破段的平均成交量 / 突破前 20 日均量（VMA 因子）
    brk_vol_ratio: f64,
}

// ---------------------------------------------------------------------------
// Alpha 门控：雪球技术指标分类 + 公开研报里能用 OHLCV 复现的部分
// ---------------------------------------------------------------------------
//
// 雪球上被反复引用的一类公开因子（源自瑞银技术指标分类）里，只做多有效的几条是
// 动量 SLOPE、波动率 NATR、日内形态 KSFT、成交量 VMA。这里只取能在这里稳定复现、
// 且事后不会变形的三条，做成硬门控而不是评分：
//
//   * SLOPE  —— MA120 相对 20 日前上行 + 收盘站上 MA120（慢速趋势方向）
//   * NATR   —— ATR14 / 收盘价，给追突破的波动率设上限
//   * VMA    —— 突破段均量 / 突破前 20 日均量，要求「突破有量」
//
// 另外两条来自公开研报的突破类因子：距 250 日高点回撤（只买接近新高的突破，
// 不买深坑反弹）、池子广度 breadth_ma60（整体在跌时不接突破）。
//
// KSFT（日内收盘位置强度）与 PTC（价量相关）在信号级测试里正反都不稳定，
// 硬门控会让样本外更差，所以没有进代码 —— 宁可少一条因子，也不要多一个过拟合口。
#[derive(Debug, Clone, Copy)]
struct AlphaGate {
    /// 0 = 关闭（等价于原策略）；1 = 个股趋势+突破质量；2 = 再加池子广度；3 = 再加波动/流动性/周线
    level: u8,
    min_brk_vol: f64,
    /// 负数：要求 `close / 250 日最高价 - 1 >= 该值`
    min_dd_from_high: f64,
    min_breadth: f64,
    max_natr: f64,
    min_amount_wan: f64,
}

impl AlphaGate {
    const OFF: Self = Self {
        level: 0,
        min_brk_vol: 0.0,
        min_dd_from_high: -100.0,
        min_breadth: 0.0,
        max_natr: 0.0,
        min_amount_wan: 0.0,
    };

    fn from_params(p: &Params) -> Self {
        Self {
            level: p.f64("filter_level", 1.0).clamp(0.0, 3.0) as u8,
            min_brk_vol: p.f64("min_brk_vol", 1.1).max(0.0),
            min_dd_from_high: p.f64("min_dd_from_high", -20.0),
            min_breadth: p.f64("min_breadth", 0.40).clamp(0.0, 1.0),
            max_natr: p.f64("max_natr", 6.0).max(0.0),
            min_amount_wan: p.f64("min_amount_wan", 2000.0).max(0.0),
        }
    }

    fn enabled(&self) -> bool {
        self.level > 0
    }

    /// `Some(原因)` = 拒绝；`None` = 放行。
    fn block(
        &self,
        ctx: &DayContext<'_>,
        win: &[Bar],
        j: usize,
        setup: &Setup,
        atr_now: f64,
        closes: &[f64],
    ) -> Option<&'static str> {
        if self.level == 0 {
            return None;
        }
        let close = ctx.close();

        // ---- 1. 顺势：收盘站上 MA120 且 MA120 上行 ----
        let Some(ma120) = sma_at(closes, j, 120) else {
            return Some("预热不足 120 日");
        };
        if close <= ma120 {
            return Some("收盘低于 MA120");
        }
        if j >= 20 {
            let Some(ma120_prev) = sma_at(closes, j - 20, 120) else {
                return Some("预热不足 140 日");
            };
            if ma120 <= ma120_prev {
                return Some("MA120 未上行");
            }
        }

        // ---- 2. 突破之后：不买远离 250 日高点的深坑反弹 ----
        if let Some(hi) = highest_high(win, j, 250) {
            if hi > 0.0 {
                let dd = (close / hi - 1.0) * 100.0;
                if dd < self.min_dd_from_high {
                    return Some("距 250 日高点过远");
                }
            }
        }

        // ---- 3. 突破有量 ----
        if setup.brk_vol_ratio < self.min_brk_vol {
            return Some("突破未放量");
        }

        // ---- 4. 池子广度 ----
        if self.level >= 2 && ctx.regime.valid && ctx.regime.breadth_ma60 < self.min_breadth {
            return Some("池子广度不足");
        }

        // ---- 5. 波动率、流动性、周线 ----
        if self.level >= 3 {
            if !(atr_now.is_finite() && atr_now > 0.0) {
                return Some("ATR 不可用");
            }
            if self.max_natr > 0.0 && atr_now / close * 100.0 > self.max_natr {
                return Some("波动率过高");
            }
            if let Some(amt) = avg_amount_wan(win, j, 20) {
                if self.min_amount_wan > 0.0 && amt < self.min_amount_wan {
                    return Some("流动性不足");
                }
            }
            if !weekly_trend_ok(closes) {
                return Some("周线未确认");
            }
        }

        None
    }
}

fn sma_at(v: &[f64], end: usize, n: usize) -> Option<f64> {
    if n == 0 || end + 1 < n {
        return None;
    }
    Some(v[end + 1 - n..=end].iter().sum::<f64>() / n as f64)
}

fn highest_high(bars: &[Bar], end: usize, n: usize) -> Option<f64> {
    if end + 1 < n {
        return None;
    }
    bars[end + 1 - n..=end]
        .iter()
        .map(|b| b.high)
        .fold(None, |acc: Option<f64>, h| Some(acc.map_or(h, |a| a.max(h))))
}

/// 20 日平均成交额（万元）。`BarState` 里没有 amount 字段，按 volume×close×100 估算
/// （缓存里的 volume 单位是「手」）。
fn avg_amount_wan(bars: &[Bar], end: usize, n: usize) -> Option<f64> {
    if end + 1 < n {
        return None;
    }
    let sum: f64 = bars[end + 1 - n..=end]
        .iter()
        .map(|b| b.volume * b.close * 100.0)
        .sum();
    Some(sum / n as f64 / 10_000.0)
}

/// 周线确认：按 5 日收盘对齐到「本周」，周收盘站上 10 周均线且均线上行。
fn weekly_trend_ok(closes: &[f64]) -> bool {
    let n = closes.len();
    if n < 5 * 14 {
        return false;
    }
    let mut weekly: Vec<f64> = Vec::with_capacity(n / 5);
    let mut i = n;
    while i >= 5 {
        weekly.push(closes[i - 1]);
        i -= 5;
    }
    weekly.reverse();
    let m = weekly.len();
    if m < 11 {
        return false;
    }
    let ma10 = weekly[m - 10..].iter().sum::<f64>() / 10.0;
    // 约一个月前的 10 周均线（第 m-13..m-3 周）
    let ma10_prev = weekly[m - 13..m - 3].iter().sum::<f64>() / 10.0;
    weekly[m - 1] > ma10 && ma10 > ma10_prev
}

fn avg_vol(bars: &[Bar], from: usize, to: usize) -> f64 {
    if to < from {
        return 0.0;
    }
    let sum: f64 = bars[from..=to].iter().map(|b| b.volume).sum();
    sum / (to - from + 1) as f64
}

/// 分批卖出的比例修正：A 股一手 100 股，按比例拆出来的量不足一手时，
/// 撮合层会算出 0 手直接拒单（决策日志里表现为「无可卖数量」）。
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

    Some(Setup {
        label: "三买·突破回踩",
        stop0,
        reason: format!(
            "三买·突破回踩：中枢 ZG {:.2} 突破至 {:.2} (+{:.1}%)，回踩 {:.2} 未回中枢（深度 {:.0}%，量比 {:.2}，突破量比 {:.2}x）",
            hub.zg,
            brk_high,
            brk_pct,
            pull_low,
            depth * 100.0,
            vol_ratio,
            brk_vol_ratio
        ),
        quality: (0.45 + (brk_pct / 10.0).clamp(0.0, 0.25) + (1.0 - vol_ratio).clamp(0.0, 0.2) * 0.3)
            .clamp(0.0, 1.0),
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

pub struct ChanlunB3Pullback {
    cfg: B3Config,
    /// 关闭时等价于原策略；打开时在买点上再加一层 alpha 门控
    alpha: AlphaGate,
    ident: &'static str,
    label: &'static str,
    desc: &'static str,
    /// 持仓跟踪状态（引擎按标的各建一个实例，所以可以直接持有）
    tracked: bool,
    entry_price: f64,
    entry_bar: usize,
    highest: f64,
    stop0: f64,
    risk: f64,
    div_done: bool,
}

const B3_DESC: &str = "只做三买（突破中枢后回抽不回中枢），要求 EMA 多头排列的顺势环境；\
     突破幅度+回踩深度+回踩缩量+确认阳线四重约束；\
     卖点为结构止损（ATR 计价）/顶背驰/ATR 跟踪止盈，不设固定止盈";

const ALPHA_DESC: &str = "在缠论三买之上叠加顺势 alpha 门控（默认层级 1：收盘站上 MA120 且 MA120 上行 SLOPE / \
     距 250 日高点 ≤20%（只买接近新高的突破）/ 突破段放量 ≥1.1x VMA）；\
     filter_level=2 再加池子广度 breadth_ma60≥0.4，=3 再加 NATR≤6%、20 日成交额≥2000 万、周线确认，=0 关闭；\
     卖点沿用三买的结构止损+顶背驰+ATR 跟踪";

impl ChanlunB3Pullback {
    pub fn new(params: &Params) -> Self {
        Self::with_gate(
            params,
            AlphaGate::OFF,
            "cl-trend-b3-pullback",
            "缠论顺势三买·突破回踩",
            B3_DESC,
        )
    }

    pub fn with_alpha(params: &Params) -> Self {
        Self::with_gate(
            params,
            AlphaGate::from_params(params),
            "cl-trend-breakout-alpha",
            "缠论顺势突破·Alpha 门控",
            ALPHA_DESC,
        )
    }

    fn with_gate(
        params: &Params,
        alpha: AlphaGate,
        ident: &'static str,
        label: &'static str,
        desc: &'static str,
    ) -> Self {
        Self {
            cfg: B3Config::from_params(params),
            alpha,
            ident,
            label,
            desc,
            tracked: false,
            entry_price: 0.0,
            entry_bar: 0,
            highest: 0.0,
            stop0: 0.0,
            risk: 0.0,
            div_done: false,
        }
    }
}

impl Strategy for ChanlunB3Pullback {
    fn id(&self) -> &'static str {
        self.ident
    }

    fn name(&self) -> &'static str {
        self.label
    }

    fn description(&self) -> &'static str {
        self.desc
    }

    fn params(&self) -> Vec<ParamSpec> {
        let mut out = vec![
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
        ];
        if self.alpha.enabled() {
            out.extend([
                ParamSpec::number("filter_level", "Alpha 门控层级 0-3", 1.0).with_range(0.0, 3.0, 1.0),
                ParamSpec::number("min_brk_vol", "突破放量下限 (x)", 1.1).with_range(0.5, 3.0, 0.05),
                ParamSpec::number("min_dd_from_high", "距 250 日高点下限 %", -20.0)
                    .with_range(-50.0, 0.0, 1.0),
                ParamSpec::number("min_breadth", "池子广度下限", 0.40).with_range(0.0, 1.0, 0.05),
                ParamSpec::number("max_natr", "NATR 上限 % (层级3)", 6.0).with_range(1.0, 20.0, 0.5),
                ParamSpec::number("min_amount_wan", "20 日成交额下限 万元 (层级3)", 2000.0)
                    .with_range(0.0, 50000.0, 500.0),
            ]);
        }
        out
    }

    fn on_day(&mut self, ctx: &DayContext<'_>) -> Signal {
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
            }
            self.highest = self.highest.max(ctx.today().high);

            let r_now = (close - self.entry_price) / self.risk.max(f64::EPSILON);
            let atr_now = if atr[j].is_finite() && atr[j] > 0.0 {
                atr[j]
            } else {
                self.entry_price * 0.02
            };

            // 止损线：结构止损 → +1R 保本 → Chandelier 跟踪 → 回吐上限（不设固定止盈）
            let mut stop_line = self.stop0;
            if r_now >= BREAKEVEN_R {
                stop_line = stop_line.max(self.entry_price * 1.005);
                stop_line = stop_line.max(self.highest - self.cfg.trail_atr * atr_now);
                // 只在小/中赢家上生效：大趋势的回吐空间本来就大于这条线
                stop_line = stop_line.max(
                    self.entry_price + (self.highest - self.entry_price) * GIVEBACK_KEEP,
                );
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

        let risk_pct = (close - s.stop0) / close * 100.0;
        if !(risk_pct > 0.0) || risk_pct > self.cfg.max_risk {
            return Signal::hold().with_score(trend_score);
        }

        // 结构上已经是三买，这里再问一次「是不是顺势的突破」。
        // 门控放在状态赋值之前，被拒时不会留下幽灵持仓标记。
        if self
            .alpha
            .block(ctx, win, j, &s, atr[j], &closes)
            .is_some()
        {
            return Signal::hold().with_score(trend_score);
        }

        self.tracked = true;
        self.entry_price = close;
        self.entry_bar = n - 1;
        self.stop0 = s.stop0;
        self.risk = (close - s.stop0).max(close * 0.01);
        self.highest = ctx.today().high;
        self.div_done = false;

        Signal::buy_percent(
            SIZE_PCT,
            format!(
                "{}｜风险 {risk_pct:.1}% 仓位 {SIZE_PCT:.0}%{}",
                s.reason,
                if hub_up { "｜中枢上移" } else { "" }
            ),
        )
        .with_score((s.quality * 0.7 + trend_score * 0.3).clamp(0.0, 1.0))
    }
}

// ---------------------------------------------------------------------------
// 6. 缠论突破 · 年线闸门 (cl-breakout-state)
//
// 与 src/strategies/cl-breakout-state.js 同一套语义，两边改动必须同步。
//
// 入场：站上上行年线 + N 日新高 + 放量 + 离开最近笔中枢的力度 + 最后一笔向上
// 离场：年线失守 / 浮盈到过 protect_after% 之后的保护线（保本、20 日低点、回吐一半）
// 没有初始价格止损、没有固定止盈、没有时间止损 —— 详见 JS 侧的设计说明。
// ---------------------------------------------------------------------------

const BRK_MA_YEAR: usize = 200;
const BRK_SLOPE_LEN: usize = 20;
const BRK_VOL_MA: usize = 20;
const BRK_TRAIL_LOOKBACK: usize = 20;
const BRK_MAX_CHASE_PCT: f64 = 5.0;
const BRK_MAX_ENTRY_BAR_PCT: f64 = 9.5;
const BRK_BREAKEVEN: f64 = 1.005;
const BRK_SIZE_PCT: f64 = 99.5;

const BRK_DESC: &str = "把「行业广度 + 指数 MA200」压缩到单标的：只在个股站上上行年线时做多；\
     入场要求 N 日新高 + 放量 + 离开缠论中枢的力度；仓位只有满仓/空仓两档；\
     离场只有年线失守与浮盈保护，不设价格止损与固定止盈";

#[derive(Clone, Copy)]
struct BreakoutCfg {
    breakout_days: usize,
    vol_ratio: f64,
    depart_ratio: f64,
    protect_after: f64,
}

impl BreakoutCfg {
    fn from_params(p: &Params) -> Self {
        Self {
            breakout_days: p.f64("breakout_days", 60.0).clamp(5.0, 250.0) as usize,
            vol_ratio: p.f64("vol_ratio", 1.5).max(0.0),
            depart_ratio: p.f64("depart_ratio", 0.5).max(0.0),
            protect_after: p.f64("protect_after", 10.0),
        }
    }
}

/// 简单均线在 end 处的值 —— 复用文件上方已有的 `sma_at`（同一语义）

pub struct ChanlunBreakoutState {
    cfg: BreakoutCfg,
    tracked: bool,
    entry_price: f64,
    entry_bar: usize,
    highest: f64,
}

impl ChanlunBreakoutState {
    pub fn new(params: &Params) -> Self {
        Self {
            cfg: BreakoutCfg::from_params(params),
            tracked: false,
            entry_price: 0.0,
            entry_bar: 0,
            highest: 0.0,
        }
    }
}

impl Strategy for ChanlunBreakoutState {
    fn id(&self) -> &'static str {
        "cl-breakout-state"
    }

    fn name(&self) -> &'static str {
        "缠论突破·年线闸门"
    }

    fn description(&self) -> &'static str {
        BRK_DESC
    }

    fn params(&self) -> Vec<ParamSpec> {
        vec![
            ParamSpec::number("breakout_days", "突破窗口 日", 60.0).with_range(10.0, 250.0, 5.0),
            ParamSpec::number("vol_ratio", "突破放量倍数", 1.5).with_range(0.8, 4.0, 0.1),
            ParamSpec::number("depart_ratio", "离开中枢力度 (x 中枢高)", 0.5)
                .with_range(0.0, 3.0, 0.1),
            ParamSpec::number("protect_after", "浮盈保护启动 %", 10.0).with_range(3.0, 40.0, 1.0),
        ]
    }

    fn on_day(&mut self, ctx: &DayContext<'_>) -> Signal {
        let bars = ctx.bars;
        let n = bars.len();
        if n < BRK_MA_YEAR + BRK_SLOPE_LEN + 10 {
            return Signal::hold();
        }

        if ctx.position.shares <= 0.0 {
            self.tracked = false;
            self.highest = 0.0;
        }

        let base = n.saturating_sub(CL_WINDOW);
        let win = &bars[base..];
        let j = win.len() - 1;
        if j < BRK_MA_YEAR + BRK_SLOPE_LEN {
            return Signal::hold();
        }

        let closes: Vec<f64> = win.iter().map(|b| b.close).collect();
        let vols: Vec<f64> = win.iter().map(|b| b.volume).collect();

        let close = ctx.close();
        if !(close > 0.0) {
            return Signal::hold();
        }

        let (Some(ma_year), Some(ma_year_prev)) = (
            sma_at(&closes, j, BRK_MA_YEAR),
            sma_at(&closes, j - BRK_SLOPE_LEN, BRK_MA_YEAR),
        ) else {
            return Signal::hold();
        };

        let trend_score = ((close / ma_year - 1.0) * 4.0).clamp(0.0, 1.0);

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
                self.highest = ctx.today().high;
            }
            self.highest = self.highest.max(ctx.today().high);

            let entry = self.entry_price;
            let gain_pct = (close / entry - 1.0) * 100.0;
            let peak_pct = (self.highest / entry - 1.0) * 100.0;

            // 年线失守 = 状态翻转，唯一的无条件离场
            if close < ma_year {
                return Signal::sell_percent(
                    100.0,
                    format!(
                        "年线失守：收盘 {close:.2} < MA200 {ma_year:.2}\
                         （成本 {entry:.2}，{gain_pct:.1}%，最高 {peak_pct:.0}%）"
                    ),
                )
                .with_score(0.0);
            }

            // 浮盈保护：只有赚过 protect_after% 之后才启用
            if peak_pct >= self.cfg.protect_after {
                let mut stop_line = entry * BRK_BREAKEVEN;
                let entry_j = self.entry_bar.saturating_sub(base);
                let from = j.saturating_sub(BRK_TRAIL_LOOKBACK);
                let mut low_n = f64::INFINITY;
                for t in from..j {
                    if t < entry_j {
                        continue;
                    }
                    low_n = low_n.min(win[t].low);
                }
                if low_n.is_finite() {
                    stop_line = stop_line.max(low_n);
                }
                // 回吐上限定义在盈利空间里，与波动率无关
                stop_line = stop_line.max(entry + (self.highest - entry) * GIVEBACK_KEEP);

                if close <= stop_line {
                    return Signal::sell_percent(
                        100.0,
                        format!(
                            "浮盈保护：收盘 {close:.2} ≤ 保护线 {stop_line:.2}\
                             （成本 {entry:.2}，最高 {peak_pct:.0}%，当前 {gain_pct:.1}%）"
                        ),
                    )
                    .with_score(0.0);
                }
            }

            return Signal::hold().with_score(trend_score);
        }

        // ---- 空仓分支 ----
        // 现金连一手都不够时不再发买入信号，否则决策日志里全是「现金不足」
        if ctx.account.cash < close * 100.0 {
            return Signal::hold().with_score(trend_score);
        }

        // 1) 状态闸门：站上年线，且年线在上行
        if !(close > ma_year) || !(ma_year > ma_year_prev) {
            return Signal::hold().with_score(trend_score);
        }

        // 2) 价格突破：收盘创前 breakout_days 根新高
        let days = self.cfg.breakout_days.min(j);
        if days == 0 {
            return Signal::hold().with_score(trend_score);
        }
        let mut prior_high = f64::NEG_INFINITY;
        for t in (j - days)..j {
            prior_high = prior_high.max(win[t].high);
        }
        if !(prior_high > 0.0) || !(close > prior_high) {
            return Signal::hold().with_score(trend_score);
        }
        let chase = (close / prior_high - 1.0) * 100.0;
        if chase > BRK_MAX_CHASE_PCT {
            return Signal::hold().with_score(trend_score);
        }

        // 3) 量能：突破日必须放量
        let Some(vol_ma) = sma_at(&vols, j - 1, BRK_VOL_MA) else {
            return Signal::hold().with_score(trend_score);
        };
        if !(vol_ma > 0.0) || !(vols[j] >= vol_ma * self.cfg.vol_ratio) {
            return Signal::hold().with_score(trend_score);
        }

        // 4) 缠论结构：最近一个已完成的笔中枢，收盘在其上方且离开得够远
        let st = chanlun::compute(win);
        let Some(hub) = st
            .hubs
            .iter()
            .rev()
            .find(|h| h.zg > h.zd && h.end_index + 1 < j)
        else {
            return Signal::hold().with_score(trend_score);
        };
        if j - hub.end_index > HUB_LOOKBACK {
            return Signal::hold().with_score(trend_score);
        }
        let hub_height = hub.gg - hub.dd;
        if !(hub_height > 0.0) || !(hub.dd > 0.0) {
            return Signal::hold().with_score(trend_score);
        }
        if hub_height / hub.dd * 100.0 > MAX_HUB_AMP {
            return Signal::hold().with_score(trend_score);
        }
        if !(close > hub.zg) {
            return Signal::hold().with_score(trend_score);
        }
        let depart = (close - hub.zg) / hub_height;
        if depart < self.cfg.depart_ratio {
            return Signal::hold().with_score(trend_score);
        }

        // 5) 方向一致：最后一笔向上
        let Some(last) = st.strokes.last() else {
            return Signal::hold().with_score(trend_score);
        };
        if !last.up {
            return Signal::hold().with_score(trend_score);
        }

        // 6) K 线形态：阳线，且不是涨停收盘
        let today = ctx.today();
        if !(close > today.open) {
            return Signal::hold().with_score(trend_score);
        }
        let prev_close = win[j - 1].close;
        if prev_close > 0.0 && (close / prev_close - 1.0) * 100.0 > BRK_MAX_ENTRY_BAR_PCT {
            return Signal::hold().with_score(trend_score);
        }

        let quality = (0.45
            + (depart / 3.0).clamp(0.0, 0.25)
            + ((close / ma_year - 1.0) * 100.0 / 30.0).clamp(0.0, 0.3))
        .clamp(0.0, 1.0);

        self.tracked = true;
        self.entry_price = close;
        self.entry_bar = n - 1;
        self.highest = today.high;

        Signal::buy_percent(
            BRK_SIZE_PCT,
            format!(
                "突破·年线闸门：{} 日新高 {prior_high:.2} → {close:.2}（+{chase:.1}%，\
                 MA200 上方 {:.0}%），离开中枢 ZG {:.2} 达 {depart:.2} 倍中枢高",
                self.cfg.breakout_days,
                (close / ma_year - 1.0) * 100.0,
                hub.zg
            ),
        )
        .with_score((quality * 0.6 + trend_score * 0.4).clamp(0.0, 1.0))
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
    StrategyMeta {
        id: "cl-trend-breakout-alpha",
        name: "缠论顺势突破·Alpha 门控",
        description: "缠论三买 + 顺势 alpha 门控 (MA120趋势(SLOPE)/距250日高点/突破放量(VMA); 可选池子广度/NATR/流动性/周线), 只做突破之后的股票",
        params: || ChanlunB3Pullback::with_alpha(&Params::new()).params(),
        build: |p| Box::new(ChanlunB3Pullback::with_alpha(p)),
    },
    StrategyMeta {
        id: "cl-breakout-state",
        name: "缠论突破·年线闸门",
        description: "站上上行年线 + N 日新高 + 放量 + 离开缠论中枢的力度; 仓位只有满仓/空仓两档; 离场只有年线失守与浮盈保护, 不设价格止损与固定止盈",
        params: || ChanlunBreakoutState::new(&Params::new()).params(),
        build: |p| Box::new(ChanlunBreakoutState::new(p)),
    },
];

pub fn build_strategy(id: &str, params: &Params) -> Option<Box<dyn Strategy>> {
    STRATEGIES
        .iter()
        .find(|m| m.id == id)
        .map(|m| (m.build)(params))
}
