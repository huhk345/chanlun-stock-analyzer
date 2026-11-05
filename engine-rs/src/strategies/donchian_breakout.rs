//! Donchian channel breakout with trailing stop.

use crate::strategy::{DayContext, ParamSpec, Params, Signal, Strategy};

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
