//! Momentum rotation score.

use crate::strategy::{DayContext, ParamSpec, Params, Signal, Strategy};

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
