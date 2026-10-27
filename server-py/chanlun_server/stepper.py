"""Day-by-day simulation stepper — a navigator over a recorded timeline.

A simulation is recorded **once** (one pass over the cached K-lines) and then
navigated by index. Forward, backward and jump all cost the same, so scrubbing a
900-day run is instant instead of re-running the strategy 900 times.

The recording pass is delegated to whichever engine is configured:

============  =====================================================
``native``    :func:`chanlun_server.runner.run_backtest`
``backtrader``:func:`chanlun_server.bt_engine.run_backtest_bt`
============  =====================================================

Both call the same ``on_bar`` hook and produce the same :class:`DaySnapshot`
sequence, so ``run_all()`` and the day-by-day view agree with the batch backtest
on either engine (asserted in ``tests/part2_integration/test_stepper_parity.py``).

Recordings are cached on disk (see :mod:`chanlun_server.timeline`), so re-opening
the same simulation skips the pass entirely.
"""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional, Sequence

from .execution import create_initial_account, create_initial_position
from .fees import (
    DEFAULT_COMMISSION_RATE,
    DEFAULT_MIN_COMMISSION,
    build_strategy_params,
)
from .models import Kline
from .runner import run_backtest
from .strategies import Strategy
from .timeline import (
    DaySnapshot,
    StepState,
    Timeline,
    build_timeline,
    cache_key,
    load_timeline,
    save_timeline,
)

__all__ = ["BacktestStepper", "StepState"]


class BacktestStepper:
    """Records a simulation once, then serves any day by index."""

    def __init__(
        self,
        klines: Sequence[Kline],
        symbol: str,
        strategy: Strategy,
        user_id: str = "server",
        initial_cash: float = 100_000.0,
        currency: str = "CNY",
        stop_loss_percent: Optional[float] = None,
        commission_rate: float = DEFAULT_COMMISSION_RATE,
        min_commission: float = DEFAULT_MIN_COMMISSION,
        params: Optional[Dict[str, Any]] = None,
        selected_indicator_ids: Optional[Sequence[str]] = None,
        indicators: Optional[Sequence[Any]] = None,
        engine: str = "native",
        use_cache: bool = True,
    ) -> None:
        self.klines = list(klines)
        self.symbol = symbol
        self.strategy = strategy
        self.user_id = user_id
        self.initial_cash = initial_cash
        self.currency = currency
        self.stop_loss_percent = stop_loss_percent
        self.commission_rate = commission_rate
        self.min_commission = min_commission
        self.params = build_strategy_params({"params": strategy.params}, params)
        self.selected_indicator_ids = selected_indicator_ids
        self.indicators = list(indicators or [])
        self.engine = engine
        self.use_cache = use_cache

        self._timeline: Optional[Timeline] = None
        self._cache_key: Optional[str] = None
        self.current_index = -1

    # -- recording ---------------------------------------------------------

    def _record(self) -> Timeline:
        if self._timeline is not None:
            return self._timeline

        key = (
            cache_key(
                symbol=self.symbol,
                engine=self.engine,
                strategy=self.strategy,
                params=self.params,
                initial_cash=self.initial_cash,
                commission_rate=self.commission_rate,
                min_commission=self.min_commission,
                stop_loss_percent=self.stop_loss_percent,
                klines=self.klines,
            )
            if self.use_cache
            else None
        )
        self._cache_key = key

        cached = load_timeline(key)
        if cached is not None:
            self._timeline = cached
            return cached

        started = time.time()
        records: List[DaySnapshot] = []
        output = self._run_engine(records)
        timeline = build_timeline(
            symbol=self.symbol,
            engine=self.engine,
            records=records,
            result=output.result,
            diagnostics=output.diagnostics,
            equity_curve=output.equity_curve,
            trades=output.result.trades,
            initial_account=create_initial_account(self.initial_cash, self.currency),
            initial_position=create_initial_position(),
            record_seconds=time.time() - started,
        )
        save_timeline(key, timeline)
        self._timeline = timeline
        return timeline

    def _run_engine(self, records: List[DaySnapshot]) -> Any:
        kwargs = dict(
            klines=self.klines,
            symbol=self.symbol,
            strategy=self.strategy,
            user_id=self.user_id,
            initial_cash=self.initial_cash,
            currency=self.currency,
            stop_loss_percent=self.stop_loss_percent,
            commission_rate=self.commission_rate,
            min_commission=self.min_commission,
            params=self.params,
            selected_indicator_ids=self.selected_indicator_ids,
            indicators=self.indicators,
            on_bar=records.append,
        )
        if self.engine == "backtrader":
            from .bt_engine import run_backtest_bt

            return run_backtest_bt(**kwargs)
        return run_backtest(**kwargs)

    # -- navigation --------------------------------------------------------

    @property
    def is_started(self) -> bool:
        return self._timeline is not None and self.current_index >= 0

    @property
    def timeline(self) -> Timeline:
        return self._record()

    @property
    def cached(self) -> bool:
        return self._record().cached

    @property
    def record_seconds(self) -> float:
        return self._record().record_seconds

    @property
    def total_steps(self) -> int:
        return self._record().total_steps

    def start(self) -> StepState:
        timeline = self._record()
        self.current_index = 0 if timeline.total_steps else -1
        return timeline.state_at(self.current_index)

    def step_forward(self) -> StepState:
        timeline = self._record()
        if self.current_index < timeline.total_steps - 1:
            self.current_index += 1
        return timeline.state_at(self.current_index)

    def step_backward(self) -> StepState:
        timeline = self._record()
        if self.current_index > 0:
            self.current_index -= 1
        return timeline.state_at(self.current_index)

    def jump_to(self, index: int) -> StepState:
        timeline = self._record()
        if 0 <= index < timeline.total_steps:
            self.current_index = int(index)
        return timeline.state_at(self.current_index)

    def current_state(self) -> StepState:
        return self._record().state_at(self.current_index)

    def run_all(self) -> Dict[str, Any]:
        """Full batch result — already computed during the recording pass.

        Also parks the cursor on the final day, so a subsequent ``/trades`` call
        returns the complete ledger (the session has effectively run to the end).
        """
        timeline = self._record()
        self.current_index = timeline.total_steps - 1 if timeline.total_steps else -1
        return timeline.run_all_payload()

    def get_trades(self) -> List[Dict[str, Any]]:
        """Ledger up to the current day (rewinds when you step back)."""
        return self._record().trades_until(self.current_index)
