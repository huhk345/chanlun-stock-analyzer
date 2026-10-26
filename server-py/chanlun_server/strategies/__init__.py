"""Strategy registry: builtin strategies + user strategies, one execution path.

A strategy is a plain object with metadata and a ``decide(ctx)`` callable that
returns a :class:`~chanlun_server.models.Decision` (or a dict, or ``None`` for
HOLD). Builtin strategies live in this package; user strategies are JSON files
under ``data/user-strategies/`` whose ``code`` field holds Python source.

The browser never sees strategy code — it only gets metadata from
``GET /api/strategies`` and asks the server to run the backtest.
"""

from __future__ import annotations

import importlib
import pkgutil
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence

from ..models import Account, ChanlunStructures, Kline, Position


@dataclass(slots=True)
class StrategyContext:
    """Everything a strategy may look at on a single bar.

    ``klines`` is always truncated to the current bar (``klines[:i+1]``) so a
    strategy physically cannot read the future.
    """

    symbol: str
    timeframe: str
    klines: Sequence[Kline]
    current_index: int
    current_kline: Kline
    account: Account
    position: Position
    trades: List[Dict[str, Any]]
    params: Dict[str, Any]
    currency: str
    initial_cash: float
    chanlun: Optional[ChanlunStructures] = None
    indicators: Dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class Strategy:
    id: str
    name: str
    decide: Callable[[StrategyContext], Any]
    description: str = ""
    default_selected: bool = False
    requires_chanlun: bool = False
    params: List[Dict[str, Any]] = field(default_factory=list)
    available_indicators: List[Dict[str, Any]] = field(default_factory=list)
    required_indicators: List[Dict[str, Any]] = field(default_factory=list)
    source: str = "builtin"  # builtin | user

    def summary(self) -> Dict[str, Any]:
        """Metadata only — the ``decide`` callable never leaves the server."""
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "defaultSelected": self.default_selected,
            "requiresChanLun": self.requires_chanlun,
            "params": self.params,
            "availableIndicators": self.available_indicators,
            "requiredIndicators": self.required_indicators,
            "source": self.source,
        }


_BUILTIN: Optional[List[Strategy]] = None


def _discover_builtin() -> List[Strategy]:
    """Import every module in this package that exposes ``STRATEGY``."""
    loaded: List[Strategy] = []
    for module_info in sorted(pkgutil.iter_modules(__path__), key=lambda m: m.name):
        if module_info.name.startswith("_"):
            continue
        try:
            module = importlib.import_module(f"{__name__}.{module_info.name}")
        except Exception as exc:  # pragma: no cover - defensive
            print(f"[strategies] 跳过无法加载的策略模块 {module_info.name}: {exc}")
            continue
        candidates: List[Any] = []
        strategy = getattr(module, "STRATEGY", None)
        if strategy is not None:
            candidates.append(strategy)
        else:
            for value in vars(module).values():
                if isinstance(value, Strategy):
                    candidates.append(value)
        for candidate in candidates:
            if isinstance(candidate, Strategy) and candidate.id:
                loaded.append(candidate)
    return loaded


def load_builtin_strategies() -> List[Strategy]:
    global _BUILTIN
    if _BUILTIN is None:
        _BUILTIN = _discover_builtin()
    return _BUILTIN


def load_strategies() -> List[Strategy]:
    """Builtin + user strategies; builtin ids always win."""
    builtin = load_builtin_strategies()
    builtin_ids = {s.id for s in builtin}
    # Imported lazily to avoid a circular import (the store validates with the registry).
    from ..strategy_store import load_user_strategies

    user = [s for s in load_user_strategies() if s.id not in builtin_ids]
    return [*builtin, *user]


def find_strategy(strategy_id: str) -> Optional[Strategy]:
    for strategy in load_strategies():
        if strategy.id == strategy_id:
            return strategy
    return None


def list_strategy_summaries() -> List[Dict[str, Any]]:
    return [s.summary() for s in load_strategies()]


def reset_builtin_cache() -> None:
    """Test helper: force re-discovery after monkeypatching."""
    global _BUILTIN
    _BUILTIN = None
