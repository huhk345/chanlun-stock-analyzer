//! 海龟趋势突破·唐奇安通道 (turtle-trend-breakout).

use crate::strategy::{DayContext, ParamSpec, Params, Signal, Strategy};

use super::common::{atr_at, avg_vol, highest_high, lowest_low, sma_at};

// ---------------------------------------------------------------------------
// 7. 海龟趋势突破 · 唐奇安通道 (turtle-trend-breakout)
//
// 与 src/strategies/turtle-trend-breakout.js 同一套语义，两边改动必须同步。
//
// 入场：站上上行年线 + 突破前 entry_days 日最高价 + 放量 + 不追高 + 非涨停 + 阳线
// 离场：固定止损（建仓价 − stop_atr × 建仓日 N）/ 跌破前 exit_days 日最低 / 跌破年线
// 仓位：percent = risk_pct × close / (stop_atr × N) × 100，止损触发时亏 risk_pct%
//
// 不做金字塔加仓：执行层持仓时只能 SELL/HOLD，组合层又是等权固定槽位。
// ---------------------------------------------------------------------------

const TT_TREND_MA: usize = 200;
const TT_TREND_SLOPE: usize = 20;
const TT_VOL_MA: usize = 20;
const TT_MAX_CHASE_PCT: f64 = 4.0;
const TT_MAX_ENTRY_BAR_PCT: f64 = 9.0;
const TT_N_MIN_PCT: f64 = 0.8;
const TT_N_MAX_PCT: f64 = 10.0;
const TT_MIN_SIZE_PCT: f64 = 10.0;
const TT_MAX_SIZE_PCT: f64 = 95.0;

const TT_DESC: &str = "海龟交易法则的股票版本：唐奇安通道突破入场、反向唐奇安低点离场、\
     N(ATR20) 定仓位与固定止损；只在上行年线上方做多，突破日要求放量、不追高、不买涨停；\
     没有固定止盈，也不做金字塔加仓（执行层与等权槽位不允许）";

#[derive(Clone, Copy)]
struct TurtleCfg {
    entry_days: usize,
    exit_days: usize,
    atr_period: usize,
    stop_atr: f64,
    vol_ratio: f64,
    risk_pct: f64,
}

impl TurtleCfg {
    fn from_params(p: &Params) -> Self {
        Self {
            entry_days: p.f64("entry_days", 20.0).clamp(3.0, 250.0) as usize,
            exit_days: p.f64("exit_days", 10.0).clamp(2.0, 60.0) as usize,
            atr_period: p.f64("atr_period", 20.0).clamp(2.0, 60.0) as usize,
            stop_atr: p.f64("stop_atr", 3.0).max(0.5),
            vol_ratio: p.f64("vol_ratio", 1.2).max(0.0),
            risk_pct: p.f64("risk_pct", 2.0).max(0.1),
        }
    }
}

pub struct TurtleTrendBreakout {
    cfg: TurtleCfg,
    tracked: bool,
    entry_price: f64,
    entry_n: f64,
}

impl TurtleTrendBreakout {
    pub fn new(params: &Params) -> Self {
        Self {
            cfg: TurtleCfg::from_params(params),
            tracked: false,
            entry_price: 0.0,
            entry_n: 0.0,
        }
    }
}

impl Strategy for TurtleTrendBreakout {
    fn id(&self) -> &'static str {
        "turtle-trend-breakout"
    }

    fn name(&self) -> &'static str {
        "海龟趋势突破·唐奇安通道"
    }

    fn description(&self) -> &'static str {
        TT_DESC
    }

    fn params(&self) -> Vec<ParamSpec> {
        vec![
            ParamSpec::number("entry_days", "突破窗口 日", 20.0).with_range(10.0, 250.0, 1.0),
            ParamSpec::number("exit_days", "离场窗口 日", 10.0).with_range(3.0, 60.0, 1.0),
            ParamSpec::number("atr_period", "N 周期 (ATR)", 20.0).with_range(5.0, 60.0, 1.0),
            ParamSpec::number("stop_atr", "止损距离 (x N)", 3.0).with_range(1.0, 5.0, 0.1),
            ParamSpec::number("vol_ratio", "突破放量倍数", 1.2).with_range(0.8, 3.0, 0.1),
            ParamSpec::number("risk_pct", "单笔风险预算 %", 2.0).with_range(0.5, 5.0, 0.1),
        ]
    }

    fn on_day(&mut self, ctx: &DayContext<'_>) -> Signal {
        let bars = ctx.bars;
        let n = bars.len();
        if n < TT_TREND_MA + TT_TREND_SLOPE + 10 {
            return Signal::hold();
        }
        if ctx.position.shares <= 0.0 {
            self.tracked = false;
        }

        let j = n - 1;
        let close = ctx.close();
        if !(close > 0.0) {
            return Signal::hold();
        }

        let closes: Vec<f64> = bars.iter().map(|b| b.close).collect();
        let (Some(ma_trend), Some(ma_trend_prev)) = (
            sma_at(&closes, j, TT_TREND_MA),
            sma_at(&closes, j - TT_TREND_SLOPE, TT_TREND_MA),
        ) else {
            return Signal::hold();
        };
        let trend_score = ((close / ma_trend - 1.0) * 4.0).clamp(0.0, 1.0);

        // ---- 持仓分支 ----
        if ctx.position.shares > 0.0 {
            if !self.tracked {
                // 换仓 / 重启后自愈：按持仓均价与当日 N 反推风险预算
                self.tracked = true;
                self.entry_price = if ctx.position.avg_cost > 0.0 {
                    ctx.position.avg_cost
                } else {
                    close
                };
                self.entry_n = atr_at(bars, j, self.cfg.atr_period).unwrap_or(0.0);
            }

            let entry = self.entry_price;
            let stop_line = if self.entry_n.is_finite() && self.entry_n > 0.0 {
                entry - self.cfg.stop_atr * self.entry_n
            } else {
                entry * 0.92
            };
            let gain_pct = (close / entry - 1.0) * 100.0;

            if close <= stop_line {
                return Signal::sell_percent(
                    100.0,
                    format!(
                        "固定止损：收盘 {close:.2} ≤ 止损线 {stop_line:.2}\
                         （成本 {entry:.2}，N {:.2}，{gain_pct:.1}%）",
                        self.entry_n
                    ),
                )
                .with_score(0.0);
            }

            if let Some(prior_low) = lowest_low(bars, j - 1, self.cfg.exit_days.min(j)) {
                if close < prior_low {
                    return Signal::sell_percent(
                        100.0,
                        format!(
                            "唐奇安离场：收盘 {close:.2} < {} 日最低 {prior_low:.2}\
                             （成本 {entry:.2}，{gain_pct:.1}%）",
                            self.cfg.exit_days
                        ),
                    )
                    .with_score(0.0);
                }
            }

            if close < ma_trend {
                return Signal::sell_percent(
                    100.0,
                    format!(
                        "趋势失守：收盘 {close:.2} < MA200 {ma_trend:.2}\
                         （成本 {entry:.2}，{gain_pct:.1}%）"
                    ),
                )
                .with_score(0.0);
            }

            return Signal::hold().with_score(trend_score);
        }

        // ---- 空仓分支 ----
        if ctx.account.cash < close * 100.0 {
            return Signal::hold().with_score(trend_score);
        }

        // 1) 趋势闸门：站上年线且年线上行
        if !(close > ma_trend) || !(ma_trend > ma_trend_prev) {
            return Signal::hold().with_score(trend_score);
        }

        // 2) N 的波动带：太低是死水，太高是止损过宽
        let Some(n_unit) = atr_at(bars, j, self.cfg.atr_period) else {
            return Signal::hold().with_score(trend_score);
        };
        if !(n_unit > 0.0) {
            return Signal::hold().with_score(trend_score);
        }
        let n_pct = n_unit / close * 100.0;
        if n_pct < TT_N_MIN_PCT || n_pct > TT_N_MAX_PCT {
            return Signal::hold().with_score(trend_score);
        }

        // 3) 大突破：收盘创前 entry_days 根新高
        let Some(prior_high) = highest_high(bars, j - 1, self.cfg.entry_days.min(j)) else {
            return Signal::hold().with_score(trend_score);
        };
        if !(prior_high > 0.0) || !(close > prior_high) {
            return Signal::hold().with_score(trend_score);
        }
        let chase = (close / prior_high - 1.0) * 100.0;
        if chase > TT_MAX_CHASE_PCT {
            return Signal::hold().with_score(trend_score);
        }

        // 4) 放量
        let vol_ma = avg_vol(bars, j.saturating_sub(TT_VOL_MA), j - 1);
        if !(vol_ma > 0.0) || !(bars[j].volume >= vol_ma * self.cfg.vol_ratio) {
            return Signal::hold().with_score(trend_score);
        }

        // 5) 阳线、非涨停
        let today = ctx.today();
        if !(close > today.open) {
            return Signal::hold().with_score(trend_score);
        }
        let prev_close = bars[j - 1].close;
        if prev_close > 0.0 && (close / prev_close - 1.0) * 100.0 > TT_MAX_ENTRY_BAR_PCT {
            return Signal::hold().with_score(trend_score);
        }

        // 6) 海龟仓位单位：止损触发时的亏损 = risk_pct% 的可分配资金
        let size_pct = (self.cfg.risk_pct * 100.0 * close / (self.cfg.stop_atr * n_unit))
            .clamp(TT_MIN_SIZE_PCT, TT_MAX_SIZE_PCT);

        let ma_dist = (close / ma_trend - 1.0) * 100.0;
        let quality = (0.4 + (chase / 4.0).clamp(0.0, 0.2) + (ma_dist / 30.0).clamp(0.0, 0.3))
            .clamp(0.0, 1.0);

        self.tracked = true;
        self.entry_price = close;
        self.entry_n = n_unit;

        Signal::buy_percent(
            size_pct,
            format!(
                "海龟突破：{} 日新高 {prior_high:.2} → {close:.2}（+{chase:.1}%，\
                 MA200 上方 {ma_dist:.0}%，N={n_unit:.2} / {n_pct:.1}%，\
                 止损 {:.2}，仓位 {size_pct:.0}%）",
                self.cfg.entry_days,
                close - self.cfg.stop_atr * n_unit
            ),
        )
        .with_score((quality * 0.6 + trend_score * 0.4).clamp(0.0, 1.0))
    }
}
