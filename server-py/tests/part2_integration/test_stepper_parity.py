"""Part 2 — the stepper must be a faithful, navigable view of the same engine."""

from __future__ import annotations

import pytest

from chanlun_server.runner import run_backtest
from chanlun_server.stepper import BacktestStepper
from conftest import wave_klines

pytestmark = pytest.mark.integration

SYMBOL = "600000.SH"


def _strip(trade):
    return (
        trade.date,
        trade.type,
        round(trade.price, 8),
        trade.shares,
        round(trade.value, 8),
        round(trade.fee, 8),
        trade.signal_type,
    )


def _stepper(klines, strategy, **kwargs) -> BacktestStepper:
    return BacktestStepper(
        klines=klines,
        symbol=SYMBOL,
        strategy=strategy,
        initial_cash=kwargs.pop("initial_cash", 100_000.0),
        **kwargs,
    )


def test_run_all_matches_batch_runner(make_probe):
    bars = wave_klines(180, seed=5.0)
    strategy = make_probe([10, 50, 100], [30, 70, 140])

    batch = run_backtest(
        klines=bars, symbol=SYMBOL, strategy=strategy, initial_cash=100_000, stop_loss_percent=9
    )

    stepper = _stepper(bars, strategy, stop_loss_percent=9)
    stepper.start()
    stepped = stepper.run_all()

    assert [ _strip(t) for t in stepped.result.trades] == [_strip(t) for t in batch.result.trades]
    assert stepped.result.final_balance == pytest.approx(batch.result.final_balance, abs=1e-6)
    assert stepped.result.total_trades == batch.result.total_trades
    assert len(stepped.equity_curve) == len(batch.equity_curve)


def test_step_state_shape_matches_frontend_contract(make_probe):
    bars = wave_klines(30)
    stepper = _stepper(bars, make_probe([5], [10]))
    state = stepper.start().to_dict()

    assert set(state) == {
        "currentStepIndex",
        "totalSteps",
        "currentKline",
        "decision",
        "accountBefore",
        "accountAfter",
        "positionBefore",
        "positionAfter",
        "tradesExecuted",
        "indicatorSnapshot",
        "chanlunSnapshot",
        "diagnostics",
        "isFinished",
    }
    assert state["currentStepIndex"] == 0
    assert state["totalSteps"] == len(bars)
    assert state["currentKline"]["date"] == bars[0].date
    assert set(state["accountAfter"]) == {"initialCash", "cash", "equity", "currency"}
    assert state["isFinished"] is False


def test_forward_then_backward_restores_identical_state(make_probe):
    bars = wave_klines(60, seed=6.0)
    stepper = _stepper(bars, make_probe([5, 20], [10, 30]), stop_loss_percent=10)
    stepper.start()
    stepper.step_forward()
    second = stepper.step_forward()
    third = stepper.step_forward()

    back = stepper.step_backward()
    assert back.current_step_index == 2
    assert back.account_after.to_dict() == second.account_after.to_dict()
    assert back.position_after.to_dict() == second.position_after.to_dict()

    forward_again = stepper.step_forward()
    assert forward_again.current_step_index == 3
    assert forward_again.account_after.to_dict() == third.account_after.to_dict()


def test_jump_matches_incremental_stepping(make_probe):
    bars = wave_klines(60, seed=7.0)
    strategy = make_probe([5, 20], [10, 30])

    jumper = _stepper(bars, strategy)
    jumper.start()
    jumped = jumper.jump_to(25)

    walker = _stepper(bars, strategy)
    walker.start()
    for _ in range(25):
        walked = walker.step_forward()

    assert jumped.current_step_index == 25
    assert jumped.account_after.to_dict() == walked.account_after.to_dict()
    assert jumped.position_after.to_dict() == walked.position_after.to_dict()


def test_jump_backwards_then_run_all_equals_fresh_run(make_probe):
    bars = wave_klines(80, seed=8.0)
    strategy = make_probe([5, 25], [15, 45])

    navigated = _stepper(bars, strategy, stop_loss_percent=8)
    navigated.start()
    navigated.jump_to(40)
    navigated.jump_to(12)
    navigated.jump_to(55)
    navigated.step_backward()
    navigated_result = navigated.run_all()

    fresh = _stepper(bars, strategy, stop_loss_percent=8)
    fresh.start()
    fresh_result = fresh.run_all()

    assert [_strip(t) for t in navigated_result.result.trades] == [
        _strip(t) for t in fresh_result.result.trades
    ]
    assert navigated_result.result.final_balance == pytest.approx(fresh_result.result.final_balance)


def test_trades_endpoint_reflects_progress(make_probe):
    bars = wave_klines(40)
    stepper = _stepper(bars, make_probe([5], [15]))
    stepper.start()
    assert stepper.get_trades() == []

    stepper.jump_to(6)
    assert len(stepper.get_trades()) == 1
    stepper.jump_to(20)
    assert len(stepper.get_trades()) == 2

    # rewinding must shrink the ledger back to that point in time
    stepper.jump_to(3)
    assert stepper.get_trades() == []


def test_stepper_handles_empty_klines(make_probe):
    stepper = _stepper([], make_probe([0], [1]))
    state = stepper.start()
    assert state.current_step_index == -1
    assert state.is_finished is True
    assert state.current_kline is None

    output = stepper.run_all()
    assert output.result.total_trades == 0
