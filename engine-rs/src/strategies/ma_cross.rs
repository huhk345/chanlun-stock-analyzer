//! MA cross strategy.

use crate::strategy::{DayContext, ParamSpec, Params, Signal, Strategy};

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
