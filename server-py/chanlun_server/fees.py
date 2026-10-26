"""A-share trading rules: fees, price limits, order sizing, decision validation.

Ported from ``server/engine/strategyAdapter.ts``.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Sequence

from .models import Account, Amount, Decision, Position
from .numeric import round_half_up

#: 佣金费率默认值 (万分之二点五)
DEFAULT_COMMISSION_RATE = 0.00025
#: 单笔最低佣金 (CNY)
DEFAULT_MIN_COMMISSION = 5.0
#: 印花税 (卖出单边 0.1%)
STAMP_DUTY_RATE = 0.001
#: 过户费 (双边 0.001%)
TRANSFER_FEE_RATE = 0.00001

VALID_ACTIONS = frozenset({"BUY", "SELL", "HOLD"})
VALID_UNITS = frozenset({"cash", "shares", "percent"})


# ---------------------------------------------------------------------------
# 费用
# ---------------------------------------------------------------------------


def calc_a_stock_fees(
    trade_value: float,
    is_buy: bool,
    commission_rate: float = DEFAULT_COMMISSION_RATE,
    min_commission: float = DEFAULT_MIN_COMMISSION,
) -> float:
    """佣金 + 印花税 (卖出) + 过户费 (双边)."""
    commission = trade_value * commission_rate
    if commission < min_commission:
        commission = min_commission
    stamp_duty = 0.0 if is_buy else trade_value * STAMP_DUTY_RATE
    transfer_fee = trade_value * TRANSFER_FEE_RATE
    return commission + stamp_duty + transfer_fee


# ---------------------------------------------------------------------------
# 涨跌停
# ---------------------------------------------------------------------------

_SYMBOL_SUFFIX_RE = re.compile(r"\.(SS|SZ|SH|BJ)$", re.IGNORECASE)


def stock_limit_ratio(symbol: str) -> float:
    """涨跌停幅度系数 (1.10 / 1.20 / 1.05), 按代码前缀判定.

    60xxxx / 000xxx / 002xxx / 001xxx → ±10% (主板)
    300xxx (创业板) / 688xxx (科创板) → ±20%
    4xxxxx / 8xxxxx                    → ±5%  (三板简化)
    """
    code = _SYMBOL_SUFFIX_RE.sub("", symbol or "").strip()
    if re.match(r"^(688|300)", code):
        return 1.20
    if re.match(r"^[48]", code):
        return 1.05
    return 1.10


def limit_up_price(prev_close: float, symbol: str = "") -> float:
    return round_half_up(prev_close * stock_limit_ratio(symbol), 2)


def limit_down_price(prev_close: float, symbol: str = "") -> float:
    ratio = stock_limit_ratio(symbol)
    return round_half_up(prev_close * (2 - ratio), 2)


# ---------------------------------------------------------------------------
# 策略参数
# ---------------------------------------------------------------------------


def build_strategy_params(
    definition: Mapping[str, Any],
    custom: Optional[Mapping[str, Any]] = None,
) -> Dict[str, Any]:
    """Defaults from the strategy definition, overridden by request params."""
    params: Dict[str, Any] = {}
    for param in definition.get("params") or []:
        if isinstance(param, dict) and "key" in param:
            params[str(param["key"])] = param.get("defaultValue")
    for key, value in (custom or {}).items():
        if isinstance(value, (str, int, float, bool)):
            params[str(key)] = value
    return params


# ---------------------------------------------------------------------------
# 决策校验
# ---------------------------------------------------------------------------


def validate_decision(decision: Decision) -> List[str]:
    """Return a list of human readable errors; empty list means valid."""
    errors: List[str] = []

    if decision.action not in VALID_ACTIONS:
        return ["Action must be BUY, SELL, or HOLD"]

    action = decision.action

    if action in ("BUY", "SELL"):
        if decision.amount is None:
            errors.append(f"{action} must have an amount")
        else:
            amount = decision.amount
            if amount.unit not in VALID_UNITS:
                errors.append('Amount unit must be "cash", "shares", or "percent"')
            if not math.isfinite(amount.value) or amount.value <= 0:
                errors.append("Amount value must be a positive finite number")
            else:
                if amount.unit == "percent" and (amount.value <= 0 or amount.value > 100):
                    errors.append("Percent value must be > 0 and <= 100")
                if amount.unit == "cash" and action == "SELL":
                    errors.append("Cash unit is only valid for BUY actions")

    if decision.confidence is not None:
        confidence = decision.confidence
        if (
            not math.isfinite(confidence)
            or confidence < 0
            or confidence > 1
        ):
            errors.append("Confidence must be a number between 0 and 1")

    return errors


# ---------------------------------------------------------------------------
# 委托数量
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class ResolvedOrder:
    shares: int
    actual_value: float
    warnings: List[str]


def resolve_order_shares(
    decision: Decision,
    account: Account,
    position: Position,
    current_price: float,
) -> ResolvedOrder:
    """Convert a decision amount into whole-lot shares.

    - BUY  cash    : shares = floor(min(cash, available) / price)
    - BUY  shares  : shares = min(amount, floor(cash / price))
    - BUY  percent : shares = floor(cash * pct / price)
    - SELL shares  : shares = min(amount, held)
    - SELL percent : shares = floor(held * pct)
    - SELL cash    : invalid

    All BUY quantities are floored to 100-share lots (A-share 整手).
    """
    warnings: List[str] = []

    if not math.isfinite(current_price) or current_price <= 0:
        return ResolvedOrder(0, 0.0, ["Invalid current price"])

    if decision.action == "HOLD":
        return ResolvedOrder(0, 0.0, warnings)

    if decision.amount is None:
        return ResolvedOrder(0, 0.0, ["No amount specified"])

    unit = decision.amount.unit
    value = decision.amount.value

    if not math.isfinite(value) or value <= 0:
        return ResolvedOrder(0, 0.0, ["Amount value must be a positive finite number"])

    effective_value = value
    if unit == "percent" and value > 100:
        warnings.append(f"Percent value {value} clamped to 100")
        effective_value = 100.0

    if decision.action == "BUY":
        if unit == "cash":
            cash_to_use = min(effective_value, account.cash)
            shares = int(math.floor(cash_to_use / current_price))
        elif unit == "shares":
            max_affordable = int(math.floor(account.cash / current_price))
            shares = int(min(effective_value, max_affordable))
        elif unit == "percent":
            cash_to_use = account.cash * (effective_value / 100.0)
            shares = int(math.floor(cash_to_use / current_price))
        else:
            return ResolvedOrder(0, 0.0, [f"Unknown amount unit: {unit}"])

        shares = max(0, (shares // 100) * 100)
        if shares <= 0:
            warnings.append("Buy amount too small for one round lot (100 shares)")
        return ResolvedOrder(shares, shares * current_price, warnings)

    if decision.action == "SELL":
        if unit == "shares":
            shares = int(min(effective_value, position.shares))
        elif unit == "percent":
            shares = int(math.floor(position.shares * (effective_value / 100.0)))
        elif unit == "cash":
            warnings.append("Cash unit is not valid for SELL actions")
            return ResolvedOrder(0, 0.0, warnings)
        else:
            return ResolvedOrder(0, 0.0, [f"Unknown amount unit: {unit}"])

        shares = max(0, min(shares, position.shares))
        return ResolvedOrder(shares, shares * current_price, warnings)

    return ResolvedOrder(0, 0.0, warnings)


def amount_of(decision: Decision) -> Optional[Amount]:
    return decision.amount


def approx_equal(a: float, b: float, eps: float = 1e-6) -> bool:
    return math.isfinite(a) and math.isfinite(b) and abs(a - b) <= eps


def sequences_equal(a: Sequence[float], b: Sequence[float], eps: float = 1e-6) -> bool:
    if len(a) != len(b):
        return False
    return all(approx_equal(x, y, eps) for x, y in zip(a, b))
