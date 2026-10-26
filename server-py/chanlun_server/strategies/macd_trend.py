"""MACD 趋势策略 (DIF 上穿 DEA 且站上 MA20 买入, 下穿卖出)。

用于验证「指标快照注入 params」这条链路: 策略直接从 ``ctx.params`` 读取
引擎计算好的 MACD / MA20, 而不是自己重算。
"""

from __future__ import annotations

from typing import Any, Dict

from ..models import Decision
from . import Strategy, StrategyContext

DEFAULTS: Dict[str, Any] = {
    "allocationPercent": 100,
    "requireAboveMa20": True,
}


def _number(ctx: StrategyContext, key: str) -> float:
    value = ctx.params.get(key)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    return float(DEFAULTS[key])


def _flag(ctx: StrategyContext, key: str) -> bool:
    value = ctx.params.get(key)
    if isinstance(value, bool):
        return value
    return bool(DEFAULTS[key])


def decide(ctx: StrategyContext) -> Decision:
    index = min(ctx.current_index, len(ctx.klines) - 1)
    if index < 1:
        return Decision.hold()

    dif = ctx.params.get("MACD_DIF")
    dea = ctx.params.get("MACD_DEA")
    ma20 = ctx.params.get("MA20")
    if not isinstance(dif, (int, float)) or not isinstance(dea, (int, float)):
        return Decision.hold()

    # Compare against the previous bar's DIF/DEA to detect the crossover. The
    # engine only exposes the current snapshot, so recompute the previous pair
    # from the truncated series — still strictly causal.
    from ..indicators import macd

    prev = macd(ctx.klines, index - 1)
    if prev is None:
        return Decision.hold()

    golden = prev["dif"] <= prev["dea"] and dif > dea
    death = prev["dif"] >= prev["dea"] and dif < dea

    above_ma20 = isinstance(ma20, (int, float)) and ctx.current_kline.close > ma20

    if golden and ctx.position.shares == 0:
        if _flag(ctx, "requireAboveMa20") and not above_ma20:
            return Decision.hold()
        return Decision(
            action="BUY",
            amount={"unit": "percent", "value": _number(ctx, "allocationPercent")},
            reason="MACD 金叉 (DIF 上穿 DEA)",
            confidence=0.62,
        )

    if death and ctx.position.shares > 0:
        return Decision(
            action="SELL",
            amount={"unit": "shares", "value": ctx.position.shares},
            reason="MACD 死叉 (DIF 下穿 DEA)",
            confidence=0.62,
        )

    return Decision.hold()


STRATEGY = Strategy(
    id="macd-trend",
    name="MACD 趋势",
    description="DIF 上穿 DEA 且收盘站上 MA20 时买入，死叉卖出；指标值由引擎注入。",
    params=[
        {
            "key": "allocationPercent",
            "label": "单次买入仓位 (%)",
            "type": "number",
            "defaultValue": DEFAULTS["allocationPercent"],
            "min": 10,
            "max": 100,
            "step": 5,
        },
        {
            "key": "requireAboveMa20",
            "label": "要求站上 MA20",
            "type": "boolean",
            "defaultValue": DEFAULTS["requireAboveMa20"],
        },
    ],
    decide=decide,
)
