"""Performance statistics and trade bookkeeping helpers.

Ported from ``server/engine/backtestUtils.ts``.
"""

from __future__ import annotations

import math
import itertools
import threading
import time
from typing import Any, Dict, List, Sequence

from .models import Trade
from .numeric import round_half_up

_trade_counter = itertools.count(1)
_trade_lock = threading.Lock()

#: A-share trading days per year, used to annualise the Sharpe ratio.
TRADING_DAYS = 252


def sharpe_from_returns(returns: Sequence[float]) -> float:
    """Annualised Sharpe ratio of a return series (risk-free rate = 0)."""
    if len(returns) < 2:
        return 0.0
    mean = sum(returns) / len(returns)
    variance = sum((r - mean) ** 2 for r in returns) / len(returns)
    std = math.sqrt(variance)
    return (mean / std) * math.sqrt(TRADING_DAYS) if std > 0 else 0.0


def sharpe_from_equity_curve(equity_curve: Sequence[float]) -> float:
    returns: List[float] = []
    for i in range(1, len(equity_curve)):
        prev = equity_curve[i - 1]
        returns.append((equity_curve[i] - prev) / prev if prev > 0 else 0.0)
    return sharpe_from_returns(returns)


def max_drawdown_from_equity_curve(
    equity_curve: Sequence[float], initial_peak: float | None = None
) -> float:
    """Peak-to-trough drawdown in percent, rounded to 2 decimals."""
    if initial_peak is not None:
        peak = initial_peak
    elif equity_curve:
        peak = equity_curve[0]
    else:
        peak = 0.0
    max_drawdown = 0.0
    for equity in equity_curve:
        if equity > peak:
            peak = equity
        elif peak > 0:
            dd = ((peak - equity) / peak) * 100.0
            if dd > max_drawdown:
                max_drawdown = dd
    return round_half_up(max_drawdown, 2)


def next_trade_id() -> str:
    """Globally unique trade id (counter avoids collisions within one ms)."""
    with _trade_lock:
        n = next(_trade_counter)
    return f"trade-{int(time.time() * 1000)}-{n}"


def trades_to_snapshots(trades: Sequence[Trade]) -> List[Dict[str, Any]]:
    return [t.to_snapshot() for t in trades]


def iso_now() -> str:
    """ISO-8601 UTC timestamp with milliseconds, like JS ``toISOString()``."""
    now = time.time()
    base = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now))
    millis = int((now - int(now)) * 1000)
    return f"{base}.{millis:03d}Z"
