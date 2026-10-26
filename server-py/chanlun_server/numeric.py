"""Numeric helpers that match JavaScript semantics.

Python's built-in ``round`` uses banker's rounding (round-half-to-even) while
JavaScript's ``Math.round`` rounds half away from zero. Price rounding in A-share
limit-up/limit-down maths is sensitive to that difference (e.g. ``10.005``),
so every price rounding in this server goes through :func:`round_half_up`.
"""

from __future__ import annotations

import math


def round_half_up(value: float, digits: int = 0) -> float:
    """Round half away from zero, like ``Math.round(value * 10^d) / 10^d``."""
    if not math.isfinite(value):
        return value
    factor = 10.0**digits
    scaled = value * factor
    # ``floor(x + 0.5)`` is what JS does for positives; mirror it for negatives.
    rounded = math.floor(scaled + 0.5) if scaled >= 0 else math.ceil(scaled - 0.5)
    return rounded / factor


def is_finite_positive(value: object) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
        and value > 0
    )
