//! Built-in strategies.
//!
//! Each registered strategy lives in its own module. Cross-strategy helpers live
//! in `common`; the two ChanLun B3 variants also share their reusable mechanics
//! through `chanlun_b3_common`, but neither strategy file is shared.

mod chanlun_b3_alpha;
mod chanlun_b3_common;
mod chanlun_b3_pullback;
mod chanlun_breakout_state;
mod common;
mod donchian_breakout;
mod ma_cross;
mod momentum;
mod rsi_reversion;
mod turtle_trend_breakout;

use crate::strategy::{ParamSpec, Params, Strategy};

use chanlun_b3_alpha::ChanlunB3Alpha;
use chanlun_b3_pullback::ChanlunB3Pullback;
use chanlun_breakout_state::ChanlunBreakoutState;
use donchian_breakout::DonchianBreakout;
use ma_cross::MaCross;
use momentum::Momentum;
use rsi_reversion::RsiReversion;
use turtle_trend_breakout::TurtleTrendBreakout;

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
        params: || ChanlunB3Alpha::new(&Params::new()).params(),
        build: |p| Box::new(ChanlunB3Alpha::new(p)),
    },
    StrategyMeta {
        id: "cl-breakout-state",
        name: "缠论突破·年线闸门",
        description: "站上上行年线 + N 日新高 + 放量 + 离开缠论中枢的力度; 仓位只有满仓/空仓两档; 离场只有年线失守与浮盈保护, 不设价格止损与固定止盈",
        params: || ChanlunBreakoutState::new(&Params::new()).params(),
        build: |p| Box::new(ChanlunBreakoutState::new(p)),
    },
    StrategyMeta {
        id: "turtle-trend-breakout",
        name: "海龟趋势突破·唐奇安通道",
        description: "唐奇安通道突破入场 + 反向唐奇安低点离场 + N(ATR20) 定仓位与固定止损; 只在上行年线上方做多, 突破日放量且不追高; 无固定止盈、不做金字塔加仓",
        params: || TurtleTrendBreakout::new(&Params::new()).params(),
        build: |p| Box::new(TurtleTrendBreakout::new(p)),
    },
];

pub fn build_strategy(id: &str, params: &Params) -> Option<Box<dyn Strategy>> {
    STRATEGIES
        .iter()
        .find(|m| m.id == id)
        .map(|m| (m.build)(params))
}
