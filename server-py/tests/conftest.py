"""Shared fixtures for the three test parts.

The suite is deliberately offline: every test that needs K-lines either builds
them synthetically or pre-seeds the on-disk cache, so `pytest` never depends on
market data being reachable. Tests that *do* want the network are marked
``live`` and skipped unless ``--live`` is passed.
"""

from __future__ import annotations

import datetime as dt
import json
import math
import pathlib
import sys
from typing import Callable, Dict, List, Sequence

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from chanlun_server.kline_utils import KLINE_START_DATE, expected_trade_day  # noqa: E402
from chanlun_server.models import Decision, Kline  # noqa: E402
from chanlun_server.strategies import Strategy  # noqa: E402


# ---------------------------------------------------------------------------
# 合成 K 线
# ---------------------------------------------------------------------------


def make_klines(
    specs: Sequence[Dict[str, float | str]],
    volume: float = 100_000.0,
) -> List[Kline]:
    """Build K-lines from explicit OHLC specs (dates must be provided)."""
    out: List[Kline] = []
    for spec in specs:
        close = float(spec["close"])
        out.append(
            Kline(
                date=str(spec["date"]),
                open=float(spec.get("open", close)),
                high=float(spec.get("high", close)),
                low=float(spec.get("low", close)),
                close=close,
                volume=float(spec.get("volume", volume)),
                amount=float(spec.get("amount", close * volume)),
            )
        )
    return out


def day(i: int, base: dt.date = dt.date(2024, 1, 1)) -> str:
    """Deterministic, sortable date string."""
    return (base + dt.timedelta(days=i)).isoformat()


def wave_klines(
    n: int = 400,
    start_price: float = 100.0,
    seed: float = 0.0,
    start: dt.date = dt.date(2023, 1, 2),
) -> List[Kline]:
    """Deterministic pseudo-random walk with trend cycles (no RNG state)."""
    out: List[Kline] = []
    price = start_price
    for i in range(n):
        drift = (
            0.006 * math.sin((i + seed) / 9.0)
            + 0.002 * math.sin((i + seed) / 31.0)
            + 0.0008
        )
        price *= 1 + drift
        open_ = price * 0.995
        close = price
        high = max(open_, close) * 1.006
        low = min(open_, close) * 0.994
        out.append(
            Kline(
                date=day(i, start),
                open=round(open_, 2),
                high=round(high, 2),
                low=round(low, 2),
                close=round(close, 2),
                volume=100_000 + i * 137,
                amount=0.0,
            )
        )
    return out


def ramp_klines(
    n: int = 40, start_price: float = 100.0, step: float = 1.0, start: dt.date = dt.date(2024, 1, 1)
) -> List[Kline]:
    """Monotone ramp — handy for exact arithmetic assertions."""
    out: List[Kline] = []
    for i in range(n):
        close = start_price + i * step
        out.append(
            Kline(
                date=day(i, start),
                open=close,
                high=close + 2,
                low=close - 1,
                close=close,
                volume=100_000,
                amount=close * 100_000,
            )
        )
    return out


@pytest.fixture
def klines_400() -> List[Kline]:
    return wave_klines(400)


@pytest.fixture
def make_probe() -> Callable[[Sequence[int], Sequence[int]], Strategy]:
    """Strategy that buys/sells at explicit bar indices (engine probe)."""

    def factory(buy_at: Sequence[int], sell_at: Sequence[int]) -> Strategy:
        buy = set(buy_at)
        sell = set(sell_at)

        def decide(ctx):
            if ctx.current_index in buy and ctx.position.shares == 0:
                return Decision(
                    action="BUY",
                    amount={"unit": "percent", "value": 100},
                    reason=f"probe buy @{ctx.current_index}",
                )
            if ctx.current_index in sell and ctx.position.shares > 0:
                return Decision(
                    action="SELL",
                    amount={"unit": "percent", "value": 100},
                    reason=f"probe sell @{ctx.current_index}",
                )
            return Decision.hold()

        return Strategy(id="probe", name="Probe", decide=decide)

    return factory


# ---------------------------------------------------------------------------
# 离线数据层
# ---------------------------------------------------------------------------


@pytest.fixture
def tmp_cache(tmp_path, monkeypatch) -> pathlib.Path:
    """Point the K-line cache at a temp dir."""
    from chanlun_server import klines as klines_module

    cache_dir = tmp_path / "klines"
    cache_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(klines_module, "CACHE_DIR", cache_dir)
    klines_module.clear_memory_state()
    return cache_dir


@pytest.fixture
def offline_fetch(monkeypatch) -> Dict[str, object]:
    """Replace the upstream fetcher with a synthetic one.

    The dict is returned so tests can inspect ``calls`` / override ``bars``.
    """
    from chanlun_server import klines as klines_module

    state: Dict[str, object] = {"calls": [], "bars": wave_klines(300)}

    def fake_fetch(symbol: str, period: str, count: int, adjust: str):
        state["calls"].append((symbol, period, count, adjust))  # type: ignore[union-attr]
        bars = state["bars"]  # type: ignore[assignment]
        # Like a real upstream: return everything it has when asked for more.
        window = bars if count >= len(bars) else bars[-count:]
        return [Kline(**k.to_dict()) for k in window]

    monkeypatch.setattr(klines_module, "fetch_klines", fake_fetch)
    return state


def seed_cache(
    cache_dir: pathlib.Path,
    symbol: str,
    klines: Sequence[Kline],
    period: str = "1d",
    adjust: str = "forward",
    history_complete: bool = True,
    updated_at_ms: float | None = None,
) -> pathlib.Path:
    """Write a cache file that the server will treat as fresh."""
    import time

    safe = "".join(
        ch if (ch.isalnum() or ch in "._-") else "_" for ch in f"{symbol}_{period}_{adjust}"
    )
    path = cache_dir / f"{safe}.json"
    payload = {
        "symbol": symbol,
        "period": period,
        "adjust": adjust,
        "updatedAt": updated_at_ms if updated_at_ms is not None else time.time() * 1000,
        "klines": [k.to_dict() for k in klines],
        "historyComplete": history_complete,
    }
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return path


def fresh_klines(n: int = 260) -> List[Kline]:
    """Bars ending at the expected trading day, so the cache counts as fresh."""
    end = dt.date.fromisoformat(expected_trade_day())
    start = end - dt.timedelta(days=n + 30)
    bars = wave_klines(n, start=start)
    # Force the window start to satisfy the 2023-01-01 coverage rule.
    if bars[0].date > KLINE_START_DATE:
        bars[0] = Kline(
            date=KLINE_START_DATE,
            open=bars[0].open,
            high=bars[0].high,
            low=bars[0].low,
            close=bars[0].close,
            volume=bars[0].volume,
            amount=bars[0].amount,
        )
    return bars


@pytest.fixture
def seeded_cache(tmp_cache, monkeypatch) -> Callable[..., pathlib.Path]:
    """Seed the temp cache and forbid network access at the same time."""

    def _no_network(*args, **kwargs):  # pragma: no cover - should never run
        raise AssertionError("network fetch attempted in an offline test")

    from chanlun_server import klines as klines_module

    monkeypatch.setattr(klines_module, "fetch_klines", _no_network)

    def seed(symbol: str = "000001.SZ", klines: Sequence[Kline] | None = None, **kwargs):
        return seed_cache(tmp_cache, symbol, klines or fresh_klines(), **kwargs)

    return seed


# ---------------------------------------------------------------------------
# API helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def api():
    """Call the router in-process: ``api("GET", "/api/health")`` -> (status, body)."""
    from chanlun_server.http_api import handle_request

    def call(method: str, path: str, body=None, query=None):
        return handle_request(method, path, query or {}, body)

    return call


@pytest.fixture(autouse=True)
def _reset_module_state():
    """Keep progress/session/pool state from leaking between tests."""
    from chanlun_server import progress
    from chanlun_server.service import clear_sessions

    progress.clear()
    clear_sessions()
    yield
    progress.clear()
    clear_sessions()


def pytest_addoption(parser):
    parser.addoption("--live", action="store_true", default=False, help="run tests that hit real market data")


def pytest_collection_modifyitems(config, items):
    if config.getoption("--live"):
        return
    skip_live = pytest.mark.skip(reason="需要网络/真实行情, 用 --live 开启")
    for item in items:
        if "live" in item.keywords:
            item.add_marker(skip_live)
