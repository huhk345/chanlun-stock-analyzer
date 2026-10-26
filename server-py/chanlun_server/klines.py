"""K-line data layer: local disk cache + incremental refresh.

Ported from ``server/klines.ts``.

* The unified window is ``KLINE_START_DATE`` (2023-01-01) → latest, so scans,
  single-symbol backtests and pool backtests all see the same range.
* Cache freshness is judged by "last bar date vs expected trading day". If a
  successful fetch did not advance the last bar (suspended/delisted symbol), the
  write time is recorded as "verified through that day" and no further request is
  made for the symbol that day.
* Incremental fetches overlap the cache by a few bars: forward-adjusted prices
  re-scale the whole history on ex-dividend, which is only detectable by
  comparing overlapping bars. A mismatch triggers a full refresh instead of a
  date-based merge (mixing two adjustment bases would corrupt structures).
"""

from __future__ import annotations

import json
import os
import pathlib
import threading
import time
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple

from . import config
from .kline_utils import (
    KLINE_START_DATE,
    days_between,
    estimate_bars_since,
    expected_trade_day,
    expected_trade_day_at,
    is_fresh,
    merge_klines_by_date,
)
from .models import Kline
from .sources import fetch_klines

#: 可被测试覆盖
CACHE_DIR: pathlib.Path = config.CACHE_DIR

#: 增量拉取时额外多取的根数 (与缓存尾部重叠, 用于复权校验)
INCREMENTAL_OVERLAP_BARS = 10

#: 重叠 bar 收盘价相对偏差阈值
ADJUST_MISMATCH_TOLERANCE = config.ADJUST_MISMATCH_TOLERANCE

_inflight: Dict[str, threading.Event] = {}
_inflight_results: Dict[str, Tuple[List[Kline], float]] = {}
_inflight_lock = threading.Lock()


@dataclass(slots=True)
class KlineQueryResult:
    symbol: str
    period: str
    adjust: str
    klines: List[Kline]
    cached: bool
    updated_at: float


@dataclass(slots=True)
class CacheFile:
    symbol: str
    period: str
    adjust: str
    updated_at: float
    klines: List[Kline]
    history_complete: bool


# ---------------------------------------------------------------------------
# 本地缓存
# ---------------------------------------------------------------------------


def cache_file(symbol: str, period: str, adjust: str) -> pathlib.Path:
    safe = "".join(
        ch if (ch.isalnum() or ch in "._-") else "_" for ch in f"{symbol}_{period}_{adjust}"
    )
    return CACHE_DIR / f"{safe}.json"


def read_cache(symbol: str, period: str, adjust: str) -> Optional[CacheFile]:
    path = cache_file(symbol, period, adjust)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    klines = raw.get("klines")
    if not isinstance(klines, list) or not klines:
        return None
    try:
        parsed = [Kline.from_dict(item) for item in klines]
    except (KeyError, TypeError, ValueError):
        return None
    return CacheFile(
        symbol=raw.get("symbol", symbol),
        period=raw.get("period", period),
        adjust=raw.get("adjust", adjust),
        updated_at=float(raw.get("updatedAt") or 0.0),
        klines=parsed,
        history_complete=bool(raw.get("historyComplete")),
    )


def write_cache(
    symbol: str,
    period: str,
    adjust: str,
    klines: Sequence[Kline],
    history_complete: bool,
) -> float:
    updated_at = time.time() * 1000
    payload = {
        "symbol": symbol,
        "period": period,
        "adjust": adjust,
        "updatedAt": updated_at,
        "klines": [k.to_dict() for k in klines],
        "historyComplete": history_complete,
    }
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        target = cache_file(symbol, period, adjust)
        tmp = target.with_suffix(f".{os.getpid()}.{threading.get_ident()}.tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        tmp.replace(target)  # atomic on POSIX
    except OSError as exc:  # pragma: no cover - disk issues
        print(f"[klines] 写入缓存失败 {symbol} {period}: {exc}")
    return updated_at


def cache_covers_window(cache: CacheFile) -> bool:
    if cache.history_complete:
        return True
    first = cache.klines[0].date if cache.klines else None
    return bool(first) and first <= KLINE_START_DATE


# ---------------------------------------------------------------------------
# 增量计算
# ---------------------------------------------------------------------------


def compute_fetch_count(
    prev: Sequence[Kline], period: str, window_count: int, force: bool, history_complete: bool
) -> int:
    if force or not prev or not history_complete:
        return window_count
    last = prev[-1].date
    gap_days = days_between(last, expected_trade_day())
    if gap_days <= 0:
        gap_bars = 0
    elif period == "1w":
        gap_bars = -(-gap_days // 7)
    else:
        gap_bars = -(-(gap_days * 5) // 7)
    # Even when already current, fetch a few bars to refresh the last (unclosed)
    # bar and to keep an overlap window for the adjustment check.
    return min(window_count, max(30, gap_bars + INCREMENTAL_OVERLAP_BARS))


def is_fetch_complete(fresh: Sequence[Kline], requested: int) -> bool:
    if not fresh:
        return False
    return fresh[0].date <= KLINE_START_DATE or len(fresh) < requested


def adjustment_changed(prev: Sequence[Kline], fresh: Sequence[Kline]) -> Optional[bool]:
    """``True`` = prices differ (ex-rights), ``False`` = same, ``None`` = no overlap."""
    prev_by_date = {k.date: k for k in prev}
    compared = 0
    for bar in fresh:
        old = prev_by_date.get(bar.date)
        if old is None:
            continue
        compared += 1
        diff = abs(bar.close - old.close)
        tolerance = max(abs(old.close), abs(bar.close)) * ADJUST_MISMATCH_TOLERANCE + 0.005
        if diff > tolerance:
            return True
    return False if compared > 0 else None


# ---------------------------------------------------------------------------
# 主入口
# ---------------------------------------------------------------------------


def get_klines(
    symbol: str,
    period: str = "1d",
    count: int = 400,
    adjust: str = "forward",
    force: bool = False,
) -> KlineQueryResult:
    """Fetch K-lines with disk cache + incremental refresh.

    ``count`` is accepted for backwards compatibility but no longer truncates the
    returned window (which is fixed to ``KLINE_START_DATE`` → latest).
    """
    period = "1w" if period == "1w" else "1d"
    cached = read_cache(symbol, period, adjust)
    cached_window = (
        [k for k in cached.klines if k.date >= KLINE_START_DATE] if cached else []
    )
    last_date = cached_window[-1].date if cached_window else None
    covered = cache_covers_window(cached) if cached else False

    expected = expected_trade_day()
    synced_through = expected_trade_day_at(cached.updated_at) if cached else ""
    up_to_date = is_fresh(last_date, period) or (synced_through >= expected)

    if not force and cached and covered and up_to_date:
        return KlineQueryResult(
            symbol=symbol,
            period=period,
            adjust=adjust,
            klines=cached_window,
            cached=True,
            updated_at=cached.updated_at,
        )

    window_count = estimate_bars_since(KLINE_START_DATE, period)
    key = f"{symbol}|{period}|{adjust}"

    with _inflight_lock:
        event = _inflight.get(key)
        owner = event is None
        if owner:
            event = threading.Event()
            _inflight[key] = event

    if not owner:
        event.wait(timeout=180)  # type: ignore[union-attr]
        with _inflight_lock:
            result = _inflight_results.pop(key, None)
        if result is not None:
            klines, updated_at = result
            return KlineQueryResult(
                symbol=symbol,
                period=period,
                adjust=adjust,
                klines=klines,
                cached=False,
                updated_at=updated_at,
            )
        # Fall back to whatever is on disk if the owner failed.
        cached = read_cache(symbol, period, adjust)
        if cached is None:
            raise RuntimeError(f"获取 {symbol} {period} K 线失败")
        return KlineQueryResult(
            symbol=symbol,
            period=period,
            adjust=adjust,
            klines=[k for k in cached.klines if k.date >= KLINE_START_DATE],
            cached=True,
            updated_at=cached.updated_at,
        )

    try:
        prev = cached.klines if cached else []
        fetch_count = compute_fetch_count(prev, period, window_count, force, covered)
        incremental = bool(prev) and covered and fetch_count < window_count
        mode = (
            f"强制刷新 {fetch_count} 根"
            if force
            else f"增量拉取 {fetch_count} 根"
            if incremental
            else f"全量拉取 {fetch_count} 根"
            if covered
            else f"回补 {KLINE_START_DATE} 窗口 {fetch_count} 根"
        )
        print(f"[klines] {symbol} {period}: {mode}")

        fresh = fetch_klines(symbol, period, fetch_count, adjust)
        replace_cache = False
        history_complete = covered

        if incremental:
            changed = adjustment_changed(prev, fresh)
            if changed is not False:
                full_count = max(window_count, len(prev))
                print(
                    f"[klines] {symbol} {period}: "
                    f"{'重叠区间价格不一致 (疑似除权除息)' if changed else '增量数据与缓存无重叠'}, "
                    f"改为全量刷新 {full_count} 根"
                )
                fresh = fetch_klines(symbol, period, full_count, adjust)
                replace_cache = True
                history_complete = is_fetch_complete(fresh, full_count)
        else:
            history_complete = is_fetch_complete(fresh, fetch_count)

        merged_raw = list(fresh) if replace_cache else merge_klines_by_date(prev, fresh)
        merged = [k for k in merged_raw if k.date >= KLINE_START_DATE]
        updated_at = write_cache(symbol, period, adjust, merged, history_complete)

        with _inflight_lock:
            _inflight_results[key] = (merged, updated_at)
        return KlineQueryResult(
            symbol=symbol,
            period=period,
            adjust=adjust,
            klines=merged,
            cached=False,
            updated_at=updated_at,
        )
    finally:
        with _inflight_lock:
            if _inflight.get(key) is event:
                _inflight.pop(key, None)
        event.set()  # type: ignore[union-attr]


def clear_memory_state() -> None:
    """Test helper: drop in-flight bookkeeping."""
    with _inflight_lock:
        _inflight.clear()
        _inflight_results.clear()
