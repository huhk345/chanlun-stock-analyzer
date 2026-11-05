//! 缠论突破·年线闸门 (cl-breakout-state).

use crate::chanlun;
use crate::strategy::{DayContext, ParamSpec, Params, Signal, Strategy};

use super::common::{sma_at, CL_WINDOW, GIVEBACK_KEEP, HUB_LOOKBACK, MAX_HUB_AMP};

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
