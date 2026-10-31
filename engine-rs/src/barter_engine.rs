//! barter-rs adapter: the framework drives the event loop, owns instrument state
//! and positions; this module only supplies the A-share data feed, the strategy
//! dispatch, and an execution layer that follows A-share rules.
//!
//! Why a custom execution layer instead of barter's `MockExchange`: the mock
//! fills every order at the requested price and settles in quote currency only
//! (a sell debits cash instead of crediting proceeds), so it cannot express
//! 100-share lots, T+1, price limits, commission, stamp duty or transfer fees.
//! barter is designed for pluggable execution, so we keep the engine and swap
//! the venue: orders go out through `MultiExchangeTxMap`, get filled by
//! [`AShareBroker`], and the fills are reported back as `AccountEvent`s —
//! exactly how a live venue reports them.

use crate::data::{Bar, Market, RegimePoint};
use crate::metrics::{build_metrics, Metrics};
use crate::strategy::{
    AccountView, Action, AmountUnit, DayContext, Params, PositionView, Signal, Strategy,
};
use barter::{
    EngineEvent,
    engine::{
        Engine, Processor,
        clock::HistoricalClock,
        execution_tx::MultiExchangeTxMap,
        state::{
            EngineState,
            builder::EngineStateBuilder,
            instrument::data::InstrumentDataState,
            order::in_flight_recorder::InFlightRequestRecorder,
            trading::TradingState,
        },
    },
    execution::{AccountStreamEvent, request::ExecutionRequest},
    risk::DefaultRiskManager,
    strategy::{
        algo::AlgoStrategy,
        close_positions::ClosePositionsStrategy,
        on_disconnect::OnDisconnectStrategy,
        on_trading_disabled::OnTradingDisabled,
    },
};
use barter_data::{
    event::MarketEvent, streams::consumer::MarketStreamEvent, subscription::candle::Candle,
};
use barter_execution::{
    AccountEvent, AccountEventKind,
    order::{
        OrderKey, OrderKind, TimeInForce,
        id::{ClientOrderId, OrderId, StrategyId},
        request::{OrderRequestCancel, OrderRequestOpen, RequestOpen},
    },
    trade::{AssetFees, Trade, TradeId},
};
use barter_instrument::{
    Side, Underlying,
    asset::{Asset, QuoteAsset},
    exchange::{ExchangeId, ExchangeIndex},
    index::IndexedInstruments,
    instrument::{Instrument, InstrumentIndex},
};
use barter_integration::channel::{Channel, UnboundedTx};
use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use rust_decimal::Decimal;
use rust_decimal::prelude::{FromPrimitive, ToPrimitive};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

pub const FRAMEWORK: &str = "barter-rs 0.14.0";

/// A-share session close in UTC (15:00 Asia/Shanghai).
/// Round for transport: keeps the payload compact without losing cents.
pub fn r4(v: f64) -> f64 {
    if !v.is_finite() {
        return 0.0;
    }
    (v * 10_000.0).round() / 10_000.0
}

fn close_ts(date: NaiveDate) -> DateTime<Utc> {
    Utc.from_utc_datetime(&date.and_hms_opt(7, 0, 0).expect("valid time"))
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct SimConfig {
    pub initial_cash: f64,
    pub commission_rate: f64,
    pub min_commission: f64,
    pub stamp_duty_rate: f64,
    pub transfer_fee_rate: f64,
    pub lot_size: f64,
    /// Hard floor on a newly opened position (CNY). 0 disables the rule.
    pub min_position_value: f64,
    pub t_plus_1: bool,
    pub stop_loss_percent: Option<f64>,
}

impl Default for SimConfig {
    fn default() -> Self {
        Self {
            initial_cash: 100_000.0,
            commission_rate: 0.00025,
            min_commission: 5.0,
            stamp_duty_rate: 0.0005,
            transfer_fee_rate: 0.00001,
            lot_size: 100.0,
            min_position_value: 5_000.0,
            t_plus_1: true,
            stop_loss_percent: None,
        }
    }
}

/// Daily price limit by board: main 10%, ChiNext/STAR 20%, BSE 30%.
fn price_limit_ratio(symbol: &str) -> f64 {
    let code = symbol.split('.').next().unwrap_or(symbol);
    if code.starts_with("688") || code.starts_with("300") || code.starts_with("301") {
        0.20
    } else if code.starts_with('8') || code.starts_with('4') {
        0.30
    } else {
        0.10
    }
}

// ---------------------------------------------------------------------------
// Ledger — barter `GlobalData`: cash / positions / realised PnL
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct LedgerPosition {
    pub shares: f64,
    pub avg_cost: f64,
    pub cost_basis: f64,
    pub opened_on: Option<NaiveDate>,
}

#[derive(Debug, Clone)]
pub struct Ledger {
    pub initial_cash: f64,
    pub cash: f64,
    pub realized: f64,
    pub fees: f64,
    pub positions: HashMap<InstrumentIndex, LedgerPosition>,
    pub closed_pnls: Vec<f64>,
    pub last_price: HashMap<InstrumentIndex, f64>,
    pub days_in_market: usize,
}

impl Default for Ledger {
    fn default() -> Self {
        Self {
            initial_cash: 0.0,
            cash: 0.0,
            realized: 0.0,
            fees: 0.0,
            positions: HashMap::new(),
            closed_pnls: Vec::new(),
            last_price: HashMap::new(),
            days_in_market: 0,
        }
    }
}

impl Ledger {
    pub fn new(initial_cash: f64) -> Self {
        Self {
            initial_cash,
            cash: initial_cash,
            ..Default::default()
        }
    }

    pub fn position_value(&self) -> f64 {
        self.positions
            .iter()
            .map(|(idx, p)| {
                p.shares * self.last_price.get(idx).copied().unwrap_or(p.avg_cost)
            })
            .sum()
    }

    pub fn equity(&self) -> f64 {
        self.cash + self.position_value()
    }

    pub fn shares_of(&self, idx: &InstrumentIndex) -> f64 {
        self.positions.get(idx).map(|p| p.shares).unwrap_or(0.0)
    }

    /// Book a fill into the position ledger + realised PnL. Cash is moved by the
    /// `AccountEvent` processor below, so it is not touched here.
    pub fn apply_fill(
        &mut self,
        instrument: InstrumentIndex,
        side: Side,
        price: f64,
        shares: f64,
        fee: f64,
        date: NaiveDate,
    ) {
        let value = price * shares;
        self.fees += fee;
        match side {
            Side::Buy => {
                let entry = self.positions.entry(instrument).or_default();
                if entry.shares <= 0.0 {
                    entry.opened_on = Some(date);
                    entry.cost_basis = 0.0;
                }
                entry.cost_basis += value + fee;
                entry.shares += shares;
                entry.avg_cost = entry.cost_basis / entry.shares;
            }
            Side::Sell => {
                if let Some(entry) = self.positions.get_mut(&instrument) {
                    let avg = entry.avg_cost;
                    let closed_shares = shares.min(entry.shares);
                    let pnl = (price - avg) * closed_shares - fee;
                    self.realized += pnl;
                    self.closed_pnls.push(pnl);
                    entry.shares -= shares;
                    entry.cost_basis = (entry.cost_basis - avg * shares).max(0.0);
                    if entry.shares <= 1e-9 {
                        entry.shares = 0.0;
                        entry.avg_cost = 0.0;
                        entry.cost_basis = 0.0;
                    }
                }
            }
        }
    }
}

impl Processor<&MarketEvent<InstrumentIndex, Candle>> for Ledger {
    type Audit = ();

    fn process(&mut self, event: &MarketEvent<InstrumentIndex, Candle>) -> Self::Audit {
        self.last_price.insert(event.instrument, event.kind.close);
    }
}

impl Processor<&AccountEvent> for Ledger {
    type Audit = ();

    fn process(&mut self, event: &AccountEvent) -> Self::Audit {
        if let AccountEventKind::Trade(trade) = &event.kind {
            let price = trade.price.to_f64().unwrap_or_default();
            let shares = trade.quantity.to_f64().unwrap_or_default().abs();
            let fee = trade.fees.fees.to_f64().unwrap_or_default();
            match trade.side {
                Side::Buy => self.cash -= price * shares + fee,
                Side::Sell => self.cash += price * shares - fee,
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Instrument data — the bars the framework hands to the strategy
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct BarState {
    pub bars: Vec<Bar>,
}

impl BarState {
    pub fn last(&self) -> Option<&Bar> {
        self.bars.last()
    }
}

impl InstrumentDataState for BarState {
    type MarketEventKind = Candle;

    fn price(&self) -> Option<Decimal> {
        self.bars.last().and_then(|b| Decimal::from_f64(b.close))
    }
}

impl Processor<&MarketEvent<InstrumentIndex, Candle>> for BarState {
    type Audit = ();

    fn process(&mut self, event: &MarketEvent<InstrumentIndex, Candle>) -> Self::Audit {
        let c = event.kind;
        self.bars.push(Bar {
            date: event.time_exchange.date_naive(),
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
            amount: 0.0,
        });
    }
}

impl Processor<&AccountEvent> for BarState {
    type Audit = ();

    fn process(&mut self, _: &AccountEvent) -> Self::Audit {}
}

impl InFlightRequestRecorder<ExchangeIndex, InstrumentIndex> for BarState {
    fn record_in_flight_cancel(&mut self, _: &OrderRequestCancel<ExchangeIndex, InstrumentIndex>) {}
    fn record_in_flight_open(&mut self, _: &OrderRequestOpen<ExchangeIndex, InstrumentIndex>) {}
}

// ---------------------------------------------------------------------------
// Recording types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct DecisionRow {
    pub symbol: String,
    pub action: String,
    pub amount_unit: Option<String>,
    pub amount_value: Option<f64>,
    pub reason: Option<String>,
    pub close: f64,
    pub score: Option<f64>,
    pub filled_shares: f64,
    pub fill_price: Option<f64>,
    pub fee: f64,
    pub rejected: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TradeRow {
    pub date: String,
    pub symbol: String,
    pub action: String,
    pub price: f64,
    pub shares: f64,
    pub value: f64,
    pub fee: f64,
    pub pnl: Option<f64>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DayRow {
    pub index: usize,
    pub date: String,
    pub equity: f64,
    pub cash: f64,
    pub position_value: f64,
    pub positions: usize,
    pub evaluated: usize,
    pub buys: usize,
    pub sells: usize,
    pub holds: usize,
    pub trades: usize,
    pub decisions: Vec<DecisionRow>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SymbolRow {
    pub symbol: String,
    pub buy_hold_percent: f64,
    pub realized_pnl: f64,
    pub trades: usize,
    pub win_rate: f64,
    pub max_drawdown: f64,
    pub fees: f64,
    pub last_close: f64,
    pub days: usize,
    /// Quantity barter's own `PositionManager` reports at the end of the run.
    pub framework_shares: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SimOutput {
    pub run_id: String,
    pub framework: String,
    pub strategy_id: String,
    pub strategy_name: String,
    pub pools: Vec<String>,
    pub start: String,
    pub end: String,
    pub universe: usize,
    /// Names this capital can hold at a typical lot cost (equal-weight slots).
    pub max_positions: usize,
    /// Per-name capital ceiling implied by `max_positions`.
    pub slot_cash: f64,
    /// Hard floor applied to every newly opened position (0 = disabled).
    pub min_position_value: f64,
    pub tested: usize,
    pub missing: Vec<String>,
    pub metrics: Metrics,
    pub equity: Vec<f64>,
    pub bh_equity: Vec<f64>,
    pub equity_dates: Vec<String>,
    pub days: Vec<DayRow>,
    pub trades: Vec<TradeRow>,
    pub symbols: Vec<SymbolRow>,
    pub elapsed_ms: u64,
    /// What the automatic pre-run data refresh did (absent when disabled).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh: Option<crate::update::AutoRefreshReport>,
}

// ---------------------------------------------------------------------------
// Strategy adapter: barter `AlgoStrategy` -> our `Strategy::on_day`
// ---------------------------------------------------------------------------

pub struct PoolStrategy {
    ids: Vec<String>,
    strategies: Mutex<Vec<Box<dyn Strategy>>>,
    decisions: Arc<Mutex<Vec<DecisionRow>>>,
    /// Instrument whose bar was just processed (set by the run loop right before
    /// `Engine::process`, so the strategy only evaluates the ticking symbol).
    current: Mutex<Option<usize>>,
    cfg: SimConfig,
    strategy_id: String,
    slot_cash: f64,
    /// How many names this capital can hold at a typical lot cost.
    max_positions: usize,
    /// Runtime parameters, handed to every `DayContext` so a strategy can read
    /// `ctx.params` instead of baking them in at construction.
    params: Params,
    /// 池子级市场状态，按交易日对齐；run 循环每天把游标推到当天。
    regime: Vec<RegimePoint>,
    current_day: Mutex<usize>,
}

impl PoolStrategy {
    fn new(
        market: &Market,
        strategy_id: &str,
        params: &Params,
        cfg: SimConfig,
    ) -> (Self, Arc<Mutex<Vec<DecisionRow>>>) {
        let ids: Vec<String> = market.series.keys().cloned().collect();
        let strategies = ids
            .iter()
            .map(|_| {
                crate::strategies::build_strategy(strategy_id, params)
                    .expect("validated strategy id")
            })
            .collect::<Vec<_>>();
        let decisions = Arc::new(Mutex::new(Vec::new()));

        // Equal weight across the *whole* universe only works when one lot fits
        // the slot. 2万 over 300 names gives a ¥67 slot while a lot costs ~¥1,200,
        // so every signal would be sized to zero. Size the slot from what the
        // capital can actually hold instead: how many names fit at a typical lot
        // cost, capped by the universe.
        let universe = ids.len().max(1);
        let typical_lot = typical_lot_cost(market, cfg.lot_size);
        let by_lot = if typical_lot > 0.0 {
            (cfg.initial_cash / (typical_lot * 1.05)).floor() as usize
        } else {
            universe
        };
        // A slot below the minimum position value could never be opened, so the
        // floor also caps how many names the plan may spread across.
        let by_floor = if cfg.min_position_value > 0.0 {
            (cfg.initial_cash / cfg.min_position_value).floor() as usize
        } else {
            universe
        };
        let max_positions = by_lot.min(by_floor).clamp(1, universe);
        let slot_cash = cfg.initial_cash / max_positions as f64;
        (
            Self {
                ids,
                strategies: Mutex::new(strategies),
                decisions: Arc::clone(&decisions),
                current: Mutex::new(None),
                cfg,
                strategy_id: strategy_id.to_string(),
                slot_cash,
                max_positions,
                params: params.clone(),
                regime: market.regime.clone(),
                current_day: Mutex::new(0),
            },
            decisions,
        )
    }

    fn set_current(&self, index: Option<usize>) {
        *self.current.lock().unwrap() = index;
    }

    fn set_day(&self, index: usize) {
        *self.current_day.lock().unwrap() = index;
    }
}

impl AlgoStrategy for PoolStrategy {
    type State = EngineState<Ledger, BarState>;

    fn generate_algo_orders(
        &self,
        state: &Self::State,
    ) -> (
        impl IntoIterator<Item = OrderRequestCancel<ExchangeIndex, InstrumentIndex>>,
        impl IntoIterator<Item = OrderRequestOpen<ExchangeIndex, InstrumentIndex>>,
    ) {
        let mut opens: Vec<OrderRequestOpen<ExchangeIndex, InstrumentIndex>> = Vec::new();

        let Some(i) = *self.current.lock().unwrap() else {
            return (Vec::new(), opens);
        };
        let idx = InstrumentIndex(i);
        let Some(symbol) = self.ids.get(i) else {
            return (Vec::new(), opens);
        };
        if i >= state.instruments.0.len() {
            return (Vec::new(), opens);
        }
        let istate = state.instruments.instrument_index(&idx);
        let Some(today) = istate.data.last().copied() else {
            return (Vec::new(), opens);
        };

        let position = state.global.positions.get(&idx).cloned().unwrap_or_default();
        let equity = state.global.equity();
        let market_value = position.shares
            * state
                .global
                .last_price
                .get(&idx)
                .copied()
                .unwrap_or(today.close);

        let day = *self.current_day.lock().unwrap();
        let regime = self.regime.get(day).copied().unwrap_or_default();
        let ctx = DayContext {
            date: today.date,
            day_index: day,
            total_days: self.regime.len(),
            symbol,
            bars: &istate.data.bars,
            account: AccountView {
                initial_cash: state.global.initial_cash,
                cash: state.global.cash,
                equity,
                pnl: equity - state.global.initial_cash,
                pnl_percent: if state.global.initial_cash > 0.0 {
                    (equity / state.global.initial_cash - 1.0) * 100.0
                } else {
                    0.0
                },
                realized_pnl: state.global.realized,
                fees_paid: state.global.fees,
            },
            position: PositionView {
                shares: position.shares,
                avg_cost: position.avg_cost,
                market_value,
                unrealized_pnl: market_value - position.cost_basis,
                unrealized_pnl_percent: if position.cost_basis > 0.0 {
                    (market_value / position.cost_basis - 1.0) * 100.0
                } else {
                    0.0
                },
                sellable_shares: position.shares,
                holding_days: 0,
            },
            params: &self.params,
            regime,
        };

        let mut strategies = self.strategies.lock().unwrap();
        let mut signal = strategies[i].on_day(&ctx);
        drop(strategies);

        // Engine-level fixed stop-loss, applied on top of any strategy.
        if let Some(stop) = self.cfg.stop_loss_percent {
            if position.shares > 0.0 && position.avg_cost > 0.0 {
                let dd = (today.close / position.avg_cost - 1.0) * 100.0;
                if dd <= -stop {
                    signal = Signal::sell_percent(100.0, format!("固定止损 {dd:.1}%"));
                }
            }
        }

        let close = today.close;
        let mut buy_reject: Option<String> = None;
        let quantity = match signal.action {
            Action::Buy => {
                // Equal-weight slot: each pool member may hold at most its share
                // of the capital, so one symbol cannot eat the whole account.
                let requested = match signal.amount {
                    Some(a) => match a.unit {
                        AmountUnit::Percent => self.slot_cash * a.value / 100.0,
                        AmountUnit::Cash => a.value.min(self.slot_cash),
                        AmountUnit::Shares => a.value * close,
                    },
                    None => 0.0,
                };
                let lot = self.cfg.lot_size;
                let floor_value = self.cfg.min_position_value.max(0.0);
                let cash = state.global.cash;

                // Hard rule: a new position is never smaller than `floor_value`.
                // The strategy's own sizing is a *target*, so raise it to the
                // floor, then round to a whole lot — rounding down could drop the
                // order back under the floor, so round up one lot instead.
                let target_cash = requested.max(floor_value).min(cash);
                let mut shares = floor_lot(target_cash / close, lot);
                if shares * close < floor_value {
                    shares += lot;
                }
                let value = shares * close;

                if shares <= 0.0 || !close.is_finite() || close <= 0.0 {
                    buy_reject = Some("无法定价".to_string());
                    0.0
                } else if value > cash + 1e-9 {
                    buy_reject = Some(format!(
                        "现金不足 (可用 {:.0} 元, 需 {:.0} 元)",
                        cash, value
                    ));
                    0.0
                } else if value > self.slot_cash * 1.5 + 1e-9 {
                    // One lot alone blows past the slot — this name cannot be held
                    // under the equal-weight plan at this capital level.
                    buy_reject = Some(format!(
                        "一手 {:.0} 元 超出仓位上限 {:.0} 元",
                        value, self.slot_cash
                    ));
                    0.0
                } else {
                    shares
                }
            }
            Action::Sell => {
                let target = match signal.amount {
                    Some(a) => match a.unit {
                        AmountUnit::Percent => position.shares * a.value / 100.0,
                        AmountUnit::Shares => a.value,
                        AmountUnit::Cash => a.value / close,
                    },
                    None => position.shares,
                };
                let lots = floor_lot(target, self.cfg.lot_size);
                // Closing the whole position may leave an odd lot behind.
                if position.shares > 0.0 && (position.shares - lots).abs() < self.cfg.lot_size {
                    position.shares
                } else {
                    lots
                }
            }
            Action::Hold => 0.0,
        };

        // HOLD days are counted, not stored: 800 symbols x 900 days of "HOLD"
        // rows would bloat the timeline for no information.
        if signal.action == Action::Hold {
            return (Vec::new(), opens);
        }

        // A signal that cannot be sized is still worth recording: it explains why
        // a BUY arrow produced no fill (usually the equal-weight slot is smaller
        // than one 100-share lot).
        let lot_cost = close * self.cfg.lot_size;
        let size_reject = if let Some(reason) = buy_reject {
            Some(reason)
        } else if quantity > 0.0 && close > 0.0 {
            None
        } else if signal.action == Action::Buy {
            // Distinguish "one lot does not fit the slot" from "cash is spent" —
            // they are different problems and only one of them is about capital.
            if lot_cost > self.slot_cash {
                Some(format!(
                    "仓位不足一手 (每只上限 {:.0} 元, 一手需 {:.0} 元)",
                    self.slot_cash, lot_cost
                ))
            } else {
                Some(format!(
                    "现金不足 (可用 {:.0} 元, 一手需 {:.0} 元)",
                    state.global.cash, lot_cost
                ))
            }
        } else {
            Some("无可卖数量".to_string())
        };

        self.decisions.lock().unwrap().push(DecisionRow {
            symbol: symbol.clone(),
            action: signal.action.as_str().to_string(),
            amount_unit: signal.amount.map(|a| a.unit.as_str().to_string()),
            amount_value: signal.amount.map(|a| a.value),
            reason: signal.reason.clone(),
            close: r4(close),
            score: signal.score.map(r4),
            filled_shares: 0.0,
            fill_price: None,
            fee: 0.0,
            rejected: size_reject,
        });

        if quantity > 0.0 && close > 0.0 {
            let side = if signal.action == Action::Buy {
                Side::Buy
            } else {
                Side::Sell
            };
            opens.push(OrderRequestOpen {
                key: OrderKey {
                    exchange: ExchangeIndex(0),
                    instrument: idx,
                    strategy: StrategyId::new(&self.strategy_id),
                    cid: ClientOrderId::random(),
                },
                state: RequestOpen {
                    side,
                    price: Decimal::from_f64(close).unwrap_or_default(),
                    quantity: Decimal::from_f64(quantity).unwrap_or_default(),
                    kind: OrderKind::Market,
                    time_in_force: TimeInForce::ImmediateOrCancel,
                },
            });
        }

        (Vec::new(), opens)
    }
}

impl ClosePositionsStrategy for PoolStrategy {
    type State = EngineState<Ledger, BarState>;

    fn close_positions_requests<'a>(
        &'a self,
        _state: &'a Self::State,
        _filter: &'a barter::engine::state::instrument::filter::InstrumentFilter,
    ) -> (
        impl IntoIterator<Item = OrderRequestCancel<ExchangeIndex, InstrumentIndex>> + 'a,
        impl IntoIterator<Item = OrderRequestOpen<ExchangeIndex, InstrumentIndex>> + 'a,
    )
    where
        barter_instrument::asset::AssetIndex: 'a,
    {
        (
            std::iter::empty(),
            std::iter::empty::<OrderRequestOpen<ExchangeIndex, InstrumentIndex>>(),
        )
    }
}

impl<Clock, State, ExecutionTxs, Risk> OnDisconnectStrategy<Clock, State, ExecutionTxs, Risk>
    for PoolStrategy
{
    type OnDisconnect = ();

    fn on_disconnect(
        _: &mut Engine<Clock, State, ExecutionTxs, Self, Risk>,
        _: ExchangeId,
    ) -> Self::OnDisconnect {
    }
}

impl<Clock, State, ExecutionTxs, Risk> OnTradingDisabled<Clock, State, ExecutionTxs, Risk>
    for PoolStrategy
{
    type OnTradingDisabled = ();

    fn on_trading_disabled(
        _: &mut Engine<Clock, State, ExecutionTxs, Self, Risk>,
    ) -> Self::OnTradingDisabled {
    }
}

/// Median cost of one lot across the pool, using each symbol's median close so a
/// single spiky price cannot skew the plan.
fn typical_lot_cost(market: &Market, lot: f64) -> f64 {
    let mut per_symbol: Vec<f64> = Vec::with_capacity(market.series.len());
    for series in market.series.values() {
        if series.bars.is_empty() {
            continue;
        }
        let mut closes: Vec<f64> = series.bars.iter().map(|b| b.close).collect();
        closes.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        per_symbol.push(closes[closes.len() / 2] * lot);
    }
    if per_symbol.is_empty() {
        return 0.0;
    }
    per_symbol.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    per_symbol[per_symbol.len() / 2]
}

fn floor_lot(quantity: f64, lot: f64) -> f64 {
    if lot <= 0.0 || !quantity.is_finite() || quantity <= 0.0 {
        return 0.0;
    }
    (quantity / lot).floor() * lot
}

// ---------------------------------------------------------------------------
// A-share execution
// ---------------------------------------------------------------------------

struct AShareBroker {
    cfg: SimConfig,
    bought_today: HashMap<usize, f64>,
    prev_close: HashMap<usize, f64>,
}

struct Fill {
    price: f64,
    shares: f64,
    value: f64,
    fee: f64,
}

impl AShareBroker {
    fn new(cfg: SimConfig) -> Self {
        Self {
            cfg,
            bought_today: HashMap::new(),
            prev_close: HashMap::new(),
        }
    }

    fn fees(&self, side: Side, value: f64) -> f64 {
        let commission = (value * self.cfg.commission_rate).max(self.cfg.min_commission);
        let transfer = value * self.cfg.transfer_fee_rate;
        let stamp = if side == Side::Sell {
            value * self.cfg.stamp_duty_rate
        } else {
            0.0
        };
        commission + transfer + stamp
    }

    /// Fill `requested` shares at the bar close, enforcing A-share rules.
    fn fill(
        &mut self,
        instrument: InstrumentIndex,
        side: Side,
        requested: f64,
        bar: &Bar,
        symbol: &str,
        cash: f64,
        held: f64,
    ) -> Result<Fill, String> {
        let price = bar.close;
        if !(price.is_finite() && price > 0.0) {
            return Err("无效收盘价".into());
        }

        if let Some(prev) = self.prev_close.get(&instrument.0).copied() {
            if prev > 0.0 {
                let ratio = price_limit_ratio(symbol);
                if side == Side::Buy && price >= prev * (1.0 + ratio) - 1e-9 {
                    return Err("涨停无法买入".into());
                }
                if side == Side::Sell && price <= prev * (1.0 - ratio) + 1e-9 {
                    return Err("跌停无法卖出".into());
                }
            }
        }

        let mut shares = requested;

        if side == Side::Sell && self.cfg.t_plus_1 {
            let locked = self.bought_today.get(&instrument.0).copied().unwrap_or(0.0);
            shares = shares.min((held - locked).max(0.0));
            if shares <= 0.0 {
                return Err("T+1 当日买入不可卖出".into());
            }
        }

        if side == Side::Buy {
            let mut affordable = floor_lot(
                cash / (price * (1.0 + self.cfg.commission_rate + self.cfg.transfer_fee_rate)),
                self.cfg.lot_size,
            );
            while affordable > 0.0 {
                let value = affordable * price;
                if value + self.fees(Side::Buy, value) <= cash + 1e-9 {
                    break;
                }
                affordable -= self.cfg.lot_size;
            }
            shares = shares.min(affordable);
            if shares <= 0.0 {
                return Err("现金不足".into());
            }
            // Shrinking to fit available cash must not slip under the position
            // floor — reject the entry instead of opening a runt position.
            let value = shares * price;
            if self.cfg.min_position_value > 0.0 && value < self.cfg.min_position_value - 1e-9 {
                return Err(format!(
                    "开仓金额 {:.0} 元 低于下限 {:.0} 元 (现金不足)",
                    value, self.cfg.min_position_value
                ));
            }
        } else {
            shares = shares.min(held);
            if shares <= 0.0 {
                return Err("无持仓".into());
            }
        }

        let value = shares * price;
        let fee = self.fees(side, value);
        if side == Side::Buy {
            *self.bought_today.entry(instrument.0).or_insert(0.0) += shares;
        }

        Ok(Fill {
            price,
            shares,
            value,
            fee,
        })
    }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

pub struct RunRequest<'a> {
    pub market: &'a Market,
    pub strategy_id: &'a str,
    pub params: Params,
    pub config: SimConfig,
    pub pools: Vec<String>,
    pub run_id: String,
}

pub fn run(req: RunRequest<'_>) -> Result<SimOutput, String> {
    let started = Instant::now();
    let market = req.market;
    let cfg = req.config.clone();

    let meta = crate::strategies::STRATEGIES
        .iter()
        .find(|m| m.id == req.strategy_id)
        .ok_or_else(|| format!("unknown strategy: {}", req.strategy_id))?;

    let symbols: Vec<String> = market.series.keys().cloned().collect();
    if symbols.is_empty() {
        return Err("empty universe".into());
    }
    let first_date = *market.dates.first().ok_or("empty calendar")?;

    // --- instruments: one spot instrument per pool member, quoted in CNY ----
    let instruments: Vec<Instrument<ExchangeId, Asset>> = symbols
        .iter()
        .map(|symbol| {
            Instrument::spot(
                ExchangeId::Mock,
                symbol.clone(),
                symbol.clone(),
                Underlying::new(Asset::from(symbol.clone()), Asset::from("CNY")),
                None,
            )
        })
        .collect();
    let indexed = IndexedInstruments::new(instruments);

    // --- engine state -----------------------------------------------------
    let state: EngineState<Ledger, BarState> = EngineStateBuilder::new(
        &indexed,
        Ledger::new(cfg.initial_cash),
        |_| BarState::default(),
    )
    .time_engine_start(close_ts(first_date))
    .trading_state(TradingState::Enabled)
    .build();

    // --- execution: orders are captured, then filled by the A-share broker --
    let mut channel = Channel::<ExecutionRequest>::new();
    let execution_txs: MultiExchangeTxMap<UnboundedTx<ExecutionRequest>> =
        [(ExchangeId::Mock, Some(channel.tx.clone()))]
            .into_iter()
            .collect();

    let (strategy, decisions) = PoolStrategy::new(market, req.strategy_id, &req.params, cfg.clone());
    let clock = HistoricalClock::new(close_ts(first_date));

    let mut engine: Engine<
        HistoricalClock,
        EngineState<Ledger, BarState>,
        MultiExchangeTxMap<UnboundedTx<ExecutionRequest>>,
        PoolStrategy,
        DefaultRiskManager<EngineState<Ledger, BarState>>,
    > = Engine::new(clock, state, execution_txs, strategy, DefaultRiskManager::default());

    let mut broker = AShareBroker::new(cfg.clone());

    let mut days: Vec<DayRow> = Vec::with_capacity(market.dates.len());
    let mut trades: Vec<TradeRow> = Vec::new();
    let mut equity: Vec<f64> = Vec::with_capacity(market.dates.len());
    let mut equity_dates: Vec<String> = Vec::with_capacity(market.dates.len());
    let mut bh_curve: Vec<f64> = Vec::with_capacity(market.dates.len());
    let mut symbol_bh: HashMap<usize, Vec<f64>> = HashMap::new();
    let mut symbol_trades: HashMap<usize, usize> = HashMap::new();
    let mut symbol_fees: HashMap<usize, f64> = HashMap::new();
    let mut symbol_pnl: HashMap<usize, f64> = HashMap::new();
    let mut symbol_closed: HashMap<usize, Vec<f64>> = HashMap::new();
    let mut symbol_first: HashMap<usize, f64> = HashMap::new();
    let mut symbol_last: HashMap<usize, f64> = HashMap::new();
    let mut decision_cursor = 0usize;

    for (day_index, date) in market.dates.iter().copied().enumerate() {
        engine.strategy.set_day(day_index);
        broker.bought_today.clear();
        let mut evaluated = 0usize;
        let mut day_trades = 0usize;

        for (i, symbol) in symbols.iter().enumerate() {
            let series = &market.series[symbol];
            let Some(bar) = series.bar_on(date).copied() else {
                continue;
            };
            evaluated += 1;

            if let Some(prev) = series.bars.iter().rev().find(|b| b.date < date) {
                broker.prev_close.insert(i, prev.close);
            }
            symbol_first.entry(i).or_insert(bar.close);
            symbol_last.insert(i, bar.close);

            // 1. The framework consumes the bar: BarState appends it, the position
            //    is marked, and the strategy is asked for orders which are routed
            //    to the execution layer.
            let event = MarketEvent {
                time_exchange: close_ts(date),
                time_received: close_ts(date),
                exchange: ExchangeId::Mock,
                instrument: InstrumentIndex(i),
                kind: Candle {
                    close_time: close_ts(date),
                    open: bar.open,
                    high: bar.high,
                    low: bar.low,
                    close: bar.close,
                    volume: bar.volume,
                    trade_count: 0,
                },
            };
            engine.strategy.set_current(Some(i));
            engine.process(EngineEvent::Market(MarketStreamEvent::Item(event)));
            engine.strategy.set_current(None);

            // 2. Drain the orders the engine routed to the (simulated) venue.
            let mut requests = Vec::new();
            while let Ok(request) = channel.rx.rx.try_recv() {
                requests.push(request);
            }

            // 3. Fill under A-share rules and report each fill back to the engine.
            for request in requests {
                let ExecutionRequest::Open(order) = request else {
                    continue;
                };
                let instrument = order.key.instrument;
                let side = order.state.side;
                let requested = order.state.quantity.to_f64().unwrap_or(0.0);
                let held = engine.state.global.shares_of(&instrument);

                match broker.fill(
                    instrument,
                    side,
                    requested,
                    &bar,
                    symbol,
                    engine.state.global.cash,
                    held,
                ) {
                    Ok(fill) => {
                        engine.state.global.apply_fill(
                            instrument,
                            side,
                            fill.price,
                            fill.shares,
                            fill.fee,
                            date,
                        );
                        *symbol_fees.entry(i).or_insert(0.0) += fill.fee;
                        *symbol_trades.entry(i).or_insert(0) += 1;
                        if side == Side::Sell {
                            if let Some(pnl) = engine.state.global.closed_pnls.last().copied() {
                                *symbol_pnl.entry(i).or_insert(0.0) += pnl;
                                symbol_closed.entry(i).or_default().push(pnl);
                            }
                        }

                        let trade = Trade {
                            id: TradeId::new(format!("{symbol}-{date}")),
                            order_id: OrderId::new(order.key.cid.0.clone()),
                            instrument,
                            strategy: StrategyId::new(req.strategy_id),
                            time_exchange: close_ts(date),
                            side,
                            price: Decimal::from_f64(fill.price).unwrap_or_default(),
                            quantity: Decimal::from_f64(fill.shares).unwrap_or_default(),
                            fees: AssetFees {
                                asset: QuoteAsset,
                                fees: Decimal::from_f64(fill.fee).unwrap_or_default(),
                            },
                        };
                        engine.process(EngineEvent::Account(AccountStreamEvent::Item(
                            AccountEvent::new(ExchangeIndex(0), AccountEventKind::Trade(trade)),
                        )));

                        day_trades += 1;
                        mark_decision(
                            &decisions,
                            symbol,
                            fill.shares,
                            fill.price,
                            fill.fee,
                            None,
                        );
                        trades.push(TradeRow {
                            date: date.format("%Y-%m-%d").to_string(),
                            symbol: symbol.clone(),
                            action: if side == Side::Buy { "BUY" } else { "SELL" }.to_string(),
                            price: r4(fill.price),
                            shares: r4(fill.shares),
                            value: r4(fill.value),
                            fee: r4(fill.fee),
                            pnl: None,
                            reason: None,
                        });
                    }
                    Err(reason) => {
                        mark_decision(&decisions, symbol, 0.0, 0.0, 0.0, Some(reason));
                    }
                }
            }
        }

        // Mark-to-market: every held instrument is priced off today's close.
        for (i, symbol) in symbols.iter().enumerate() {
            if let Some(bar) = market.series[symbol].bar_on(date) {
                engine.state.global.last_price.insert(InstrumentIndex(i), bar.close);
                let first = symbol_first.get(&i).copied().unwrap_or(bar.close);
                let curve = symbol_bh.entry(i).or_default();
                curve.push(if first > 0.0 {
                    bar.close / first * cfg.initial_cash
                } else {
                    cfg.initial_cash
                });
            }
        }

        let equity_today = engine.state.global.equity();
        equity.push(r4(equity_today));
        equity_dates.push(date.format("%Y-%m-%d").to_string());

        // Equal-weight buy & hold benchmark over the members that trade today.
        let bh_today = if symbol_bh.is_empty() {
            cfg.initial_cash
        } else {
            let sum: f64 = symbol_bh
                .values()
                .filter_map(|c| c.last().copied())
                .sum();
            sum / symbol_bh.len() as f64
        };
        bh_curve.push(bh_today);

        let open_positions = engine
            .state
            .global
            .positions
            .values()
            .filter(|p| p.shares > 0.0)
            .count();
        if open_positions > 0 {
            engine.state.global.days_in_market += 1;
        }

        // Collect this day's actionable signals (BUY / SELL only).
        let mut day_decisions = Vec::new();
        {
            let rows = decisions.lock().unwrap();
            while decision_cursor < rows.len() {
                let row = &rows[decision_cursor];
                day_decisions.push(row.clone());
                decision_cursor += 1;
            }
        }
        let buys = day_decisions.iter().filter(|d| d.action == "BUY").count();
        let sells = day_decisions.iter().filter(|d| d.action == "SELL").count();

        days.push(DayRow {
            index: day_index,
            date: date.format("%Y-%m-%d").to_string(),
            equity: r4(equity_today),
            cash: r4(engine.state.global.cash),
            position_value: r4(engine.state.global.position_value()),
            positions: open_positions,
            evaluated,
            buys,
            sells,
            holds: evaluated.saturating_sub(buys + sells),
            trades: day_trades,
            decisions: day_decisions,
        });
    }

    // --- per-symbol rows --------------------------------------------------
    let mut rows: Vec<SymbolRow> = Vec::with_capacity(symbols.len());
    for (i, symbol) in symbols.iter().enumerate() {
        let curve = symbol_bh.get(&i).cloned().unwrap_or_default();
        let first = symbol_first.get(&i).copied().unwrap_or(0.0);
        let last = symbol_last.get(&i).copied().unwrap_or(0.0);
        let closed = symbol_closed.get(&i).cloned().unwrap_or_default();
        let framework_shares = engine
            .state
            .instruments
            .instrument_index(&InstrumentIndex(i))
            .position
            .current
            .as_ref()
            .map(|p| p.quantity_abs.to_f64().unwrap_or_default())
            .unwrap_or(0.0);
        rows.push(SymbolRow {
            symbol: symbol.clone(),
            buy_hold_percent: r4(if first > 0.0 {
                (last / first - 1.0) * 100.0
            } else {
                0.0
            }),
            realized_pnl: r4(symbol_pnl.get(&i).copied().unwrap_or(0.0)),
            trades: symbol_trades.get(&i).copied().unwrap_or(0),
            win_rate: if closed.is_empty() {
                0.0
            } else {
                closed.iter().filter(|p| **p > 0.0).count() as f64 / closed.len() as f64 * 100.0
            },
            max_drawdown: r4(crate::metrics::max_drawdown(&curve)),
            fees: r4(symbol_fees.get(&i).copied().unwrap_or(0.0)),
            last_close: r4(last),
            days: curve.len(),
            framework_shares,
        });
    }
    rows.sort_by(|a, b| {
        b.buy_hold_percent
            .partial_cmp(&a.buy_hold_percent)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let bh_final = bh_curve.last().copied().unwrap_or(cfg.initial_cash);
    let metrics = build_metrics(
        cfg.initial_cash,
        &equity,
        bh_final,
        &engine.state.global.closed_pnls,
        engine.state.global.fees,
        engine.state.global.days_in_market,
    );

    Ok(SimOutput {
        run_id: req.run_id,
        framework: FRAMEWORK.to_string(),
        strategy_id: req.strategy_id.to_string(),
        strategy_name: meta.name.to_string(),
        pools: req.pools,
        start: market
            .dates
            .first()
            .map(|d| d.format("%Y-%m-%d").to_string())
            .unwrap_or_default(),
        end: market
            .dates
            .last()
            .map(|d| d.format("%Y-%m-%d").to_string())
            .unwrap_or_default(),
        universe: symbols.len(),
        max_positions: engine.strategy.max_positions,
        slot_cash: r4(engine.strategy.slot_cash),
        min_position_value: r4(cfg.min_position_value),
        tested: rows.iter().filter(|r| r.days > 0).count(),
        missing: market.missing.clone(),
        metrics,
        equity,
        bh_equity: bh_curve.iter().copied().map(r4).collect(),
        equity_dates,
        days,
        trades,
        symbols: rows,
        elapsed_ms: started.elapsed().as_millis() as u64,
        refresh: None,
    })
}

/// Attach the fill (or rejection) to the signal row that produced it.
fn mark_decision(
    decisions: &Arc<Mutex<Vec<DecisionRow>>>,
    symbol: &str,
    shares: f64,
    price: f64,
    fee: f64,
    rejected: Option<String>,
) {
    let mut rows = decisions.lock().unwrap();
    if let Some(row) = rows
        .iter_mut()
        .rev()
        .find(|r| r.symbol == symbol && r.fill_price.is_none() && r.rejected.is_none())
    {
        row.filled_shares = r4(shares);
        row.fill_price = if price > 0.0 { Some(r4(price)) } else { None };
        row.fee = r4(fee);
        row.rejected = rejected;
    }
}
