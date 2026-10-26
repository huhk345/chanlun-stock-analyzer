"""Part 1 — unit tests for A-share trading rules and performance maths."""

from __future__ import annotations

import math

import pytest

from chanlun_server.fees import (
    calc_a_stock_fees,
    limit_down_price,
    limit_up_price,
    resolve_order_shares,
    stock_limit_ratio,
    validate_decision,
)
from chanlun_server.metrics import (
    iso_now,
    max_drawdown_from_equity_curve,
    next_trade_id,
    sharpe_from_equity_curve,
    sharpe_from_returns,
    trades_to_snapshots,
)
from chanlun_server.models import Account, Amount, Decision, Position, Trade
from chanlun_server.numeric import round_half_up

pytestmark = pytest.mark.unit


# ---------------------------------------------------------------------------
# 费用
# ---------------------------------------------------------------------------


def test_buy_fee_is_commission_plus_transfer_fee():
    # 100000 * 0.00025 = 25 commission, no stamp duty, 100000 * 0.00001 = 1 transfer
    assert calc_a_stock_fees(100_000, True) == pytest.approx(26.0)


def test_sell_fee_adds_stamp_duty():
    assert calc_a_stock_fees(100_000, False) == pytest.approx(26.0 + 100.0)


def test_minimum_commission_applies_to_small_trades():
    assert calc_a_stock_fees(1_000, True) == pytest.approx(5.0 + 0.01)
    assert calc_a_stock_fees(1_000, False) == pytest.approx(5.0 + 1.0 + 0.01)


def test_commission_rate_is_configurable():
    assert calc_a_stock_fees(100_000, True, commission_rate=0.0001, min_commission=0) == pytest.approx(
        10.0 + 1.0
    )


# ---------------------------------------------------------------------------
# 涨跌停
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "symbol,ratio",
    [
        ("600519.SH", 1.10),
        ("000001.SZ", 1.10),
        ("002415.SZ", 1.10),
        ("300750.SZ", 1.20),
        ("688981.SH", 1.20),
        ("830799.BJ", 1.05),
        ("430047.BJ", 1.05),
    ],
)
def test_limit_ratio_by_board(symbol, ratio):
    assert stock_limit_ratio(symbol) == pytest.approx(ratio)


def test_limit_prices_round_to_cent():
    assert limit_up_price(10.0, "600000.SH") == 11.0
    assert limit_down_price(10.0, "600000.SH") == 9.0
    assert limit_up_price(10.01, "600000.SH") == 11.01  # 11.011 -> 11.01
    assert limit_down_price(10.01, "600000.SH") == 9.01  # 9.009 -> 9.01
    assert limit_up_price(10.0, "300001.SZ") == 12.0
    assert limit_down_price(10.0, "300001.SZ") == 8.0
    assert limit_up_price(10.0, "830799.BJ") == 10.5


# ---------------------------------------------------------------------------
# 委托数量
# ---------------------------------------------------------------------------


def _account(cash: float = 100_000.0) -> Account:
    return Account(initial_cash=cash, cash=cash, equity=cash, currency="CNY")


def _position(shares: int = 0, cost: float = 10.0) -> Position:
    return Position(shares=shares, average_cost=cost)


def test_buy_percent_uses_available_cash_and_rounds_to_lots():
    order = resolve_order_shares(
        Decision(action="BUY", amount=Amount("percent", 100)), _account(), _position(), 10.0
    )
    assert order.shares == 10_000
    assert order.actual_value == pytest.approx(100_000)
    assert order.warnings == []


def test_buy_cash_amount_floors_to_whole_lots():
    order = resolve_order_shares(
        Decision(action="BUY", amount=Amount("cash", 5_050)), _account(), _position(), 10.0
    )
    assert order.shares == 500  # 505 shares -> 5 lots


def test_buy_shares_amount_is_capped_by_cash():
    order = resolve_order_shares(
        Decision(action="BUY", amount=Amount("shares", 50_000)), _account(10_000), _position(), 10.0
    )
    assert order.shares == 1_000


def test_buy_below_one_lot_warns_and_returns_zero():
    order = resolve_order_shares(
        Decision(action="BUY", amount=Amount("cash", 500)), _account(), _position(), 10.0
    )
    assert order.shares == 0
    assert any("round lot" in w for w in order.warnings)


def test_sell_is_clamped_to_holdings():
    order = resolve_order_shares(
        Decision(action="SELL", amount=Amount("shares", 5_000)), _account(), _position(1_000), 10.0
    )
    assert order.shares == 1_000


def test_sell_percent_of_holdings():
    order = resolve_order_shares(
        Decision(action="SELL", amount=Amount("percent", 50)), _account(), _position(1_000), 10.0
    )
    assert order.shares == 500


def test_sell_cash_unit_is_rejected():
    order = resolve_order_shares(
        Decision(action="SELL", amount=Amount("cash", 1_000)), _account(), _position(1_000), 10.0
    )
    assert order.shares == 0
    assert any("not valid for SELL" in w for w in order.warnings)


def test_invalid_price_returns_zero_shares():
    order = resolve_order_shares(
        Decision(action="BUY", amount=Amount("percent", 100)), _account(), _position(), 0.0
    )
    assert order.shares == 0
    assert order.warnings == ["Invalid current price"]


# ---------------------------------------------------------------------------
# 决策校验
# ---------------------------------------------------------------------------


def test_hold_needs_no_amount():
    assert validate_decision(Decision(action="HOLD")) == []


def test_buy_without_amount_is_invalid():
    assert validate_decision(Decision(action="BUY")) == ["BUY must have an amount"]


def test_percent_above_100_is_invalid():
    errors = validate_decision(Decision(action="BUY", amount=Amount("percent", 150)))
    assert any("Percent value" in e for e in errors)


def test_confidence_outside_range_is_invalid():
    errors = validate_decision(
        Decision(action="BUY", amount=Amount("percent", 50), confidence=1.5)
    )
    assert any("Confidence" in e for e in errors)


def test_unknown_action_is_invalid():
    assert validate_decision(Decision(action="SHORT")) == ["Action must be BUY, SELL, or HOLD"]


# ---------------------------------------------------------------------------
# 绩效指标
# ---------------------------------------------------------------------------


def test_sharpe_of_constant_returns_is_zero_when_volatility_is_zero():
    assert sharpe_from_returns([0.01, 0.01, 0.01]) == 0.0
    assert sharpe_from_returns([0.01]) == 0.0


def test_sharpe_matches_manual_computation():
    returns = [0.01, 0.02, -0.01, 0.03]
    mean = sum(returns) / len(returns)
    variance = sum((r - mean) ** 2 for r in returns) / len(returns)
    expected = (mean / math.sqrt(variance)) * math.sqrt(252)
    assert sharpe_from_returns(returns) == pytest.approx(expected)


def test_sharpe_from_equity_curve_matches_return_series():
    curve = [100.0, 101.0, 100.5, 103.0]
    returns = [(curve[i] - curve[i - 1]) / curve[i - 1] for i in range(1, len(curve))]
    assert sharpe_from_equity_curve(curve) == pytest.approx(sharpe_from_returns(returns))


def test_max_drawdown_peak_to_trough():
    assert max_drawdown_from_equity_curve([100, 120, 90, 110]) == pytest.approx(25.0)
    assert max_drawdown_from_equity_curve([100, 101, 102]) == 0.0
    assert max_drawdown_from_equity_curve([], 100) == 0.0


def test_max_drawdown_uses_initial_peak():
    # first bar already below the initial cash -> counted as drawdown
    assert max_drawdown_from_equity_curve([95, 100], 100) == pytest.approx(5.0)


def test_trade_ids_are_unique():
    ids = {next_trade_id() for _ in range(100)}
    assert len(ids) == 100


def test_trade_snapshot_falls_back_to_signal_type():
    trade = Trade(id="t1", type="BUY", signal_type="ma-cross", price=10, date="2024-01-01", shares=100, value=1000)
    snapshot = trades_to_snapshots([trade])[0]
    assert snapshot["action"] == "BUY"
    assert snapshot["reason"] == "ma-cross"


def test_iso_now_is_utc_with_millis():
    stamp = iso_now()
    assert stamp.endswith("Z") and len(stamp) == 24 and stamp[10] == "T"


# ---------------------------------------------------------------------------
# JS 舍入语义
# ---------------------------------------------------------------------------


def test_round_half_up_differs_from_bankers_rounding():
    assert round(0.125, 2) == 0.12  # Python banker's rounding
    assert round_half_up(0.125, 2) == 0.13
    assert round_half_up(2.675, 2) == 2.68
    assert round_half_up(10.005, 2) == 10.01
