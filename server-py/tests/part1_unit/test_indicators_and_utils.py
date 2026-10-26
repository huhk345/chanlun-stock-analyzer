"""Part 1 — unit tests for indicator snapshots and K-line utilities."""

from __future__ import annotations

import datetime as dt

import pytest

from chanlun_server.indicators import atr, bollinger, compute_indicator_values, macd, rsi, sma
from chanlun_server.kline_utils import (
    KLINE_START_DATE,
    days_between,
    estimate_bars_since,
    expected_trade_day_at,
    is_fresh,
    merge_klines_by_date,
    parse_tickflow_columns,
    sanitize_klines,
)
from chanlun_server.models import Kline
from conftest import make_klines, ramp_klines, wave_klines

pytestmark = pytest.mark.unit


# ---------------------------------------------------------------------------
# 指标
# ---------------------------------------------------------------------------


def test_sma_of_ramp_is_the_window_midpoint():
    bars = ramp_klines(40, 100.0, 1.0)  # close[i] = 100 + i
    assert sma(bars, 20, 39) == pytest.approx(129.5)
    assert sma(bars, 20, 18) is None  # not enough history


def test_bollinger_uses_population_std_and_2_decimal_rounding():
    bars = ramp_klines(40, 100.0, 1.0)
    band = bollinger(bars, 39)
    assert band is not None
    assert band["middle"] == pytest.approx(129.5)
    # variance of 20 consecutive integers = 33.25, sd = 5.766281297...
    assert band["upper"] == pytest.approx(141.03)
    assert band["lower"] == pytest.approx(117.97)


def test_macd_histogram_is_twice_dif_minus_dea():
    bars = wave_klines(120)
    values = macd(bars, 119)
    assert values is not None
    assert values["histogram"] == pytest.approx((values["dif"] - values["dea"]) * 2)
    assert macd(bars, 10) is None  # fewer than 26 bars


def test_macd_is_positive_in_an_uptrend():
    bars = ramp_klines(80, 100.0, 1.0)
    values = macd(bars, 79)
    assert values is not None and values["dif"] > 0


def test_rsi_is_100_for_a_monotone_rise():
    bars = ramp_klines(40, 100.0, 1.0)
    assert rsi(bars, 39) == pytest.approx(100.0)
    assert rsi(bars, 5) is None


def test_rsi_is_50_for_a_flat_series():
    bars = [Kline(date=f"2024-01-{i + 1:02d}", open=10, high=10, low=10, close=10) for i in range(20)]
    assert rsi(bars, 19) == pytest.approx(50.0)


def test_atr_of_constant_range_is_that_range():
    bars = ramp_klines(40, 100.0, 1.0)  # high-low = 3 on every bar
    assert atr(bars, 39) == pytest.approx(3.0)


def test_indicator_values_only_expose_ready_periods():
    bars = ramp_klines(30, 100.0, 1.0)
    early = compute_indicator_values([], "600000.SH", bars[:10], 9)
    assert "MA5" in early and "MA20" not in early
    assert "MACD_DIF" not in early

    late = compute_indicator_values([], "600000.SH", bars, 29)
    assert {"MA5", "MA10", "MA20", "BOLL_UP", "MACD_DIF", "MACD_DEA", "MACD"} <= set(late)
    assert "MA60" not in late  # only 30 bars


def test_indicator_snapshot_is_causal():
    """A snapshot must not change when future bars are appended."""
    bars = wave_klines(120)
    before = compute_indicator_values([], "600000.SH", bars[:80], 79)
    after = compute_indicator_values([], "600000.SH", bars, 79)
    assert before == after


# ---------------------------------------------------------------------------
# K 线工具
# ---------------------------------------------------------------------------


def test_sanitize_fixes_crossed_high_low():
    bars = [Kline(date="2024-01-01", open=10, high=9, low=11, close=10.5)]
    fixed = sanitize_klines(bars)[0]
    assert fixed.high == 11
    assert fixed.low == 9


def test_merge_by_date_prefers_new_values_and_sorts():
    old = [
        Kline(date="2024-01-02", open=2, high=2, low=2, close=2),
        Kline(date="2024-01-01", open=1, high=1, low=1, close=1),
    ]
    new = [Kline(date="2024-01-02", open=9, high=9, low=9, close=9)]
    merged = merge_klines_by_date(old, new)
    assert [k.date for k in merged] == ["2024-01-01", "2024-01-02"]
    assert merged[1].close == 9


def test_days_between_uses_calendar_days():
    assert days_between("2024-01-01", "2024-01-11") == 10
    assert days_between("2024-01-11", "2024-01-01") == -10


@pytest.mark.parametrize(
    "beijing_moment,expected",
    [
        # Saturday 10:00 -> before close -> Friday
        (dt.datetime(2024, 1, 6, 10, 0, tzinfo=dt.timezone(dt.timedelta(hours=8))), "2024-01-05"),
        # Sunday 20:00 -> weekend -> Friday
        (dt.datetime(2024, 1, 7, 20, 0, tzinfo=dt.timezone(dt.timedelta(hours=8))), "2024-01-05"),
        # Monday 10:00 -> bar not closed yet -> Friday
        (dt.datetime(2024, 1, 8, 10, 0, tzinfo=dt.timezone(dt.timedelta(hours=8))), "2024-01-05"),
        # Monday 17:00 -> Monday's bar exists
        (dt.datetime(2024, 1, 8, 17, 0, tzinfo=dt.timezone(dt.timedelta(hours=8))), "2024-01-08"),
    ],
)
def test_expected_trade_day_matches_beijing_session_clock(beijing_moment, expected):
    assert expected_trade_day_at(beijing_moment.timestamp() * 1000) == expected


def test_is_fresh_compares_against_expected_day():
    today = expected_trade_day_at()
    assert is_fresh(today, "1d")
    assert not is_fresh("2020-01-02", "1d")
    assert is_fresh("2020-01-02", "1w") is False
    assert not is_fresh(None, "1d")


def test_estimate_bars_since_grows_with_window():
    daily = estimate_bars_since(KLINE_START_DATE, "1d", "2024-01-01")
    weekly = estimate_bars_since(KLINE_START_DATE, "1w", "2024-01-01")
    assert daily > weekly > 0


def test_parse_tickflow_columns_normalises_to_beijing_dates():
    payload = {
        "timestamp": [1704124800000],  # 2024-01-01T16:00Z == 2024-01-02 00:00 +08
        "open": [10.123],
        "high": [10.987],
        "low": [9.871],
        "close": [10.456],
        "volume": [1000],
        "amount": [10000],
    }
    bars = parse_tickflow_columns(payload)
    assert len(bars) == 1
    assert bars[0].date == "2024-01-02"
    assert bars[0].open == pytest.approx(10.12)
    assert bars[0].close == pytest.approx(10.46)
    assert bars[0].volume == pytest.approx(1000)


def test_make_klines_helper_keeps_ohlc_consistent():
    bars = make_klines([{"date": "2024-01-01", "open": 10, "high": 11, "low": 9, "close": 10.5}])
    assert bars[0].high >= bars[0].close >= bars[0].low
