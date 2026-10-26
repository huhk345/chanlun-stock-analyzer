"""Indicator snapshots fed into strategy ``params`` on every bar.

Mirrors ``server/engine/indicatorValues.ts``: MA5/10/20/60, Bollinger Bands and
MACD are computed from data up to the current bar only, and merged into the
params dict under stable keys (``MA20``, ``BOLL_UP``, ``MACD_DIF`` ...).

User-defined (browser-side) indicator code is JavaScript and is **not** executed
here; see ``README`` for the migration note.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Sequence

from .models import Kline
from .numeric import round_half_up

MA_PERIODS = (5, 10, 20, 60)


def sma(klines: Sequence[Kline], period: int, end_index: int) -> Optional[float]:
    if period <= 0 or end_index + 1 < period:
        return None
    total = 0.0
    for i in range(end_index - period + 1, end_index + 1):
        total += klines[i].close
    return total / period


def bollinger(
    klines: Sequence[Kline], end_index: int, period: int = 20, multiplier: float = 2.0
) -> Optional[Dict[str, float]]:
    if end_index + 1 < period:
        return None
    window = klines[end_index - period + 1 : end_index + 1]
    middle = sum(k.close for k in window) / period
    variance = sum((k.close - middle) ** 2 for k in window) / period
    sd = math.sqrt(variance)
    return {
        "upper": round_half_up(middle + multiplier * sd, 2),
        "middle": round_half_up(middle, 2),
        "lower": round_half_up(middle - multiplier * sd, 2),
    }


def macd(
    klines: Sequence[Kline],
    end_index: int,
    short_period: int = 12,
    long_period: int = 26,
    signal_period: int = 9,
) -> Optional[Dict[str, float]]:
    """EMA-based MACD; returns None when fewer than ``long_period`` bars exist."""
    if end_index + 1 < long_period:
        return None
    k_short = 2 / (short_period + 1)
    k_long = 2 / (long_period + 1)
    k_signal = 2 / (signal_period + 1)

    ema_short = klines[0].close
    ema_long = klines[0].close
    dea = 0.0
    dif = 0.0
    for i in range(1, end_index + 1):
        close = klines[i].close
        ema_short = close * k_short + ema_short * (1 - k_short)
        ema_long = close * k_long + ema_long * (1 - k_long)
        dif = ema_short - ema_long
        dea = dif * k_signal + dea * (1 - k_signal)

    histogram = (dif - dea) * 2
    return {"dif": dif, "dea": dea, "histogram": histogram}


def rsi(klines: Sequence[Kline], end_index: int, period: int = 14) -> Optional[float]:
    if end_index < period:
        return None
    gains = 0.0
    losses = 0.0
    for i in range(end_index - period + 1, end_index + 1):
        delta = klines[i].close - klines[i - 1].close
        if delta > 0:
            gains += delta
        else:
            losses -= delta
    average_gain = gains / period
    average_loss = losses / period
    if average_loss == 0:
        return 50.0 if average_gain == 0 else 100.0
    relative_strength = average_gain / average_loss
    return 100 - 100 / (1 + relative_strength)


def atr(klines: Sequence[Kline], end_index: int, period: int = 14) -> Optional[float]:
    if end_index < period:
        return None
    total = 0.0
    for i in range(end_index - period + 1, end_index + 1):
        previous_close = klines[i - 1].close
        total += max(
            klines[i].high - klines[i].low,
            abs(klines[i].high - previous_close),
            abs(klines[i].low - previous_close),
        )
    return total / period


def compute_indicator_values(
    definitions: Sequence[Any],
    symbol: str,
    klines: Sequence[Kline],
    current_index: int,
) -> Dict[str, Any]:
    """Flat indicator snapshot for bar ``current_index``.

    ``definitions`` is accepted for API compatibility; JavaScript user
    indicators are not executed by the Python server.
    """
    values: Dict[str, Any] = {}

    for period in MA_PERIODS:
        value = sma(klines, period, current_index)
        if value is not None:
            values[f"MA{period}"] = value

    boll = bollinger(klines, current_index)
    if boll is not None:
        values["BOLL_UP"] = boll["upper"]
        values["BOLL_MID"] = boll["middle"]
        values["BOLL_LOW"] = boll["lower"]

    macd_values = macd(klines, current_index)
    if macd_values is not None:
        values["MACD_DIF"] = round(macd_values["dif"], 4)
        values["MACD_DEA"] = round(macd_values["dea"], 4)
        values["MACD"] = round(macd_values["histogram"], 4)

    return values


def series_at(klines: Sequence[Kline], field: str) -> List[float]:
    return [getattr(k, field) for k in klines]
