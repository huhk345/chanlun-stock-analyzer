"""backtrader-backed backtest engine — the framework-native counterpart of ``runner.py``.

The project ships two interchangeable engines over the *same* strategy contract:

======================  ===========================================================
``native`` (default)    hand-rolled loop in ``runner.py``; zero dependencies,
                        bit-for-bit compatible with the historical TypeScript ledger.
``backtrader``          this module: the same ``decide(ctx) -> Decision`` contract
                        driven by `backtrader <https://www.backtrader.com/>`_, an
                        open-source event-driven backtesting framework.
======================  ===========================================================

Why keep both? ``backtrader`` brings a mature broker/order model (stop, limit,
OCO, bracket orders, analyzers, plotting) that would be pointless to re-invent,
while the native loop stays as the dependency-free reference implementation and
the regression oracle. The parity tests in
``tests/part2_integration/test_backtrader_engine.py`` pin the two engines to the
same trade ledger, so choosing one is a matter of features, not of numbers.

Execution model — deliberately identical to the native engine
--------------------------------------------------------------
1. **Signal from the closed bar.** The strategy only ever sees ``klines[:i+1]``;
   ``cheat-on-close`` (``broker.set_coc(True)``) makes a market order submitted in
   ``next()`` fill at *that* bar's close, not the next open.
2. **A-share microstructure.** 100-share lots, T+1, limit-up/limit-down rejection,
   commission + stamp duty (sell only) + transfer fee. Fees are plugged into
   backtrader as a ``CommInfoBase`` so the broker's cash bookkeeping stays exact.
3. **Fixed stop-loss** is a standing ``bt.Order.Stop`` armed in the same ``next()``
   that opens the position, i.e. it is first evaluated on the *next* bar — exactly
   when the native engine's intraday stop would first fire.

The strategy owns its K-line buffer
-----------------------------------
``StrategyAdapter`` keeps ``self.klines`` (a plain ``list[Kline]``, append-only)
and hands it to the strategy as ``ctx.klines``; ``ctx.chanlun`` and
``ctx.indicators`` are recomputed from that buffer on every bar. A strategy that
needs ChanLun structure or MA/MACD values therefore never re-reads the feed and
can never see a future bar. The buffer is exposed on the adapter after the run
(``adapter.klines``) for post-hoc analysis.

Reported prices are rounded to 6 decimals (four orders of magnitude below the
0.01 A-share tick) because backtrader derives ``executed.price`` from
``value / size``, which leaves ~1e-14 of float noise on every fill. Cash, equity
and the final balance are never rounded.
"""

from __future__ import annotations

import datetime as dt
from typing import Any, Callable, Dict, List, Optional, Sequence

import backtrader as bt

from .chanlun import compute_chanlun_structures
from .execution import (
    create_initial_account,
    create_initial_position,
    update_account_after_trade,
    update_position_after_buy,
    update_position_after_sell,
)
from .fees import (
    DEFAULT_COMMISSION_RATE,
    DEFAULT_MIN_COMMISSION,
    build_strategy_params,
    calc_a_stock_fees,
    limit_down_price,
    limit_up_price,
    resolve_order_shares,
    validate_decision,
)
from .indicators import compute_indicator_values
from .metrics import (
    iso_now,
    max_drawdown_from_equity_curve,
    next_trade_id,
    sharpe_from_equity_curve,
)
from .models import (
    Account,
    BacktestResult,
    Decision,
    Diagnostic,
    Kline,
    Position,
    StrategyScore,
    StrategySignal,
    Trade,
    decision_from_raw,
)
from .runner import RunBacktestOutput, _empty_result
from .strategies import Strategy, StrategyContext
from .timeline import DaySnapshot, summarize_chanlun

#: consecutive strategy exceptions tolerated before the strategy is switched off
MAX_CONSECUTIVE_ERRORS = 5
#: cap on per-run exception diagnostics (same as the native runner)
MAX_ERROR_DIAGNOSTICS = 3

ENGINE_NAME = "backtrader"


# ---------------------------------------------------------------------------
# 数据源: Kline list -> backtrader feed (无 pandas / numpy 依赖)
# ---------------------------------------------------------------------------


class KlineFeed(bt.feeds.DataBase):
    """In-memory OHLCV feed built from ``chanlun_server.models.Kline`` objects.

    ``backtrader`` ships a pandas feed, but the server is intentionally
    dependency-free apart from ``backtrader`` itself, so this subclass fills the
    lines directly from the list.
    """

    params = (("klines", ()),)

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._idx = 0

    def start(self) -> None:
        super().start()
        self._idx = 0

    def _load(self) -> bool:
        klines = self.p.klines
        if self._idx >= len(klines):
            return False
        bar = klines[self._idx]
        self.lines.datetime[0] = bt.date2num(_parse_date(bar.date))
        self.lines.open[0] = bar.open
        self.lines.high[0] = bar.high
        self.lines.low[0] = bar.low
        self.lines.close[0] = bar.close
        self.lines.volume[0] = bar.volume
        self.lines.openinterest[0] = 0.0
        self._idx += 1
        return True


def _parse_date(value: str) -> dt.datetime:
    return dt.datetime.fromisoformat(value)


# ---------------------------------------------------------------------------
# 费用: A 股佣金 + 印花税 + 过户费 接入 backtrader
# ---------------------------------------------------------------------------


class AStockCommission(bt.CommInfoBase):
    """``calc_a_stock_fees`` plugged into the broker.

    Overriding ``_getcommission`` (instead of backtrader's percentage scheme)
    keeps the cash bookkeeping byte-identical to the native engine: minimum
    commission, sell-side stamp duty and the both-side transfer fee all apply.
    """

    params = (
        ("commission", 0.0),
        ("stocklike", True),
        ("commtype", bt.CommInfoBase.COMM_PERC),
        ("commission_rate", DEFAULT_COMMISSION_RATE),
        ("min_commission", DEFAULT_MIN_COMMISSION),
    )

    def _getcommission(self, size: float, price: float, pseudoexec: bool) -> float:
        return calc_a_stock_fees(
            abs(size) * price,
            is_buy=size > 0,
            commission_rate=self.p.commission_rate,
            min_commission=self.p.min_commission,
        )


# ---------------------------------------------------------------------------
# 策略适配器: decide(ctx) -> backtrader 订单
# ---------------------------------------------------------------------------


class StrategyAdapter(bt.Strategy):
    """Runs a ``chanlun_server.strategies.Strategy`` bar by bar inside backtrader.

    Public state after ``cerebro.run()`` (read by :func:`run_backtest_bt`):

    ``klines``          the append-only K-line buffer the strategy saw
    ``trades``          filled trades in ``models.Trade`` form
    ``signals``         BUY/SELL signals as produced (before order rejection)
    ``daily_scores``    cross-sectional scores for pool rotation
    ``equity_curve``    one equity point per input bar
    ``diagnostics``     warnings/errors in wire form
    """

    params = (
        ("strategy_def", None),
        ("symbol", ""),
        ("currency", "CNY"),
        ("initial_cash", 100_000.0),
        ("strategy_params", None),
        ("selected_indicator_ids", None),
        ("indicator_defs", None),
        ("stop_loss_percent", None),
        ("commission_rate", DEFAULT_COMMISSION_RATE),
        ("min_commission", DEFAULT_MIN_COMMISSION),
        ("record_signals", False),
        ("total_bars", 0),
        ("compute_chanlun", True),
        #: original bars, so the recorded K-line keeps fields the feed drops (amount)
        ("source_bars", None),
    )

    # -- lifecycle ---------------------------------------------------------

    def __init__(self) -> None:
        self.klines: List[Kline] = []
        self.trades: List[Trade] = []
        self.signals: List[StrategySignal] = []
        self.daily_scores: List[StrategyScore] = []
        self.equity_curve: List[float] = []
        self.diagnostics: List[Diagnostic] = []
        self.chanlun = None
        self.indicators: Dict[str, Any] = {}

        # Mirror of the account/position exactly as the native engine maintains
        # it (market value priced at the last fill, not at the current close),
        # so a strategy sees identical ``ctx.account`` / ``ctx.position``.
        self._account = create_initial_account(float(self.p.initial_cash), self.p.currency)
        self._position = create_initial_position()

        self._params = dict(self.p.strategy_params or {})
        # ``indicator_defs`` is accepted for parity with the native engine; user
        # JavaScript indicators are not executed server-side (see indicators.py).
        self._selected = list(self.p.selected_indicator_ids or [])

        self._meta: Dict[int, Dict[str, Any]] = {}
        self._stop_ref: Optional[int] = None

        #: one record per simulated day, finalised one cycle after the bar
        self.day_records: List[DaySnapshot] = []
        self._pending_day: Optional[Dict[str, Any]] = None

        self._consecutive_errors = 0
        self._error_diagnostics = 0
        self._strategy_stopped = False
        self._has_decided = False

    # -- convenience accessors (also usable from native bt.Strategy code) --

    def closes(self, n: Optional[int] = None) -> List[float]:
        """Closing prices of the stored buffer, oldest first."""
        bars = self.klines[-n:] if n else self.klines
        return [k.close for k in bars]

    def sma(self, period: int) -> Optional[float]:
        """Simple moving average over the stored buffer (``None`` if too short)."""
        if period <= 0 or len(self.klines) < period:
            return None
        window = self.klines[-period:]
        return sum(k.close for k in window) / period

    @property
    def position_shares(self) -> int:
        return int(self.position.size)

    @property
    def final_account(self) -> Account:
        """Account mirror after the last fill (native-engine shape)."""
        return self._account

    @property
    def final_position(self) -> Position:
        """Position mirror after the last fill (native-engine shape)."""
        return self._position

    # -- main loop ---------------------------------------------------------

    def next(self) -> None:
        # 0) The bar that just closed settles its fills at the start of this
        #    cycle (backtrader notifies the broker before calling next()), so the
        #    equity snapshot taken here is the *previous* bar's closing equity —
        #    the same point in time the native runner records. It is also when the
        #    previous day's simulation record becomes final.
        if self.klines:
            equity = self._equity(self.klines[-1].close)
            self._finalize_day(equity)
            self.equity_curve.append(equity)

        # 1) Flush bar appended by run_backtest_bt: it only exists so an order
        #    submitted on the final real bar can settle. Nothing else to do.
        if len(self.klines) >= int(self.p.total_bars):
            return

        bar = self.data
        index = len(self.klines)
        source = self.p.source_bars
        if source is not None and index < len(source):
            # Reuse the original bar: backtrader's feed only carries OHLCV, so
            # reconstructing from it would invent ``amount`` and lose fidelity
            # with the native engine's ledger and timeline.
            kline = source[index]
        else:
            kline = Kline(
                date=bt.num2date(bar.datetime[0]).date().isoformat(),
                open=float(bar.open[0]),
                high=float(bar.high[0]),
                low=float(bar.low[0]),
                close=float(bar.close[0]),
                volume=float(bar.volume[0]),
                amount=float(bar.volume[0]) * float(bar.close[0]),
            )
        # The strategy owns the buffer: append first, then compute everything
        # from it, so no code path can reach past the current bar.
        self.klines.append(kline)
        prev_close = self.klines[-2].close if index > 0 else None

        trades_start = len(self.trades)
        diagnostics_start = len(self.diagnostics)

        decision = Decision.hold() if self._strategy_stopped else self._decide(kline, index)
        if decision is None:
            decision = Decision.hold()

        # --- 记录策略信号 (成交拦截之前, 保持策略原始观点) ---
        if self.p.record_signals and decision.action != "HOLD":
            self.signals.append(
                StrategySignal(
                    date=kline.date,
                    action=decision.action,
                    reason=decision.reason,
                    confidence=decision.confidence,
                    price=kline.close,
                )
            )
        if self.p.record_signals and decision.score is not None:
            self.daily_scores.append(StrategyScore(date=kline.date, score=decision.score))

        if decision.action != "HOLD":
            self._execute(decision, kline, prev_close)

        # The day's record is finalised on the next cycle, once backtrader has
        # settled this bar's orders (fills land at the start of the next cycle).
        self._pending_day = {
            "index": index,
            "kline": kline,
            "decision": decision,
            "indicators": dict(self.indicators),
            "chanlun": summarize_chanlun(self.chanlun),
            "trades_start": trades_start,
            "diagnostics_start": diagnostics_start,
        }

    # -- strategy call -----------------------------------------------------

    def _decide(self, kline: Kline, index: int) -> Optional[Decision]:
        strategy: Strategy = self.p.strategy_def
        assert strategy is not None

        if self.p.compute_chanlun:
            self.chanlun = compute_chanlun_structures(self.klines)
        indicator_values = compute_indicator_values(self._selected, self.p.symbol, self.klines, index)
        self.indicators = indicator_values
        self._params.update(indicator_values)

        ctx = StrategyContext(
            symbol=self.p.symbol,
            timeframe="daily",
            klines=self.klines,
            current_index=index,
            current_kline=kline,
            account=self._account,
            position=self._position,
            trades=[t.to_snapshot() for t in self.trades],
            params=self._params,
            currency=self.p.currency,
            initial_cash=float(self.p.initial_cash),
            chanlun=self.chanlun,
            indicators=indicator_values,
        )

        try:
            decision = decision_from_raw(strategy.decide(ctx))
            self._consecutive_errors = 0
            self._has_decided = True
        except Exception as exc:  # noqa: BLE001 - one bad bar must not kill the run
            self._consecutive_errors += 1
            message = str(exc) or exc.__class__.__name__
            if self._has_decided and self._consecutive_errors >= MAX_CONSECUTIVE_ERRORS:
                self._strategy_stopped = True
                self.diagnostics.append(
                    Diagnostic(
                        level="error",
                        date=kline.date,
                        message=(
                            f"Strategy threw {self._consecutive_errors} consecutive errors after "
                            f"{len(self.klines)} bars, last: {message}. Strategy will no longer be called."
                        ),
                    )
                )
            elif self._error_diagnostics < MAX_ERROR_DIAGNOSTICS:
                self._error_diagnostics += 1
                self.diagnostics.append(
                    Diagnostic(
                        level="warning",
                        date=kline.date,
                        message=f"Strategy error (treated as HOLD, 后续信号继续评估): {message}",
                    )
                )
            return Decision(action="HOLD", reason=f"策略异常按 HOLD 处理: {message}")

        errors = validate_decision(decision)
        if errors:
            for message in errors:
                self.diagnostics.append(
                    Diagnostic(
                        level="warning",
                        date=kline.date,
                        message=f"Invalid decision: {message}",
                    )
                )
            return Decision.hold()
        return decision

    # -- order execution ---------------------------------------------------

    def _execute(self, decision: Decision, kline: Kline, prev_close: Optional[float]) -> None:
        price = kline.close
        strategy: Strategy = self.p.strategy_def
        label = (strategy.id or strategy.name) if strategy is not None else ""

        order = resolve_order_shares(decision, self._account, self._position, price)
        for warning in order.warnings:
            self.diagnostics.append(Diagnostic(message=warning, level="warning", date=kline.date))
        if order.shares <= 0:
            return

        # --- 涨跌停拦截 (收盘封板无法按收盘价成交) ---
        if prev_close is not None and prev_close > 0:
            if decision.action == "BUY" and price >= limit_up_price(prev_close, self.p.symbol):
                self.diagnostics.append(
                    Diagnostic(
                        level="warning",
                        date=kline.date,
                        message=(
                            "Buy blocked: 收盘封涨停, 无法按收盘价买入 "
                            f"(close {price:.2f} >= limit-up {limit_up_price(prev_close, self.p.symbol):.2f}), 交易作废"
                        ),
                    )
                )
                return
            if decision.action == "SELL" and price <= limit_down_price(prev_close, self.p.symbol):
                self.diagnostics.append(
                    Diagnostic(
                        level="warning",
                        date=kline.date,
                        message=(
                            "Sell blocked: 收盘封跌停, 无法按收盘价卖出 "
                            f"(close {price:.2f} <= limit-down {limit_down_price(prev_close, self.p.symbol):.2f}), 交易作废"
                        ),
                    )
                )
                return

        if decision.action == "BUY":
            self._submit_buy(decision, kline, order.shares, label)
        else:
            self._submit_sell(decision, kline, order.shares, label)

    def _submit_buy(self, decision: Decision, kline: Kline, shares: int, label: str) -> None:
        price = kline.close
        # Shrink in whole lots until cash covers value + fees (same loop as the
        # native engine, so the share count is identical).
        buy_shares = shares
        cost = buy_shares * price
        fee = calc_a_stock_fees(cost, True, self.p.commission_rate, self.p.min_commission)
        cash = self.broker.getcash()
        while buy_shares >= 100 and cost + fee > cash:
            buy_shares -= 100
            cost = buy_shares * price
            fee = calc_a_stock_fees(cost, True, self.p.commission_rate, self.p.min_commission)
        if buy_shares <= 0 or cost + fee > cash:
            self.diagnostics.append(
                Diagnostic(
                    message="Buy skipped: 成交时可用资金不足 (含手续费)",
                    level="warning",
                    date=kline.date,
                )
            )
            return

        self._cancel_stop()
        bt_order = self.buy(size=buy_shares)
        self._remember(bt_order, decision, label, avg_cost=self._position.average_cost)

        # Arm the protective stop now: it is first evaluated on the *next* bar,
        # which is exactly when the native intraday stop would first fire.
        projected_shares = self._position.shares + buy_shares
        projected_cost = self._position.average_cost * self._position.shares + price * buy_shares
        projected_avg = projected_cost / projected_shares if projected_shares else 0.0
        self._arm_stop(projected_shares, projected_avg)

    def _submit_sell(self, decision: Decision, kline: Kline, shares: int, label: str) -> None:
        sell_shares = min(shares, self._position.shares)
        if sell_shares <= 0:
            return
        self._cancel_stop()
        bt_order = self.sell(size=sell_shares)
        self._remember(bt_order, decision, label, avg_cost=self._position.average_cost)
        remaining = self._position.shares - sell_shares
        if remaining > 0:
            self._arm_stop(remaining, self._position.average_cost)

    # -- protective stop ---------------------------------------------------

    def _arm_stop(self, shares: int, average_cost: float) -> None:
        pct = self.p.stop_loss_percent
        if pct is None or shares <= 0 or average_cost <= 0:
            return
        stop_price = average_cost * (1 - float(pct) / 100.0)
        if stop_price <= 0:
            return
        order = self.sell(size=shares, exectype=bt.Order.Stop, price=stop_price)
        if order is None:
            return
        self._stop_ref = order.ref
        self._meta[order.ref] = {
            "signal_type": "stop-loss",
            "reason": f"触发固定止损 {pct}%",
            "avg_cost": average_cost,
        }

    def _cancel_stop(self) -> None:
        if self._stop_ref is None:
            return
        for order in list(self.broker.pending):
            if order is not None and order.ref == self._stop_ref:
                self.cancel(order)
                break
        self._meta.pop(self._stop_ref, None)
        self._stop_ref = None

    # -- notifications -----------------------------------------------------

    def _remember(self, order: Any, decision: Decision, label: str, avg_cost: float) -> None:
        if order is None:
            return
        self._meta[order.ref] = {
            "signal_type": label,
            "reason": decision.reason,
            "confidence": decision.confidence,
            "avg_cost": avg_cost,
        }

    def notify_order(self, order: Any) -> None:
        if order.status in (order.Submitted, order.Accepted):
            return

        meta = self._meta.pop(order.ref, None) or {}
        is_stop = order.ref == self._stop_ref
        if is_stop:
            self._stop_ref = None

        if order.status == order.Completed:
            self._record_fill(order, meta, is_stop)
            return

        if order.status in (order.Canceled, order.Margin, order.Rejected, order.Expired):
            if order.isbuy() and self._stop_ref is not None:
                # A rejected entry must not leave a naked sell-stop behind.
                self._cancel_stop()

    def _record_fill(self, order: Any, meta: Dict[str, Any], is_stop: bool) -> None:
        shares = int(abs(order.executed.size))
        if shares <= 0:
            return
        # backtrader derives ``executed.price`` from ``value / size``, which adds
        # ~1e-14 of float noise (246.318 -> 246.31800000000004). Round back to a
        # precision far below any A-share tick so the ledger matches the native
        # engine and the JSON stays readable. Cash bookkeeping keeps the raw value.
        report_price = round(float(order.executed.price), 6)
        date = bt.num2date(order.executed.dt).date().isoformat()

        if not order.isbuy() and self._position.shares <= 0:
            # A sell filled while the mirror is flat would be a naked short: only
            # reachable if a buy was rejected after its stop was armed. Surface it
            # instead of letting the ledger drift.
            self.diagnostics.append(
                Diagnostic(
                    level="error",
                    date=date,
                    message="Sell filled with no position (naked short); ledger may be inconsistent.",
                )
            )
            return

        trade = Trade(
            id=next_trade_id(),
            type="BUY" if order.isbuy() else "SELL",
            signal_type=str(meta.get("signal_type") or ""),
            reason=meta.get("reason"),
            confidence=meta.get("confidence"),
            price=report_price,
            date=date,
            shares=shares,
            value=shares * report_price,
            fee=float(order.executed.comm),
        )

        # The mirror is what strategies read (``ctx.account`` / ``ctx.position``),
        # so it is priced off the reported fill price — the same number the native
        # engine uses — instead of backtrader's value/size division.
        if order.isbuy():
            self._position = update_position_after_buy(self._position, shares, report_price)
            self._account = Account(
                initial_cash=self._account.initial_cash,
                cash=self._account.cash - shares * report_price - trade.fee,
                equity=self._account.equity,
                currency=self._account.currency,
            )
        else:
            avg_cost = float(meta.get("avg_cost") or self._position.average_cost)
            new_position, realized_pnl = update_position_after_sell(
                self._position, shares, report_price
            )
            self._position = new_position
            self._account = Account(
                initial_cash=self._account.initial_cash,
                cash=self._account.cash + shares * report_price - trade.fee,
                equity=self._account.equity,
                currency=self._account.currency,
            )
            trade.pnl = realized_pnl
            trade.pnl_percent = (
                (realized_pnl / (shares * avg_cost)) * 100.0 if avg_cost > 0 else 0.0
            )

        self._account = update_account_after_trade(self._account, self._position, report_price)
        self.trades.append(trade)

        if is_stop:
            self.diagnostics.append(
                Diagnostic(
                    level="warning",
                    date=date,
                    message=f"Stop-loss triggered at {report_price:.2f}",
                )
            )

    # -- helpers -----------------------------------------------------------

    def _finalize_day(self, equity: float) -> None:
        """Close out the previous bar's simulation record.

        Called at the start of the next cycle, i.e. after the broker has settled
        that bar's orders, so ``accountAfter`` / ``positionAfter`` already include
        the fills and ``trades`` / ``diagnostics`` can be sliced by offset.
        """
        pending = self._pending_day
        if pending is None:
            return
        self._pending_day = None
        self.day_records.append(
            DaySnapshot(
                index=pending["index"],
                kline=pending["kline"],
                decision=pending["decision"],
                account_after=self._account.copy(),
                position_after=self._position.copy(),
                equity=equity,
                trades_executed=[t.to_snapshot() for t in self.trades[pending["trades_start"]:]],
                diagnostics=list(self.diagnostics[pending["diagnostics_start"]:]),
                indicators=pending["indicators"],
                chanlun=pending["chanlun"],
            )
        )

    def stop(self) -> None:
        # Safety net: the sentinel bar normally flushes the last record, but a run
        # with a single bar (or an early stop) may still have one pending.
        if self.klines:
            self._finalize_day(self._equity(self.klines[-1].close))

    def _equity(self, price: float) -> float:
        return float(self.broker.getcash()) + self.position_shares * price


# ---------------------------------------------------------------------------
# 入口: 与 runner.run_backtest 同签名 / 同返回
# ---------------------------------------------------------------------------


def run_backtest_bt(
    klines: Sequence[Kline],
    symbol: str,
    strategy: Strategy,
    user_id: str = "server",
    initial_cash: float = 100_000.0,
    currency: str = "CNY",
    stop_loss_percent: Optional[float] = None,
    commission_rate: float = DEFAULT_COMMISSION_RATE,
    min_commission: float = DEFAULT_MIN_COMMISSION,
    params: Optional[Dict[str, Any]] = None,
    selected_indicator_ids: Optional[Sequence[str]] = None,
    indicators: Optional[Sequence[Any]] = None,
    record_signals: bool = False,
    compute_chanlun: bool = True,
    on_bar: Optional[Callable[[DaySnapshot], None]] = None,
) -> RunBacktestOutput:
    """Run ``strategy`` over ``klines`` with backtrader; return the native output shape.

    ``resume`` (the native engine's incremental-prefix optimisation) has no
    backtrader equivalent and is intentionally unsupported: a backtrader run is
    always a full replay.

    ``on_bar`` receives one :class:`DaySnapshot` per bar for the day-by-day
    timeline. Because backtrader settles a bar's orders on the following cycle,
    the snapshots are complete only once the run has finished — so unlike the
    native runner (which calls the hook inside its loop) this engine replays the
    collected records after ``cerebro.run()``. The result is identical.
    """
    diagnostics: List[Diagnostic] = []
    if not klines:
        return _empty_result(symbol, user_id, initial_cash, diagnostics)

    bars = list(klines)
    feed_bars = [*bars, _flush_bar(bars[-1])]

    cerebro = bt.Cerebro(stdstats=False, maxcpus=1)
    cerebro.adddata(KlineFeed(klines=feed_bars))
    cerebro.broker.setcash(float(initial_cash))
    # Signals are produced on the closed bar and filled at that bar's close.
    cerebro.broker.set_coc(True)
    # Order sizing/cash checks are done by the engine (identical to the native
    # runner); backtrader must not second-guess them with its own cash model.
    cerebro.broker.set_checksubmit(False)
    cerebro.broker.addcommissioninfo(
        AStockCommission(commission_rate=commission_rate, min_commission=min_commission)
    )
    cerebro.addstrategy(
        StrategyAdapter,
        strategy_def=strategy,
        symbol=symbol,
        currency=currency,
        initial_cash=float(initial_cash),
        strategy_params=build_strategy_params({"params": strategy.params}, params),
        selected_indicator_ids=list(selected_indicator_ids or []),
        indicator_defs=list(indicators or []),
        stop_loss_percent=stop_loss_percent,
        commission_rate=commission_rate,
        min_commission=min_commission,
        record_signals=record_signals,
        total_bars=len(bars),
        compute_chanlun=compute_chanlun,
        source_bars=bars,
    )

    adapter: StrategyAdapter = cerebro.run()[0]

    if on_bar is not None:
        for snapshot in adapter.day_records:
            on_bar(snapshot)

    last_price = bars[-1].close
    first_price = bars[0].close
    final_balance = float(cerebro.broker.getcash()) + adapter.position_shares * last_price
    total_return_percent = (
        ((final_balance - initial_cash) / initial_cash) * 100 if initial_cash > 0 else 0.0
    )
    trades = adapter.trades
    total_sells = sum(1 for t in trades if t.type == "SELL")
    winning_trades = sum(1 for t in trades if t.type == "SELL" and (t.pnl or 0) > 0)
    win_rate = (winning_trades / total_sells) * 100 if total_sells > 0 else 0.0
    buy_hold_return_percent = (
        ((last_price - first_price) / first_price) * 100 if first_price > 0 else 0.0
    )

    result = BacktestResult(
        id=f"backtest-{int(__import__('time').time() * 1000)}",
        user_id=user_id,
        symbol=symbol,
        start_date=bars[0].date,
        end_date=bars[-1].date,
        initial_balance=initial_cash,
        final_balance=final_balance,
        total_return_percent=total_return_percent,
        total_trades=len(trades),
        winning_trades=winning_trades,
        win_rate=win_rate,
        total_fees=sum(t.fee for t in trades),
        sharpe_ratio=sharpe_from_equity_curve(adapter.equity_curve),
        buy_hold_return_percent=buy_hold_return_percent,
        max_drawdown_percent=max_drawdown_from_equity_curve(adapter.equity_curve),
        trades=trades,
        created_at=iso_now(),
    )

    diagnostics.extend(adapter.diagnostics)

    return RunBacktestOutput(
        result=result,
        diagnostics=diagnostics,
        equity_curve=adapter.equity_curve,
        signals=adapter.signals if record_signals else None,
        daily_scores=adapter.daily_scores if record_signals else None,
        final_state=(
            {
                "account": adapter.final_account,
                "position": adapter.final_position,
                "trades": trades,
            }
            if record_signals
            else None
        ),
    )


def _flush_bar(last: Kline) -> Kline:
    """Duplicate of the final bar, dated one day later.

    backtrader settles an order at the start of the *following* bar, so without
    this sentinel a trade signalled on the last bar would never fill and the
    engine would silently disagree with the native one. The adapter ignores this
    bar for strategy/ChanLun purposes.
    """
    next_date = dt.date.fromisoformat(last.date) + dt.timedelta(days=1)
    return Kline(
        date=next_date.isoformat(),
        open=last.open,
        high=last.high,
        low=last.low,
        close=last.close,
        volume=last.volume,
        amount=last.amount,
    )

