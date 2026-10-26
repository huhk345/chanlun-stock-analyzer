"""K-line utilities shared by the data layer, cache and API.

Ported from ``src/utils/klineUtils.ts``: sanitising, merge-by-date, TickFlow
column parsing, Beijing-time trading-day maths and the unified data window.
"""

from __future__ import annotations

import datetime as _dt
import math
import re
import time
from typing import Any, Dict, List, Optional, Sequence

from .models import Kline

#: 服务端统一数据窗口起始日 (缓存 / 扫描 / 回测 / HTTP 一致)
KLINE_START_DATE = "2023-01-01"

CHINA_OFFSET_SECONDS = 8 * 3600
DAY_SECONDS = 86400


def sanitize_klines(klines: Sequence[Kline]) -> List[Kline]:
    """Fix bars whose high/low crossed open/close (dirty upstream data)."""
    out: List[Kline] = []
    for k in klines:
        out.append(
            Kline(
                date=k.date,
                open=k.open,
                high=max(k.open, k.high, k.low, k.close),
                low=min(k.open, k.high, k.low, k.close),
                close=k.close,
                volume=k.volume,
                amount=k.amount,
            )
        )
    return out


def merge_klines_by_date(prev: Sequence[Kline], nxt: Sequence[Kline]) -> List[Kline]:
    """Merge by date (new wins), returned ascending."""
    by_date: Dict[str, Kline] = {k.date: k for k in prev}
    for k in nxt:
        by_date[k.date] = k
    return [by_date[d] for d in sorted(by_date)]


def parse_tickflow_columns(data: Dict[str, Any]) -> List[Kline]:
    """TickFlow columnar payload -> Kline[] (timestamps normalised to Beijing)."""
    timestamps = data.get("timestamp") or []
    length = len(timestamps)
    out: List[Kline] = []
    for i in range(length):
        ts = float(timestamps[i]) / 1000.0 if float(timestamps[i]) > 1e11 else float(timestamps[i])
        moment = _dt.datetime.fromtimestamp(ts, tz=_dt.timezone.utc) + _dt.timedelta(
            seconds=CHINA_OFFSET_SECONDS
        )
        date_str = moment.strftime("%Y-%m-%d")
        opens = data.get("open") or []
        highs = data.get("high") or []
        lows = data.get("low") or []
        closes = data.get("close") or []
        volumes = data.get("volume") or []
        amounts = data.get("amount") or []
        out.append(
            Kline(
                date=date_str,
                open=round(float(opens[i]), 2),
                high=round(float(highs[i]), 2),
                low=round(float(lows[i]), 2),
                close=round(float(closes[i]), 2),
                volume=float(volumes[i]) if i < len(volumes) else 0.0,
                amount=float(amounts[i]) if i < len(amounts) else 0.0,
            )
        )
    return out


def extract_rate_limit_delay(text: str) -> Optional[int]:
    """Parse "请 1500ms 后重试" / "请 1.5 秒后重试" into milliseconds."""
    ms_match = re.search(r"请\s*(\d+)\s*ms\s*后重试", text)
    if ms_match:
        return int(ms_match.group(1))
    sec_match = re.search(r"请\s*(\d+(?:\.\d+)?)\s*秒?\s*后重试", text)
    if sec_match:
        return math.ceil(float(sec_match.group(1)) * 1000)
    return None


# ---------------------------------------------------------------------------
# 交易日 / 新鲜度 (北京时间)
# ---------------------------------------------------------------------------


def days_between(start: str, end: str) -> int:
    d1 = _dt.date.fromisoformat(start[:10])
    d2 = _dt.date.fromisoformat(end[:10])
    return (d2 - d1).days


def expected_trade_day_at(timestamp_ms: Optional[float] = None) -> str:
    """Expected latest trading day (Beijing time, holidays ignored).

    Before 16:00 the current day's daily bar does not exist yet, so fall back to
    the previous weekday; weekends roll back to Friday.
    """
    if timestamp_ms is None:
        timestamp_ms = time.time() * 1000
    moment = _dt.datetime.fromtimestamp(timestamp_ms / 1000.0, tz=_dt.timezone.utc) + _dt.timedelta(
        seconds=CHINA_OFFSET_SECONDS
    )
    if moment.hour < 16:
        moment -= _dt.timedelta(days=1)
    weekday = moment.weekday()  # Monday == 0
    if weekday == 6:  # Sunday
        moment -= _dt.timedelta(days=2)
    elif weekday == 5:  # Saturday
        moment -= _dt.timedelta(days=1)
    return moment.date().isoformat()


def expected_trade_day() -> str:
    return expected_trade_day_at()


def is_fresh(last_date: Optional[str], period: str) -> bool:
    if not last_date:
        return False
    expected = expected_trade_day()
    if period == "1w":
        return days_between(last_date, expected) <= 7
    return last_date >= expected


def estimate_bars_since(start_date: str, period: str, end_date: Optional[str] = None) -> int:
    """Approximate bar count between two dates (holidays ignored, with buffer)."""
    if end_date is None:
        end_date = expected_trade_day()
    days = max(0, days_between(start_date, end_date))
    if period == "1w":
        return math.ceil(days / 7) + 2
    return math.ceil(days * 5 / 7) + 10
