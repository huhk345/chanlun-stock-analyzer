//! RSI mean-reversion strategy.

use crate::strategy::{DayContext, ParamSpec, Params, Signal, Strategy};

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
