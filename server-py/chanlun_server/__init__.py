"""ChanLun Stock Analyzer — Python server & backtest engine.

Public surface:

    from chanlun_server import chanlun, run_backtest, get_klines, BacktestStepper
"""

from __future__ import annotations

__version__ = "1.0.0"

from .chanlun import (  # noqa: F401
    calculate_bs_points,
    compute_chanlun_structures,
    compute_strokes_and_bs_points,
    run_chanlun_pipeline,
)
from .klines import get_klines  # noqa: F401
from .models import Kline, Trade  # noqa: F401
from .runner import run_backtest  # noqa: F401
from .stepper import BacktestStepper  # noqa: F401
from .strategies import find_strategy, list_strategy_summaries, load_strategies  # noqa: F401

__all__ = [
    "__version__",
    "Kline",
    "Trade",
    "run_backtest",
    "BacktestStepper",
    "get_klines",
    "calculate_bs_points",
    "compute_chanlun_structures",
    "compute_strokes_and_bs_points",
    "run_chanlun_pipeline",
    "find_strategy",
    "list_strategy_summaries",
    "load_strategies",
]
