"""Part 1 — unit tests for wire models and the user-strategy sandbox."""

from __future__ import annotations

import pytest

from chanlun_server.models import (
    Account,
    Amount,
    Decision,
    Kline,
    Position,
    Trade,
    decision_from_raw,
    klines_from_raw,
)
from chanlun_server.sandbox import SandboxError, build_user_strategy, compile_user_code
from chanlun_server.strategies import StrategyContext
from conftest import ramp_klines

pytestmark = pytest.mark.unit


# ---------------------------------------------------------------------------
# 模型序列化 (camelCase 契约)
# ---------------------------------------------------------------------------


def test_kline_roundtrip_keeps_all_fields():
    raw = {
        "date": "2024-01-02",
        "open": 10.0,
        "high": 11.0,
        "low": 9.5,
        "close": 10.5,
        "volume": 1234.0,
        "amount": 12957.0,
    }
    assert Kline.from_dict(raw).to_dict() == raw


def test_klines_from_raw_rejects_missing_fields():
    with pytest.raises(ValueError):
        klines_from_raw([{"date": "2024-01-02", "open": 1}])
    with pytest.raises(ValueError):
        klines_from_raw("not a list")


def test_account_and_position_use_camel_case_keys():
    account = Account(100_000, 90_000, 99_000, "CNY").to_dict()
    assert account == {"initialCash": 100000, "cash": 90000, "equity": 99000, "currency": "CNY"}

    position = Position(100, 10.0, 1000.0, 0.0, 0.0).to_dict()
    assert set(position) == {
        "shares",
        "averageCost",
        "marketValue",
        "unrealizedPnl",
        "unrealizedPnlPercent",
    }


def test_trade_omits_absent_optional_fields():
    trade = Trade(id="t1", type="BUY", signal_type="ma-cross", price=10, date="2024-01-01", shares=100, value=1000)
    payload = trade.to_dict()
    assert "pnl" not in payload and "reason" not in payload
    assert payload["signalType"] == "ma-cross"


def test_decision_normalises_dict_amount():
    decision = Decision(action="buy", amount={"unit": "percent", "value": 50})
    assert decision.action == "BUY"
    assert isinstance(decision.amount, Amount)
    assert decision.amount.value == 50


@pytest.mark.parametrize(
    "raw,expected",
    [
        (None, "HOLD"),
        ({}, "HOLD"),
        ({"action": "BUY"}, "BUY"),
        ({"action": "SELL", "amount": {"unit": "shares", "value": 100}}, "SELL"),
        ("garbage", "HOLD"),
    ],
)
def test_decision_from_raw_never_raises(raw, expected):
    assert decision_from_raw(raw).action == expected


def test_decision_from_raw_keeps_score_and_confidence():
    decision = decision_from_raw({"action": "HOLD", "score": 42.5, "confidence": 0.7})
    assert decision.score == pytest.approx(42.5)
    assert decision.confidence == pytest.approx(0.7)


# ---------------------------------------------------------------------------
# 沙箱
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "code",
    [
        "import os\ndef decide(ctx):\n    return None\n",
        "from pathlib import Path\n",
        "def decide(ctx):\n    return open('/etc/passwd').read()\n",
        "def decide(ctx):\n    return ctx.__class__.__mro__\n",
        "def decide(ctx):\n    return getattr(ctx, 'klines')\n",
        "def decide(ctx):\n    global X\n",
        "class Evil:\n    pass\n",
    ],
)
def test_sandbox_rejects_dangerous_code(code):
    with pytest.raises(SandboxError):
        compile_user_code(code)


def test_sandbox_requires_decide_function():
    with pytest.raises(SandboxError):
        compile_user_code("x = 1\n")


def test_sandbox_rejects_syntax_errors():
    with pytest.raises(SandboxError):
        compile_user_code("def decide(ctx)\n    return None\n")


def test_sandbox_runs_a_simple_strategy():
    code = """
def decide(ctx):
    if ctx.position.shares == 0 and ctx.current_index == 3:
        return {"action": "BUY", "amount": {"unit": "percent", "value": 100}, "reason": "sandbox"}
    return None
"""
    decide = compile_user_code(code)
    bars = ramp_klines(10)
    ctx = StrategyContext(
        symbol="600000.SH",
        timeframe="daily",
        klines=bars,
        current_index=3,
        current_kline=bars[3],
        account=Account(100_000, 100_000, 100_000, "CNY"),
        position=Position(),
        trades=[],
        params={},
        currency="CNY",
        initial_cash=100_000,
    )
    decision = decide(ctx)
    assert decision.action == "BUY"
    assert decision.amount is not None and decision.amount.unit == "percent"

    ctx.current_index = 4
    ctx.current_kline = bars[4]
    assert decide(ctx).action == "HOLD"


def test_sandbox_strategy_is_marked_as_user_source():
    strategy = build_user_strategy(
        "my-strategy",
        "My Strategy",
        "def decide(ctx):\n    return {'action': 'HOLD'}\n",
        description="demo",
    )
    assert strategy.source == "user"
    assert strategy.summary()["source"] == "user"
    assert "decide" not in strategy.summary()


def test_sandbox_blocks_dunder_attribute_writes():
    with pytest.raises(SandboxError):
        compile_user_code("def decide(ctx):\n    ctx.__dict__['x'] = 1\n")
