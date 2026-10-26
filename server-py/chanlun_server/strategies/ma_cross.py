"""均线交叉策略 (双均线金叉买入 / 死叉卖出)。

最简单的可验证基线策略: 只用收盘价, 不含任何缠论结构, 因此非常适合用来
校验回测引擎本身 (成交价、整手、费用、T+1)。
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from ..models import Decision
from . import Strategy, StrategyContext

DEFAULTS: Dict[str, Any] = {
    "fastPeriod": 5,
    "slowPeriod": 20,
    "allocationPercent": 100,
}


def _param(ctx: StrategyContext, key: str) -> float:
    value = ctx.params.get(key)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    return float(DEFAULTS[key])


def _sma(klines: List[Any], end: int, period: int) -> Optional[float]:
    if period <= 0 or end + 1 < period:
        return None
    total = 0.0
    for i in range(end - period + 1, end + 1):
        total += klines[i].close
    return total / period


def decide(ctx: StrategyContext) -> Decision:
    index = min(ctx.current_index, len(ctx.klines) - 1)
    if index < 1:
        return Decision.hold()

    fast_period = int(_param(ctx, "fastPeriod"))
    slow_period = int(_param(ctx, "slowPeriod"))
    if fast_period >= slow_period:
        fast_period, slow_period = min(fast_period, slow_period), max(fast_period, slow_period)

    fast_now = _sma(ctx.klines, index, fast_period)
    slow_now = _sma(ctx.klines, index, slow_period)
    fast_prev = _sma(ctx.klines, index - 1, fast_period)
    slow_prev = _sma(ctx.klines, index - 1, slow_period)
    if None in (fast_now, slow_now, fast_prev, slow_prev):
        return Decision.hold()

    golden_cross = fast_prev <= slow_prev and fast_now > slow_now
    death_cross = fast_prev >= slow_prev and fast_now < slow_now

    if golden_cross and ctx.position.shares == 0:
        allocation = _param(ctx, "allocationPercent")
        return Decision(
            action="BUY",
            amount={"unit": "percent", "value": allocation},
            reason=f"MA{fast_period} 上穿 MA{slow_period} (金叉)",
            confidence=0.6,
        )

    if death_cross and ctx.position.shares > 0:
        return Decision(
            action="SELL",
            amount={"unit": "shares", "value": ctx.position.shares},
            reason=f"MA{fast_period} 下穿 MA{slow_period} (死叉)",
            confidence=0.6,
        )

    return Decision.hold()


STRATEGY = Strategy(
    id="ma-cross",
    name="双均线交叉",
    description="快线上穿慢线买入、下穿卖出；只依赖收盘价，适合作为引擎基线策略。",
    default_selected=True,
    params=[
        {
            "key": "fastPeriod",
            "label": "快线周期",
            "type": "number",
            "defaultValue": DEFAULTS["fastPeriod"],
            "min": 2,
            "max": 60,
            "step": 1,
        },
        {
            "key": "slowPeriod",
            "label": "慢线周期",
            "type": "number",
            "defaultValue": DEFAULTS["slowPeriod"],
            "min": 5,
            "max": 250,
            "step": 1,
        },
        {
            "key": "allocationPercent",
            "label": "单次买入仓位 (%)",
            "type": "number",
            "defaultValue": DEFAULTS["allocationPercent"],
            "min": 10,
            "max": 100,
            "step": 5,
        },
    ],
    decide=decide,
)
