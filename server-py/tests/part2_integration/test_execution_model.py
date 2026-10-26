"""Part 2 — integration tests for the execution model.

These exercise the engine end-to-end (strategy → decision → fill → ledger) with
synthetic bars, asserting the documented A-share conventions.
"""

from __future__ import annotations

import pytest

from chanlun_server.runner import run_backtest
from conftest import make_klines, wave_klines

pytestmark = pytest.mark.integration

SYMBOL = "600000.SH"


def _run(klines, strategy, stop_loss_percent=None, cash=100_000.0):
    return run_backtest(
        klines=klines,
        symbol=SYMBOL,
        strategy=strategy,
        initial_cash=cash,
        stop_loss_percent=stop_loss_percent,
    )


# ---------------------------------------------------------------------------
# 成交时点 / 价格
# ---------------------------------------------------------------------------


def test_fills_happen_at_the_signal_bar_close(make_probe):
    bars = wave_klines(30)
    strategy = make_probe([9], [15])
    output = _run(bars, strategy)

    trades = output.result.trades
    assert len(trades) == 2

    buy, sell = trades
    assert buy.type == "BUY"
    assert buy.date == bars[9].date
    assert buy.price == pytest.approx(bars[9].close)
    assert buy.price != pytest.approx(bars[9].open)

    assert sell.type == "SELL"
    assert sell.date == bars[15].date
    assert sell.price == pytest.approx(bars[15].close)


def test_no_fill_when_strategy_holds(make_probe):
    bars = wave_klines(30)
    output = _run(bars, make_probe([], []))
    assert output.result.total_trades == 0
    assert output.result.final_balance == pytest.approx(100_000)
    assert len(output.equity_curve) == len(bars)


def test_equity_curve_has_one_point_per_bar(make_probe):
    bars = wave_klines(50)
    output = _run(bars, make_probe([5], [20]))
    assert len(output.equity_curve) == len(bars)
    assert output.result.final_balance == pytest.approx(output.equity_curve[-1])


# ---------------------------------------------------------------------------
# T+1 / 止损
# ---------------------------------------------------------------------------


def test_t_plus_one_blocks_same_day_stop(make_probe):
    bars = make_klines(
        [
            # signal bar: close 100 buy; low 80 would breach a 10% stop but T+1 forbids selling today
            {"date": "2024-01-01", "open": 100, "high": 101, "low": 80, "close": 100},
            # next session: low 85 touches the 90 stop
            {"date": "2024-01-02", "open": 95, "high": 96, "low": 85, "close": 90},
        ]
    )
    output = _run(bars, make_probe([0], []), stop_loss_percent=10)
    trades = output.result.trades

    day0 = [t for t in trades if t.date == "2024-01-01"]
    assert len(day0) == 1 and day0[0].type == "BUY"
    assert day0[0].price == pytest.approx(100)

    sell = next(t for t in trades if t.type == "SELL")
    assert sell.date == "2024-01-02"
    assert sell.signal_type == "stop-loss"
    assert sell.price == pytest.approx(90.0)


def test_stop_gap_down_fills_at_open(make_probe):
    bars = make_klines(
        [
            {"date": "2024-01-01", "open": 100, "high": 101, "low": 99, "close": 100},
            {"date": "2024-01-02", "open": 85, "high": 92, "low": 84, "close": 86},
        ]
    )
    output = _run(bars, make_probe([0], []), stop_loss_percent=10)
    sell = next(t for t in output.result.trades if t.type == "SELL")
    assert sell.price == pytest.approx(85.0)


def test_stop_is_deferred_when_limit_down_all_day(make_probe):
    bars = make_klines(
        [
            {"date": "2024-01-01", "open": 100, "high": 101, "low": 99, "close": 100},
            # sealed at limit-down 90 all session -> cannot sell
            {"date": "2024-01-02", "open": 90, "high": 90, "low": 90, "close": 90},
            {"date": "2024-01-03", "open": 85, "high": 88, "low": 84, "close": 86},
        ]
    )
    output = _run(bars, make_probe([0], []), stop_loss_percent=10)
    trades = output.result.trades

    assert [t for t in trades if t.date == "2024-01-02"] == []
    sell = next(t for t in trades if t.type == "SELL")
    assert sell.date == "2024-01-03"
    assert sell.price == pytest.approx(85.0)
    assert any("顺延" in d.message for d in output.diagnostics)


# ---------------------------------------------------------------------------
# 涨跌停
# ---------------------------------------------------------------------------


def test_limit_up_close_blocks_buy(make_probe):
    bars = make_klines(
        [
            {"date": "2024-01-01", "open": 100, "high": 101, "low": 99, "close": 100},
            {"date": "2024-01-02", "open": 110, "high": 110, "low": 110, "close": 110},
        ]
    )
    output = _run(bars, make_probe([1], []))
    assert output.result.total_trades == 0
    assert any("涨停" in d.message for d in output.diagnostics)


def test_limit_down_close_blocks_sell(make_probe):
    bars = make_klines(
        [
            {"date": "2024-01-01", "open": 100, "high": 101, "low": 99, "close": 100},
            {"date": "2024-01-02", "open": 90, "high": 90, "low": 90, "close": 90},
        ]
    )
    output = _run(bars, make_probe([0], [1]))
    types = [t.type for t in output.result.trades]
    assert types == ["BUY"]
    assert any("跌停" in d.message for d in output.diagnostics)


# ---------------------------------------------------------------------------
# 账本不变量
# ---------------------------------------------------------------------------


def test_ledger_invariants_hold(make_probe):
    bars = wave_klines(200, seed=1.0)
    strategy = make_probe([10, 60, 120], [40, 90, 160])
    output = _run(bars, strategy, stop_loss_percent=12)

    by_date = {k.date: k for k in bars}
    cash = 100_000.0
    shares = 0

    for trade in output.result.trades:
        bar = by_date[trade.date]
        assert bar.low - 1e-9 <= trade.price <= bar.high + 1e-9
        if trade.type == "BUY":
            assert trade.shares % 100 == 0, "A-share buys must be whole lots"
            cash -= trade.value + trade.fee
            shares += trade.shares
        else:
            assert trade.shares <= shares
            cash += trade.value - trade.fee
            shares -= trade.shares
        assert cash >= -1e-6
        assert shares >= 0

    assert cash + shares * bars[-1].close == pytest.approx(output.result.final_balance)
    assert output.result.total_fees > 0


def test_win_rate_and_winning_trades_are_consistent(make_probe):
    bars = wave_klines(200, seed=2.0)
    output = _run(bars, make_probe([10, 80], [40, 120]))
    sells = [t for t in output.result.trades if t.type == "SELL"]
    winners = [t for t in sells if (t.pnl or 0) > 0]
    assert output.result.winning_trades == len(winners)
    if sells:
        assert output.result.win_rate == pytest.approx(len(winners) / len(sells) * 100)


# ---------------------------------------------------------------------------
# 确定性 / 异常策略
# ---------------------------------------------------------------------------


def test_identical_inputs_produce_identical_ledgers(make_probe):
    bars = wave_klines(120, seed=4.0)
    strategy = make_probe([5, 30], [15, 45])
    first = _run(bars, strategy, stop_loss_percent=8)
    second = _run(bars, strategy, stop_loss_percent=8)

    strip = lambda t: (t.date, t.type, round(t.price, 8), t.shares, round(t.value, 8), t.signal_type)
    assert [strip(t) for t in first.result.trades] == [strip(t) for t in second.result.trades]
    assert first.equity_curve == second.equity_curve


def test_strategy_exception_degrades_to_hold():
    from chanlun_server.strategies import Strategy

    calls = {"n": 0}

    def decide(ctx):
        calls["n"] += 1
        raise RuntimeError("boom")

    strategy = Strategy(id="broken", name="Broken", decide=decide)
    bars = wave_klines(40)
    output = _run(bars, strategy)

    assert output.result.total_trades == 0
    assert calls["n"] == len(bars)  # keeps evaluating until the run ends
    assert any("Strategy error" in d.message for d in output.diagnostics)


def test_invalid_decision_is_rejected_and_treated_as_hold():
    from chanlun_server.models import Decision
    from chanlun_server.strategies import Strategy

    def decide(ctx):
        if ctx.current_index == 5:
            return Decision(action="BUY", amount=None)  # invalid: BUY without amount
        return Decision.hold()

    output = _run(wave_klines(20), Strategy(id="bad", name="Bad", decide=decide))
    assert output.result.total_trades == 0
    assert any("Invalid decision" in d.message for d in output.diagnostics)


def test_empty_klines_yields_no_trade_report(make_probe):
    output = _run([], make_probe([0], [1]))
    assert output.result.total_trades == 0
    assert output.result.final_balance == pytest.approx(100_000)
    assert any("No K-line data" in d.message for d in output.diagnostics)
