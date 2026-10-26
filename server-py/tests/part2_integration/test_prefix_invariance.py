"""Part 2 — no look-ahead: prefix invariance and golden real-data parity.

Prefix invariance is the standard detector for future data. Running a backtest on
``klines[:cut+1]`` must reproduce, trade for trade and bar for bar, what the full
run did up to that date. If any layer (strategy, indicators, ChanLun, engine)
peeks at bar ``cut + 1``, the truncated run diverges.

The second half replays a recorded real-data fixture whose expected ledger was
produced by the original TypeScript engine, so a regression in either the
algorithm port or the fill model shows up immediately.
"""

from __future__ import annotations

import json
import pathlib
from typing import List

import pytest

from chanlun_server.models import Kline
from chanlun_server.runner import run_backtest
from chanlun_server.strategies import find_strategy
from conftest import wave_klines

pytestmark = pytest.mark.integration

FIXTURES = pathlib.Path(__file__).resolve().parents[1] / "fixtures"
SYMBOL = "300750.SZ"


def _strip(trade):
    return (
        trade.date,
        trade.type,
        round(trade.price, 6),
        trade.shares,
        round(trade.value, 6),
        round(trade.fee, 6),
        trade.signal_type,
    )


def _run(klines: List[Kline], strategy_id: str, stop_loss=None):
    return run_backtest(
        klines=klines,
        symbol=SYMBOL,
        strategy=find_strategy(strategy_id),
        initial_cash=100_000.0,
        stop_loss_percent=stop_loss,
    )


def _load_fixture() -> List[Kline]:
    raw = json.loads((FIXTURES / "klines_300750_1d.json").read_text(encoding="utf-8"))
    return [Kline.from_dict(item) for item in raw["klines"]]


# ---------------------------------------------------------------------------
# 前缀不变性 — 合成数据 (快, 覆盖所有内置策略)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("strategy_id", ["ma-cross", "macd-trend", "chanlun-weekly-daily-thermometer"])
@pytest.mark.parametrize("stop_loss", [None, 8.0])
def test_prefix_invariance_on_synthetic_series(strategy_id, stop_loss):
    klines = wave_klines(260, seed=9.0)
    full = _run(klines, strategy_id, stop_loss)

    for ratio in (0.45, 0.65, 0.85):
        cut = int(len(klines) * ratio)
        prefix = _run(klines[: cut + 1], strategy_id, stop_loss)
        cutoff_date = klines[cut].date

        expected = [_strip(t) for t in full.result.trades if t.date <= cutoff_date]
        actual = [_strip(t) for t in prefix.result.trades]
        assert actual == expected, f"{strategy_id} cut={cut} ({cutoff_date}) diverged"

        assert prefix.result.final_balance == pytest.approx(full.equity_curve[cut], abs=1e-6)
        assert prefix.result.final_balance == pytest.approx(prefix.equity_curve[-1], abs=1e-6)


# ---------------------------------------------------------------------------
# 真实行情 fixture — 与 TypeScript 引擎逐笔一致
# ---------------------------------------------------------------------------


def test_real_data_ledger_matches_typescript_golden():
    klines = _load_fixture()
    golden = json.loads(
        (FIXTURES / "golden_300750_thermometer.json").read_text(encoding="utf-8")
    )
    output = _run(klines, "chanlun-weekly-daily-thermometer")

    assert [_strip(t) for t in output.result.trades] == [tuple(row) for row in golden["trades"]]
    assert output.result.final_balance == pytest.approx(golden["finalBalance"], abs=1e-6)
    assert len(output.equity_curve) == golden["equityLen"]
    assert output.result.total_trades == golden["total"] == 6


def test_real_data_prefix_invariance():
    """Meaningful look-ahead check: the fixture actually produces trades."""
    klines = _load_fixture()
    full = _run(klines, "chanlun-weekly-daily-thermometer")

    trade_dates = [t.date for t in full.result.trades]
    assert trade_dates, "fixture must contain trades for this test to mean anything"

    # cut right before a later trade so the prefix must not know about it
    cuts = sorted({klines.index(next(k for k in klines if k.date == d)) - 1 for d in trade_dates[1:]})
    for cut in cuts:
        cut = max(cut, 30)
        prefix = _run(klines[: cut + 1], "chanlun-weekly-daily-thermometer")
        cutoff_date = klines[cut].date

        expected = [_strip(t) for t in full.result.trades if t.date <= cutoff_date]
        assert [_strip(t) for t in prefix.result.trades] == expected
        assert prefix.result.final_balance == pytest.approx(full.equity_curve[cut], abs=1e-6)


def test_real_data_with_stop_loss_is_still_causal():
    klines = _load_fixture()
    full = _run(klines, "chanlun-weekly-daily-thermometer", stop_loss=10.0)
    for ratio in (0.5, 0.75):
        cut = int(len(klines) * ratio)
        prefix = _run(klines[: cut + 1], "chanlun-weekly-daily-thermometer", stop_loss=10.0)
        cutoff_date = klines[cut].date
        expected = [_strip(t) for t in full.result.trades if t.date <= cutoff_date]
        assert [_strip(t) for t in prefix.result.trades] == expected


def test_appending_future_bars_never_rewrites_history():
    """Explicit version of the same property: grow the series bar by bar."""
    klines = _load_fixture()[:420]
    base = _run(klines[:300], "chanlun-weekly-daily-thermometer")
    grown = _run(klines, "chanlun-weekly-daily-thermometer")

    cutoff = klines[299].date
    assert [_strip(t) for t in base.result.trades] == [
        _strip(t) for t in grown.result.trades if t.date <= cutoff
    ]
