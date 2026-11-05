//! 缠论顺势突破·Alpha 门控。

use crate::data::Bar;
use crate::strategy::{DayContext, ParamSpec, Params, Signal, Strategy};

use super::chanlun_b3_common::{base_params, B3Core, EntryGate, Setup};
use super::common::{avg_amount_wan, highest_high, sma_at, weekly_trend_ok};

const ALPHA_DESC: &str = "在缠论三买之上叠加顺势 alpha 门控（默认层级 1：收盘站上 MA120 且 MA120 上行 SLOPE / \
     距 250 日高点 ≤20%（只买接近新高的突破）/ 突破段放量 ≥1.1x VMA）；\
     filter_level=2 再加池子广度 breadth_ma60≥0.4，=3 再加 NATR≤6%、20 日成交额≥2000 万、周线确认，=0 关闭；\
     卖点沿用三买的结构止损+顶背驰+ATR 跟踪";

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
}

impl EntryGate for AlphaGate {
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

pub struct ChanlunB3Alpha {
    core: B3Core,
    alpha: AlphaGate,
}

impl ChanlunB3Alpha {
    pub fn new(params: &Params) -> Self {
        Self {
            core: B3Core::new(params),
            alpha: AlphaGate::from_params(params),
        }
    }
}

impl Strategy for ChanlunB3Alpha {
    fn id(&self) -> &'static str {
        "cl-trend-breakout-alpha"
    }

    fn name(&self) -> &'static str {
        "缠论顺势突破·Alpha 门控"
    }

    fn description(&self) -> &'static str {
        ALPHA_DESC
    }

    fn params(&self) -> Vec<ParamSpec> {
        let mut out = base_params();
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
        self.core.on_day(ctx, Some(&self.alpha))
    }
}
