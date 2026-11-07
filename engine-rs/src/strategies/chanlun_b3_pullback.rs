//! 缠论顺势三买（突破回踩）。

use crate::strategy::{DayContext, ParamSpec, Params, Signal, Strategy};

use super::chanlun_b3_common::{base_params, B3Core};

const B3_DESC: &str = "只做三买（突破中枢后回抽不回中枢），要求 EMA 多头排列的顺势环境；\
     突破幅度+回踩深度+回踩缩量+确认阳线四重约束；\
     卖点为结构止损（ATR 计价）/顶背驰/ATR 跟踪止盈，不设固定止盈；\
     仓位按「单笔风险预算 / 结构止损距离」占权益定仓（海龟式），不设单只上限，最小开仓仅作下限";

pub struct ChanlunB3Pullback {
    core: B3Core,
}

impl ChanlunB3Pullback {
    pub fn new(params: &Params) -> Self {
        Self {
            core: B3Core::new(params),
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
        B3_DESC
    }

    fn params(&self) -> Vec<ParamSpec> {
        base_params()
    }

    fn on_day(&mut self, ctx: &DayContext<'_>) -> Signal {
        self.core.on_day(ctx, None)
    }
}
