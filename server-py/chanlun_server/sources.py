"""Upstream K-line providers: Tencent (primary, no key) and TickFlow (fallback).

Ported from ``server/tencentKlines.ts`` and the TickFlow branch of
``server/klines.ts``. Both providers return the same shape (volume in 手 = 100
shares), so the disk cache is portable between them.

Tencent quirks kept on purpose:

* ``web.ifzq.gtimg.cn`` is WAF-blocked server-side (501), so only
  ``ifzq.gtimg.cn`` / ``proxy.finance.qq.com`` are used.
* Sustained ~25 req/s gets a domain banned for minutes → global token bucket
  plus domain rotation with cooldown.
* ``newfqkline`` carries the real turnover (column 9, 万元); ``fqkline`` does
  not, so turnover is estimated from close × volume × 100.
"""

from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .config import TENCENT_RPS, TICKFLOW_API_KEY, TICKFLOW_BASE_URL
from .kline_utils import (
    extract_rate_limit_delay,
    merge_klines_by_date,
    parse_tickflow_columns,
    sanitize_klines,
)
from .models import Kline

TENCENT_HOSTS: Sequence[Tuple[str, bool]] = (
    ("https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get", True),
    ("https://ifzq.gtimg.cn/appstock/app/newfqkline/get", True),
    ("https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get", False),
    ("https://ifzq.gtimg.cn/appstock/app/fqkline/get", False),
)

TX_MAX_BARS = 800
REQUEST_TIMEOUT = 15.0
MAX_RETRIES = 3
HOST_COOLDOWN_SECONDS = 120.0
SHARES_PER_LOT = 100
AMOUNT_UNIT = 10_000.0


class FatalUpstreamError(RuntimeError):
    """Non-retryable: bad symbol or genuinely no data upstream."""


class UpstreamError(RuntimeError):
    """Retryable transport/limit error."""


# ---------------------------------------------------------------------------
# 域名轮换 / 令牌桶
# ---------------------------------------------------------------------------


class _TencentGate:
    def __init__(self, rps: float) -> None:
        self._rps = rps
        self._tokens = rps
        self._last_refill = time.monotonic()
        self._cooldown_until = [0.0 for _ in TENCENT_HOSTS]
        self._cursor = 0
        self._lock = threading.Lock()

    def pick_host(self) -> Tuple[int, str, bool]:
        with self._lock:
            now = time.monotonic()
            for n in range(len(TENCENT_HOSTS)):
                i = (self._cursor + n) % len(TENCENT_HOSTS)
                if self._cooldown_until[i] <= now:
                    self._cursor = (i + 1) % len(TENCENT_HOSTS)
                    base, rich = TENCENT_HOSTS[i]
                    return i, base, rich
            i = min(range(len(self._cooldown_until)), key=lambda k: self._cooldown_until[k])
            base, rich = TENCENT_HOSTS[i]
            return i, base, rich

    def cool_down(self, index: int) -> None:
        with self._lock:
            self._cooldown_until[index] = time.monotonic() + HOST_COOLDOWN_SECONDS

    def acquire(self) -> None:
        while True:
            with self._lock:
                now = time.monotonic()
                self._tokens = min(
                    self._rps, self._tokens + (now - self._last_refill) * self._rps
                )
                self._last_refill = now
                if self._tokens >= 1:
                    self._tokens -= 1
                    return
                wait = (1 - self._tokens) / self._rps
            time.sleep(max(0.001, wait))


_gate = _TencentGate(TENCENT_RPS)


# ---------------------------------------------------------------------------
# 参数转换
# ---------------------------------------------------------------------------


def to_tencent_symbol(symbol: str) -> str:
    """``600519.SH`` -> ``sh600519`` (bare codes pass through)."""
    if "." not in symbol:
        return symbol
    code, _, market = symbol.rpartition(".")
    market = market.upper()
    if market in ("SH", "SS"):
        return f"sh{code}"
    if market == "SZ":
        return f"sz{code}"
    if market == "BJ":
        return f"bj{code}"
    return symbol


def _adjust_suffix(adjust: str) -> str:
    value = (adjust or "forward").lower()
    if value in ("backward", "hfq"):
        return "hfq"
    if value in ("none", "none-adjust", ""):
        return ""
    return "qfq"


def _granularity(period: str) -> str:
    return "week" if period == "1w" else "day"


def _parse_rows(rows: Any) -> List[Kline]:
    if not isinstance(rows, list):
        return []
    out: List[Kline] = []
    for row in rows:
        if not isinstance(row, list) or len(row) < 6:
            continue
        date = str(row[0])
        if len(date) != 10 or date[4] != "-" or date[7] != "-":
            continue
        try:
            open_ = float(row[1])
            close = float(row[2])
            high = float(row[3])
            low = float(row[4])
            volume = float(row[5])
        except (TypeError, ValueError):
            continue
        if close <= 0:
            continue
        real_amount = 0.0
        if len(row) > 8:
            try:
                real_amount = float(row[8])
            except (TypeError, ValueError):
                real_amount = 0.0
        out.append(
            Kline(
                date=date,
                open=open_,
                close=close,
                high=high,
                low=low,
                volume=volume,
                amount=real_amount * AMOUNT_UNIT if real_amount > 0 else close * volume * SHARES_PER_LOT,
            )
        )
    return sanitize_klines(out)


def _extract_rows(payload: Any, tx_symbol: str, granularity: str) -> Any:
    data = (payload or {}).get("data") or {}
    node = data.get(tx_symbol)
    if not node:
        return []
    return (
        node.get(f"qfq{granularity}")
        or node.get(f"hfq{granularity}")
        or node.get(granularity)
        or []
    )


def _build_url(base: str, tx_symbol: str, granularity: str, adjust: str, start: str, end: str, count: int) -> str:
    param = f"{tx_symbol},{granularity},{start},{end},{min(count, TX_MAX_BARS)},{_adjust_suffix(adjust)}"
    return f"{base}?param={urllib.parse.quote(param, safe='')}"


def _http_get_json(url: str, headers: Optional[Dict[str, str]] = None) -> Tuple[int, Any]:
    request = urllib.request.Request(url, headers=headers or {"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT) as response:
        body = response.read().decode("utf-8", errors="replace")
        status = response.status
    try:
        return status, json.loads(body)
    except json.JSONDecodeError as exc:
        raise UpstreamError(f"响应不是合法 JSON: {exc}") from exc


def _tencent_request_once(
    tx_symbol: str,
    period: str,
    count: int,
    adjust: str,
    start: str = "",
    end: str = "",
) -> List[Kline]:
    granularity = _granularity(period)

    for host_try in range(len(TENCENT_HOSTS) + 1):
        index, base, _rich = _gate.pick_host()
        _gate.acquire()
        url = _build_url(base, tx_symbol, granularity, adjust, start, end, count)

        try:
            status, payload = _http_get_json(url)
        except urllib.error.HTTPError as exc:
            if exc.code == 501:
                _gate.cool_down(index)
                continue
            if exc.code == 429:
                if host_try < len(TENCENT_HOSTS):
                    continue
                raise UpstreamError("腾讯K线接口限流 (429)") from exc
            if 400 <= exc.code < 500:
                raise FatalUpstreamError(f"腾讯K线接口错误 ({exc.code})") from exc
            if host_try < len(TENCENT_HOSTS):
                continue
            raise UpstreamError(f"腾讯K线接口错误 ({exc.code})") from exc
        except (urllib.error.URLError, TimeoutError, UpstreamError) as exc:
            if host_try < len(TENCENT_HOSTS):
                continue
            raise UpstreamError(str(exc)) from exc

        klines = _parse_rows(_extract_rows(payload, tx_symbol, granularity))
        if not klines:
            raise FatalUpstreamError(f"腾讯未返回 {tx_symbol} 的{period}K线数据")
        return klines

    raise UpstreamError(f"腾讯K线接口全部域名不可用 ({tx_symbol})")


def _tencent_request(
    tx_symbol: str, period: str, count: int, adjust: str, start: str = "", end: str = ""
) -> List[Kline]:
    last_error: Optional[Exception] = None
    for attempt in range(MAX_RETRIES + 1):
        if attempt > 0:
            time.sleep(0.5 * attempt)
        try:
            return _tencent_request_once(tx_symbol, period, count, adjust, start, end)
        except FatalUpstreamError:
            raise
        except UpstreamError as exc:
            last_error = exc
    raise UpstreamError(str(last_error) if last_error else f"获取 {tx_symbol} K线失败")


def fetch_tencent_klines(symbol: str, period: str, count: int, adjust: str) -> List[Kline]:
    """Fetch up to ``count`` bars, paging backwards when > 800 are needed."""
    tx_symbol = to_tencent_symbol(symbol)
    collected = _tencent_request(tx_symbol, period, count, adjust)
    if len(collected) >= count:
        return collected[-count:]

    while len(collected) < count:
        oldest = collected[0].date
        need = count - len(collected)
        end = _shift_date(oldest, -1)
        span_days = need * 8 if period == "1w" else int(need * 1.6) + 10
        start = _shift_date(end, -span_days)

        try:
            nxt = _tencent_request_once(tx_symbol, period, need, adjust, start, end)
        except FatalUpstreamError:
            break
        merged = merge_klines_by_date(collected, nxt)
        if len(merged) == len(collected):
            break
        collected = merged

    return collected[-count:]


def _shift_date(date: str, days: int) -> str:
    import datetime as _dt

    d = _dt.date.fromisoformat(date[:10]) + _dt.timedelta(days=days)
    return d.isoformat()


# ---------------------------------------------------------------------------
# TickFlow (兜底)
# ---------------------------------------------------------------------------

_tickflow_lock = threading.Lock()
_tickflow_last = 0.0
_TICKFLOW_MIN_INTERVAL = 60.0 / 55.0  # 55 次/分钟, 低于免费接口 60/min 硬顶


def _acquire_tickflow_slot() -> None:
    global _tickflow_last
    with _tickflow_lock:
        now = time.monotonic()
        wait = _TICKFLOW_MIN_INTERVAL - (now - _tickflow_last)
        if wait > 0:
            time.sleep(wait)
        _tickflow_last = time.monotonic()


def fetch_tickflow_klines(symbol: str, period: str, count: int, adjust: str) -> List[Kline]:
    query = urllib.parse.urlencode(
        {"symbol": symbol, "period": period, "count": count, "adjust": adjust}
    )
    url = f"{TICKFLOW_BASE_URL}/v1/klines?{query}"
    headers = {"User-Agent": "Mozilla/5.0"}
    if TICKFLOW_API_KEY:
        headers["x-api-key"] = TICKFLOW_API_KEY

    last_error: Optional[Exception] = None
    for attempt in range(MAX_RETRIES + 1):
        _acquire_tickflow_slot()
        try:
            _status, payload = _http_get_json(url, headers)
        except urllib.error.HTTPError as exc:
            if exc.code == 429:
                body = ""
                try:
                    body = exc.read().decode("utf-8", errors="replace")
                except Exception:  # noqa: BLE001
                    pass
                delay = extract_rate_limit_delay(body)
                if attempt < MAX_RETRIES:
                    time.sleep((delay if delay is not None else attempt * 2000 + 1000) / 1000.0)
                    continue
                raise UpstreamError("TickFlow 免费接口请求频率超限 (60/min), 请稍后重试") from exc
            raise UpstreamError(f"TickFlow 接口错误 ({exc.code})") from exc
        except (urllib.error.URLError, TimeoutError, UpstreamError) as exc:
            last_error = exc
            if attempt < MAX_RETRIES:
                time.sleep(1.2)
                continue
            raise UpstreamError(str(exc)) from exc

        data = (payload or {}).get("data") or {}
        if not data or not data.get("timestamp"):
            raise UpstreamError(f"TickFlow 未返回 {symbol} 的K线数据")
        return parse_tickflow_columns(data)

    raise UpstreamError(str(last_error) if last_error else f"获取 {symbol} K线失败")


# ---------------------------------------------------------------------------
# 路由
# ---------------------------------------------------------------------------


def fetch_klines(symbol: str, period: str, count: int, adjust: str, prefer_tickflow: bool = False) -> List[Kline]:
    """Tencent first (no key, no public quota), TickFlow as fallback."""
    if prefer_tickflow:
        return fetch_tickflow_klines(symbol, period, count, adjust)
    try:
        return fetch_tencent_klines(symbol, period, count, adjust)
    except (UpstreamError, FatalUpstreamError) as exc:
        print(f"[klines] 腾讯获取 {symbol} {period} 失败, 回退 TickFlow: {exc}")
        return fetch_tickflow_klines(symbol, period, count, adjust)
