"""Part 2 — K-line cache: freshness, incremental merge, ex-rights refresh."""

from __future__ import annotations

import datetime as dt
import json
import threading
import time

import pytest

from chanlun_server import klines as klines_module
from chanlun_server.kline_utils import KLINE_START_DATE, expected_trade_day
from chanlun_server.klines import (
    adjustment_changed,
    compute_fetch_count,
    get_klines,
    is_fetch_complete,
    read_cache,
    write_cache,
)
from chanlun_server.models import Kline
from conftest import seed_cache, wave_klines

pytestmark = pytest.mark.integration

SYMBOL = "000001.SZ"


def series_ending(days_before_expected: int) -> list[Kline]:
    """Consecutive bars ending ``days_before_expected`` days before the expected day."""
    end = dt.date.fromisoformat(expected_trade_day()) - dt.timedelta(days=days_before_expected)
    start = dt.date.fromisoformat(KLINE_START_DATE)
    n = (end - start).days + 1
    return wave_klines(n, start=start)


def scaled(bars, factor: float):
    return [
        Kline(
            date=k.date,
            open=k.open * factor,
            high=k.high * factor,
            low=k.low * factor,
            close=k.close * factor,
            volume=k.volume,
            amount=k.amount,
        )
        for k in bars
    ]


# ---------------------------------------------------------------------------
# 读写
# ---------------------------------------------------------------------------


def test_write_then_read_roundtrip(tmp_cache):
    bars = wave_klines(50)
    updated_at = write_cache(SYMBOL, "1d", "forward", bars, True)
    cache = read_cache(SYMBOL, "1d", "forward")

    assert cache is not None
    assert cache.updated_at == pytest.approx(updated_at)
    assert cache.history_complete is True
    assert [k.date for k in cache.klines] == [k.date for k in bars]
    assert cache.klines[0].close == pytest.approx(bars[0].close)


def test_corrupt_cache_is_ignored(tmp_cache):
    (tmp_cache / f"{SYMBOL}_1d_forward.json").write_text("{not json", encoding="utf-8")
    assert read_cache(SYMBOL, "1d", "forward") is None


def test_cache_file_is_valid_json(tmp_cache):
    write_cache(SYMBOL, "1d", "forward", wave_klines(10), False)
    raw = json.loads((tmp_cache / f"{SYMBOL}_1d_forward.json").read_text(encoding="utf-8"))
    assert raw["symbol"] == SYMBOL
    assert raw["historyComplete"] is False
    assert len(raw["klines"]) == 10


# ---------------------------------------------------------------------------
# 新鲜度
# ---------------------------------------------------------------------------


def test_fresh_cache_skips_the_network(tmp_cache, offline_fetch):
    bars = series_ending(0)
    seed_cache(tmp_cache, SYMBOL, bars)

    result = get_klines(SYMBOL, "1d", 400)
    assert result.cached is True
    assert offline_fetch["calls"] == []
    assert result.klines[-1].date == bars[-1].date


def test_verified_today_short_circuits_stale_cache(tmp_cache, offline_fetch):
    """A symbol whose data was verified after the close is not re-fetched."""
    bars = series_ending(3)
    seed_cache(tmp_cache, SYMBOL, bars, updated_at_ms=time.time() * 1000)

    result = get_klines(SYMBOL, "1d", 400)
    assert result.cached is True
    assert offline_fetch["calls"] == []


# ---------------------------------------------------------------------------
# 增量
# ---------------------------------------------------------------------------


def test_incremental_fetch_merges_new_bars(tmp_cache, offline_fetch):
    full = series_ending(0)
    cached_bars = full[:-3]
    seed_cache(
        tmp_cache,
        SYMBOL,
        cached_bars,
        updated_at_ms=(time.time() - 3 * 86400) * 1000,
    )
    offline_fetch["bars"] = full

    result = get_klines(SYMBOL, "1d", 400)
    calls = offline_fetch["calls"]

    assert len(calls) == 1
    assert calls[0][2] == 30  # 30-bar incremental window
    assert result.cached is False
    assert len(result.klines) == len(full)
    assert result.klines[-1].date == full[-1].date


def test_ex_rights_mismatch_triggers_full_refresh(tmp_cache, offline_fetch):
    full = series_ending(0)
    stale = scaled(full[:-3], 0.9)  # different adjustment basis on the overlap
    seed_cache(tmp_cache, SYMBOL, stale, updated_at_ms=(time.time() - 3 * 86400) * 1000)
    offline_fetch["bars"] = full

    result = get_klines(SYMBOL, "1d", 400)
    calls = offline_fetch["calls"]

    assert len(calls) == 2, "incremental fetch followed by a full refresh"
    assert calls[1][2] > calls[0][2]
    # The cache must be replaced wholesale: every returned bar carries the fresh
    # (post-adjustment) price, not the stale 0.9x overlap.
    for bar in result.klines:
        reference = next(k for k in full if k.date == bar.date)
        assert bar.close == pytest.approx(reference.close)
    assert result.klines[-1].close == pytest.approx(full[-1].close)


def test_cache_not_covering_window_is_backfilled(tmp_cache, offline_fetch):
    bars = wave_klines(120, start=dt.date(2025, 1, 2))
    seed_cache(tmp_cache, SYMBOL, bars, history_complete=False)
    offline_fetch["bars"] = series_ending(0)

    get_klines(SYMBOL, "1d", 400)
    calls = offline_fetch["calls"]
    assert len(calls) == 1
    assert calls[0][2] > 500, "should request the whole 2023-01-01 window"


# ---------------------------------------------------------------------------
# 纯函数
# ---------------------------------------------------------------------------


def test_compute_fetch_count_forces_window_when_incomplete():
    bars = wave_klines(50)
    assert compute_fetch_count(bars, "1d", 900, False, False) == 900
    assert compute_fetch_count(bars, "1d", 900, True, True) == 900


def test_compute_fetch_count_keeps_an_overlap_window():
    bars = series_ending(0)
    count = compute_fetch_count(bars, "1d", 900, False, True)
    assert count == 30  # already current: refresh the tail plus overlap


def test_is_fetch_complete_uses_window_start_and_short_responses():
    full = series_ending(0)
    # fewer bars than requested -> upstream has no more history
    assert is_fetch_complete(full[-10:], len(full)) is True
    # same count as requested but starting after the window -> not complete
    partial = full[100:]
    assert is_fetch_complete(partial, len(partial)) is False
    assert is_fetch_complete([], 10) is False


def test_adjustment_changed_detects_price_drift():
    bars = series_ending(5)
    assert adjustment_changed(bars, bars) is False
    assert adjustment_changed(bars, scaled(bars, 0.9)) is True
    assert adjustment_changed(bars, bars[-3:]) is False
    future = wave_klines(3, start=dt.date(2030, 1, 1))
    assert adjustment_changed(bars, future) is None


# ---------------------------------------------------------------------------
# 并发去重
# ---------------------------------------------------------------------------


def test_concurrent_requests_share_one_fetch(tmp_cache, monkeypatch):
    full = series_ending(0)
    calls = []

    def slow_fetch(symbol, period, count, adjust):
        calls.append(count)
        time.sleep(0.15)
        return [Kline(**k.to_dict()) for k in full[-count:]]

    monkeypatch.setattr(klines_module, "fetch_klines", slow_fetch)
    klines_module.clear_memory_state()

    results = {}

    def worker(name):
        results[name] = get_klines(SYMBOL, "1d", 400)

    threads = [threading.Thread(target=worker, args=(f"t{i}",)) for i in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=10)

    assert len(results) == 4
    assert len(calls) == 1, f"expected a single upstream request, got {calls}"
    lengths = {len(r.klines) for r in results.values()}
    assert len(lengths) == 1, f"all callers must see the same window, got {lengths}"
    assert all(r.klines[-1].date == full[-1].date for r in results.values())
