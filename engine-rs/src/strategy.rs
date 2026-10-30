//! The strategy contract.
//!
//! One interface, engine-agnostic — this is the same shape the web app already
//! speaks (`BUY / SELL / HOLD` + `amount`), so a strategy written here reads
//! like a strategy written for the TypeScript engine:
//!
//! ```ignore
//! fn on_day(&mut self, ctx: &DayContext) -> Signal {
//!     if ctx.position.shares > 0.0 && ctx.today.close < ctx.sma(20) {
//!         return Signal::sell_percent(100.0, "跌破 MA20");
//!     }
//!     if ctx.today.close > ctx.highest(20) {
//!         return Signal::buy_percent(30.0, "创 20 日新高");
//!     }
//!     Signal::hold()
//! }
//! ```
//!
//! The framework feeds `ctx` — bars through today, the account and the position —
//! and the strategy answers with an intent. It never sees tomorrow's bar: `bars`
//! is a prefix ending at `ctx.date`.

use crate::data::Bar;
use chrono::NaiveDate;
use std::collections::BTreeMap;

// ---------------------------------------------------------------------------
// Signal
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Buy,
    Sell,
    Hold,
}

impl Action {
    pub fn as_str(self) -> &'static str {
        match self {
            Action::Buy => "BUY",
            Action::Sell => "SELL",
            Action::Hold => "HOLD",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AmountUnit {
    /// Spend / raise this much cash (CNY).
    Cash,
    /// Trade this many shares (rounded down to a 100-share lot).
    Shares,
    /// Percent of buying power (BUY) or of the position (SELL).
    Percent,
}

impl AmountUnit {
    pub fn as_str(self) -> &'static str {
        match self {
            AmountUnit::Cash => "cash",
            AmountUnit::Shares => "shares",
            AmountUnit::Percent => "percent",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Amount {
    pub unit: AmountUnit,
    pub value: f64,
}

#[derive(Debug, Clone)]
pub struct Signal {
    pub action: Action,
    pub amount: Option<Amount>,
    pub reason: Option<String>,
    /// Cross-sectional attractiveness (optional). Higher = more worth holding.
    pub score: Option<f64>,
}

impl Signal {
    pub fn hold() -> Self {
        Self {
            action: Action::Hold,
            amount: None,
            reason: None,
            score: None,
        }
    }

    pub fn buy(unit: AmountUnit, value: f64, reason: impl Into<String>) -> Self {
        Self {
            action: Action::Buy,
            amount: Some(Amount { unit, value }),
            reason: Some(reason.into()),
            score: None,
        }
    }

    pub fn sell(unit: AmountUnit, value: f64, reason: impl Into<String>) -> Self {
        Self {
            action: Action::Sell,
            amount: Some(Amount { unit, value }),
            reason: Some(reason.into()),
            score: None,
        }
    }

    pub fn buy_percent(value: f64, reason: impl Into<String>) -> Self {
        Self::buy(AmountUnit::Percent, value, reason)
    }

    pub fn sell_percent(value: f64, reason: impl Into<String>) -> Self {
        Self::sell(AmountUnit::Percent, value, reason)
    }

    pub fn buy_shares(value: f64, reason: impl Into<String>) -> Self {
        Self::buy(AmountUnit::Shares, value, reason)
    }

    pub fn sell_shares(value: f64, reason: impl Into<String>) -> Self {
        Self::sell(AmountUnit::Shares, value, reason)
    }

    pub fn with_score(mut self, score: f64) -> Self {
        self.score = Some(score);
        self
    }
}

// ---------------------------------------------------------------------------
// Read-only views handed to the strategy
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default)]
pub struct AccountView {
    pub initial_cash: f64,
    pub cash: f64,
    pub equity: f64,
    /// equity - initial_cash
    pub pnl: f64,
    pub pnl_percent: f64,
    /// Realised PnL booked so far.
    pub realized_pnl: f64,
    pub fees_paid: f64,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct PositionView {
    pub shares: f64,
    pub avg_cost: f64,
    pub market_value: f64,
    pub unrealized_pnl: f64,
    pub unrealized_pnl_percent: f64,
    /// Shares still locked by T+1 (bought today).
    pub sellable_shares: f64,
    pub holding_days: u32,
}

pub struct DayContext<'a> {
    pub date: NaiveDate,
    /// 0-based index into the run's trading calendar.
    pub day_index: usize,
    pub total_days: usize,
    pub symbol: &'a str,
    /// Every bar up to and including `date` — a strategy cannot see further.
    pub bars: &'a [Bar],
    pub account: AccountView,
    pub position: PositionView,
    pub params: &'a Params,
}

impl<'a> DayContext<'a> {
    pub fn today(&self) -> Bar {
        *self.bars.last().expect("bars is never empty")
    }

    pub fn close(&self) -> f64 {
        self.today().close
    }

    pub fn bar(&self, i: usize) -> Option<&Bar> {
        self.bars.get(i)
    }

    pub fn len(&self) -> usize {
        self.bars.len()
    }

    pub fn is_empty(&self) -> bool {
        self.bars.is_empty()
    }

    /// Simple moving average of the last `n` closes (None when too short).
    pub fn sma(&self, n: usize) -> Option<f64> {
        if n == 0 || self.bars.len() < n {
            return None;
        }
        let sum: f64 = self.bars[self.bars.len() - n..].iter().map(|b| b.close).sum();
        Some(sum / n as f64)
    }

    /// Highest close over the last `n` bars, excluding today.
    pub fn highest_close(&self, n: usize) -> Option<f64> {
        if self.bars.len() < n + 1 {
            return None;
        }
        let end = self.bars.len() - 1;
        self.bars[end - n..end]
            .iter()
            .map(|b| b.close)
            .fold(None, |acc: Option<f64>, c| Some(acc.map_or(c, |a| a.max(c))))
    }

    /// Lowest close over the last `n` bars, excluding today.
    pub fn lowest_close(&self, n: usize) -> Option<f64> {
        if self.bars.len() < n + 1 {
            return None;
        }
        let end = self.bars.len() - 1;
        self.bars[end - n..end]
            .iter()
            .map(|b| b.close)
            .fold(None, |acc: Option<f64>, c| Some(acc.map_or(c, |a| a.min(c))))
    }

    pub fn pct_change(&self, n: usize) -> Option<f64> {
        if self.bars.len() < n + 1 {
            return None;
        }
        let prev = self.bars[self.bars.len() - 1 - n].close;
        if prev <= 0.0 {
            return None;
        }
        Some((self.close() / prev - 1.0) * 100.0)
    }

    /// Wilder RSI over `n` bars.
    pub fn rsi(&self, n: usize) -> Option<f64> {
        if self.bars.len() < n + 1 {
            return None;
        }
        let window = &self.bars[self.bars.len() - 1 - n..];
        let mut gain = 0.0;
        let mut loss = 0.0;
        for w in window.windows(2) {
            let d = w[1].close - w[0].close;
            if d >= 0.0 {
                gain += d;
            } else {
                loss -= d;
            }
        }
        if loss == 0.0 {
            return Some(100.0);
        }
        let rs = gain / loss;
        Some(100.0 - 100.0 / (1.0 + rs))
    }

    pub fn param_f64(&self, key: &str, default: f64) -> f64 {
        self.params.f64(key, default)
    }

    pub fn param_usize(&self, key: &str, default: usize) -> usize {
        self.params.f64(key, default as f64).max(0.0) as usize
    }
}

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum ParamValue {
    Number(f64),
    Text(String),
    Bool(bool),
}

#[derive(Debug, Clone, Default)]
pub struct Params(pub BTreeMap<String, ParamValue>);

impl Params {
    pub fn new() -> Self {
        Self(BTreeMap::new())
    }

    pub fn from_json(value: Option<&serde_json::Value>) -> Self {
        let mut out = BTreeMap::new();
        if let Some(serde_json::Value::Object(map)) = value {
            for (k, v) in map {
                let parsed = match v {
                    serde_json::Value::Number(n) => n.as_f64().map(ParamValue::Number),
                    serde_json::Value::String(s) => Some(ParamValue::Text(s.clone())),
                    serde_json::Value::Bool(b) => Some(ParamValue::Bool(*b)),
                    _ => None,
                };
                if let Some(p) = parsed {
                    out.insert(k.clone(), p);
                }
            }
        }
        Self(out)
    }

    pub fn f64(&self, key: &str, default: f64) -> f64 {
        match self.0.get(key) {
            Some(ParamValue::Number(n)) => *n,
            Some(ParamValue::Text(s)) => s.parse().unwrap_or(default),
            _ => default,
        }
    }

    pub fn text<'a>(&'a self, key: &str, default: &'a str) -> &'a str {
        match self.0.get(key) {
            Some(ParamValue::Text(s)) => s.as_str(),
            _ => default,
        }
    }

    pub fn bool(&self, key: &str, default: bool) -> bool {
        match self.0.get(key) {
            Some(ParamValue::Bool(b)) => *b,
            Some(ParamValue::Number(n)) => *n != 0.0,
            _ => default,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ParamSpec {
    pub key: &'static str,
    pub label: &'static str,
    pub kind: &'static str, // number | string | boolean
    pub default: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<f64>,
}

impl ParamSpec {
    pub fn number(key: &'static str, label: &'static str, default: f64) -> Self {
        Self {
            key,
            label,
            kind: "number",
            default: serde_json::json!(default),
            min: None,
            max: None,
            step: None,
        }
    }

    pub fn with_range(mut self, min: f64, max: f64, step: f64) -> Self {
        self.min = Some(min);
        self.max = Some(max);
        self.step = Some(step);
        self
    }
}

// ---------------------------------------------------------------------------
// Strategy trait
// ---------------------------------------------------------------------------

pub trait Strategy: Send {
    fn id(&self) -> &'static str;
    fn name(&self) -> &'static str;
    fn description(&self) -> &'static str {
        ""
    }
    fn params(&self) -> Vec<ParamSpec> {
        Vec::new()
    }
    /// Called once per trading day, per instrument, with the position and
    /// account the framework has already settled up to today's close.
    fn on_day(&mut self, ctx: &DayContext<'_>) -> Signal;
}
