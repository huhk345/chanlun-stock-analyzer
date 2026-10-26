"""Day-by-day stepping engine (stateful, supports backward navigation).

Ported from ``server/engine/backtestStepper.ts``. The fill model is identical to
:mod:`chanlun_server.runner`, so ``run_all()`` must reproduce ``run_backtest()``
trade for trade — the integration suite asserts exactly that.

``history[i]`` stores the complete engine state *before* bar ``i`` was processed,
which makes backward/forward navigation a pure replay (no rounding drift).
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence

from .chanlun import compute_chanlun_structures
from .execution import (
    create_initial_account,
    create_initial_position,
    execute_decision_at_close,
    execute_protective_stop,
)
from .fees import (
    DEFAULT_COMMISSION_RATE,
    DEFAULT_MIN_COMMISSION,
    build_strategy_params,
    validate_decision,
)
from .indicators import compute_indicator_values
from .metrics import (
    iso_now,
    max_drawdown_from_equity_curve,
    sharpe_from_equity_curve,
    trades_to_snapshots,
)
from .models import Account, BacktestResult, Decision, Diagnostic, Kline, Position, Trade, decision_from_raw
from .runner import MAX_CONSECUTIVE_ERRORS, RunBacktestOutput
from .strategies import Strategy, StrategyContext


@dataclass(slots=True)
class SavedState:
    step_index: int
    account: Account
    position: Position
    trades: List[Trade]
    strategy_stopped: bool
    consecutive_errors: int
    has_decided_once: bool
    diagnostics: List[Diagnostic]
    total_fees: float


@dataclass(slots=True)
class StepState:
    current_step_index: int
    total_steps: int
    current_kline: Optional[Kline]
    decision: Optional[Decision]
    account_before: Account
    account_after: Account
    position_before: Position
    position_after: Position
    trades_executed: List[Dict[str, Any]] = field(default_factory=list)
    diagnostics: List[Diagnostic] = field(default_factory=list)
    is_finished: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return {
            "currentStepIndex": self.current_step_index,
            "totalSteps": self.total_steps,
            "currentKline": self.current_kline.to_dict() if self.current_kline else None,
            "decision": self.decision.to_dict() if self.decision else None,
            "accountBefore": self.account_before.to_dict(),
            "accountAfter": self.account_after.to_dict(),
            "positionBefore": self.position_before.to_dict(),
            "positionAfter": self.position_after.to_dict(),
            "tradesExecuted": self.trades_executed,
            "indicatorSnapshot": None,
            "chanlunSnapshot": None,
            "diagnostics": [d.to_dict() for d in self.diagnostics],
            "isFinished": self.is_finished,
        }


class BacktestStepper:
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

        self.history: Dict[int, SavedState] = {}
        self.current_index = -1
        self.account = create_initial_account(initial_cash, currency)
        self.position = create_initial_position()
        self.trades: List[Trade] = []
        self.strategy_stopped = False
        self.consecutive_errors = 0
        self.has_decided_once = False
        self.diagnostics: List[Diagnostic] = []
        self.total_fees = 0.0
        self.is_started = False
        self.last_step_state: Optional[StepState] = None
        self.equity_by_index: Dict[int, float] = {}

    # -- state management ---------------------------------------------------

    def _reset(self) -> None:
        self.account = create_initial_account(self.initial_cash, self.currency)
        self.position = create_initial_position()
        self.trades = []
        self.strategy_stopped = False
        self.consecutive_errors = 0
        self.has_decided_once = False
        self.diagnostics = []
        self.total_fees = 0.0
        self.last_step_state = None
        self.equity_by_index = {}

    def _save(self, step_index: int) -> SavedState:
        return SavedState(
            step_index=step_index,
            account=self.account.copy(),
            position=self.position.copy(),
            trades=[t.copy() for t in self.trades],
            strategy_stopped=self.strategy_stopped,
            consecutive_errors=self.consecutive_errors,
            has_decided_once=self.has_decided_once,
            diagnostics=list(self.diagnostics),
            total_fees=self.total_fees,
        )

    def _restore(self, saved: SavedState) -> None:
        self.current_index = saved.step_index
        self.account = saved.account.copy()
        self.position = saved.position.copy()
        self.trades = [t.copy() for t in saved.trades]
        self.strategy_stopped = saved.strategy_stopped
        self.consecutive_errors = saved.consecutive_errors
        self.has_decided_once = saved.has_decided_once
        self.diagnostics = list(saved.diagnostics)
        self.total_fees = saved.total_fees
        self.equity_by_index = {k: v for k, v in self.equity_by_index.items() if k < saved.step_index}

    # -- one bar ------------------------------------------------------------

    def _process_step(self, i: int) -> StepState:
        current_kline = self.klines[i]
        prev_close = self.klines[i - 1].close if i > 0 else None

        account_before = self.account.copy()
        position_before = self.position.copy()

        decision: Optional[Decision] = None
        step_diagnostics: List[Diagnostic] = []
        trades_executed: List[Dict[str, Any]] = []

        # --- 1) 固定止损 (盘中止损单) ---
        if self.stop_loss_percent is not None and self.position.shares > 0:
            result = execute_protective_stop(
                bar=current_kline,
                prev_close=prev_close,
                symbol=self.symbol,
                stop_loss_percent=self.stop_loss_percent,
                sellable_shares=self.position.shares,
                account=self.account,
                position=self.position,
                commission_rate=self.commission_rate,
                min_commission=self.min_commission,
            )
            self.account = result.account
            self.position = result.position
            self.total_fees += result.fee
            if result.trade is not None:
                self.trades.append(result.trade)
                trades_executed.append(result.trade.to_snapshot())
            step_diagnostics.extend(result.diagnostics)

        # --- 2) 策略决策 ---
        klines_slice = self.klines[: i + 1]
        indicator_values = compute_indicator_values(
            self.indicators, self.symbol, klines_slice, i
        )
        self.params.update(indicator_values)

        ctx = StrategyContext(
            symbol=self.symbol,
            timeframe="daily",
            klines=klines_slice,
            current_index=i,
            current_kline=current_kline,
            account=self.account,
            position=self.position,
            trades=trades_to_snapshots(self.trades),
            params=self.params,
            currency=self.currency,
            initial_cash=self.initial_cash,
            chanlun=compute_chanlun_structures(klines_slice),
            indicators=indicator_values,
        )

        if not self.strategy_stopped:
            try:
                decision = decision_from_raw(self.strategy.decide(ctx))
                self.consecutive_errors = 0
                self.has_decided_once = True
            except Exception as exc:  # noqa: BLE001
                self.consecutive_errors += 1
                message = str(exc) or exc.__class__.__name__
                if self.has_decided_once and self.consecutive_errors >= MAX_CONSECUTIVE_ERRORS:
                    self.strategy_stopped = True
                    step_diagnostics.append(
                        Diagnostic(
                            level="error",
                            date=current_kline.date,
                            message=(
                                f"Strategy threw {self.consecutive_errors} consecutive errors, "
                                f"last: {message}. Strategy will no longer be called."
                            ),
                        )
                    )
                else:
                    step_diagnostics.append(
                        Diagnostic(
                            level="warning",
                            date=current_kline.date,
                            message=f"Strategy error (treated as HOLD, 后续信号继续评估): {message}",
                        )
                    )
                decision = Decision(action="HOLD", reason=f"策略异常按 HOLD 处理: {message}")

        if self.strategy_stopped or decision is None:
            decision = Decision.hold()

        validation_errors = validate_decision(decision)
        if validation_errors:
            for message in validation_errors:
                step_diagnostics.append(
                    Diagnostic(
                        level="warning",
                        date=current_kline.date,
                        message=f"Invalid decision: {message}",
                    )
                )
            decision = Decision.hold()

        # --- 3) 成交 ---
        if decision.action != "HOLD":
            result = execute_decision_at_close(
                decision=decision,
                bar=current_kline,
                prev_close=prev_close,
                symbol=self.symbol,
                account=self.account,
                position=self.position,
                commission_rate=self.commission_rate,
                min_commission=self.min_commission,
                strategy_label=self.strategy.id or self.strategy.name,
            )
            self.account = result.account
            self.position = result.position
            self.total_fees += result.fee
            if result.trade is not None:
                self.trades.append(result.trade)
                trades_executed.append(result.trade.to_snapshot())
            step_diagnostics.extend(result.diagnostics)

        self.diagnostics.extend(step_diagnostics)
        self.equity_by_index[i] = self.account.cash + self.position.shares * current_kline.close

        return StepState(
            current_step_index=i,
            total_steps=len(self.klines),
            current_kline=current_kline,
            decision=decision,
            account_before=account_before,
            account_after=self.account.copy(),
            position_before=position_before,
            position_after=self.position.copy(),
            trades_executed=trades_executed,
            diagnostics=step_diagnostics,
            is_finished=i == len(self.klines) - 1,
        )

    # -- public API ---------------------------------------------------------

    def start(self) -> StepState:
        self._reset()
        self.history = {}
        self.is_started = True

        if not self.klines:
            self.current_index = -1
            state = StepState(
                current_step_index=-1,
                total_steps=0,
                current_kline=None,
                decision=None,
                account_before=self.account.copy(),
                account_after=self.account.copy(),
                position_before=self.position.copy(),
                position_after=self.position.copy(),
                diagnostics=[Diagnostic(level="warning", message="No K-line data provided.")],
                is_finished=True,
            )
            self.last_step_state = state
            return state

        self.current_index = 0
        self.history[0] = self._save(0)
        state = self._process_step(0)
        self.last_step_state = state
        return state

    def step_forward(self) -> StepState:
        if not self.is_started:
            return self.start()
        if self.current_index >= len(self.klines) - 1:
            return self.last_step_state  # type: ignore[return-value]

        next_index = self.current_index + 1
        self.history[next_index] = self._save(next_index)
        self.current_index = next_index
        state = self._process_step(next_index)
        self.last_step_state = state
        return state

    def step_backward(self) -> StepState:
        target = self.current_index - 1
        if not self.is_started or target < 0 or target not in self.history:
            return self.last_step_state  # type: ignore[return-value]

        self._restore(self.history[target])
        self.current_index = target
        state = self._process_step(target)
        self.last_step_state = state
        return state

    def jump_to(self, index: int) -> StepState:
        if index < 0 or index >= len(self.klines):
            return self.last_step_state  # type: ignore[return-value]
        if not self.is_started:
            self.start()
        if index == self.current_index:
            return self.last_step_state  # type: ignore[return-value]

        if index < self.current_index and index in self.history:
            self._restore(self.history[index])
            self.current_index = index
            state = self._process_step(index)
            self.last_step_state = state
            return state

        if index < self.current_index:
            self._reset()
            self.history = {}
            self.current_index = -1

        state: Optional[StepState] = None
        for i in range(self.current_index + 1, index + 1):
            self.history[i] = self._save(i)
            self.current_index = i
            state = self._process_step(i)
            self.last_step_state = state

        return state if state is not None else self.last_step_state  # type: ignore[return-value]

    def run_all(self) -> RunBacktestOutput:
        if not self.is_started:
            self.start()

        while self.current_index < len(self.klines) - 1:
            next_index = self.current_index + 1
            self.history[next_index] = self._save(next_index)
            self.current_index = next_index
            self._process_step(next_index)

        return RunBacktestOutput(
            result=self._build_result(),
            diagnostics=list(self.diagnostics),
            equity_curve=self._equity_curve(),
        )

    def current_state(self) -> StepState:
        if not self.is_started or self.last_step_state is None:
            return StepState(
                current_step_index=-1,
                total_steps=len(self.klines),
                current_kline=None,
                decision=None,
                account_before=self.account.copy(),
                account_after=self.account.copy(),
                position_before=self.position.copy(),
                position_after=self.position.copy(),
            )
        return self.last_step_state

    def get_trades(self) -> List[Trade]:
        return [t.copy() for t in self.trades]

    # -- helpers ------------------------------------------------------------

    def _equity_curve(self) -> List[float]:
        return [self.equity_by_index[i] for i in sorted(self.equity_by_index)]

    def _build_result(self) -> BacktestResult:
        klines = self.klines
        last_price = klines[-1].close if klines else 0.0
        first_price = klines[0].close if klines else 0.0
        final_balance = self.account.cash + self.position.shares * last_price
        total_return_percent = (
            ((final_balance - self.initial_cash) / self.initial_cash) * 100
            if self.initial_cash > 0
            else 0.0
        )
        total_sells = sum(1 for t in self.trades if t.type == "SELL")
        winning = sum(1 for t in self.trades if t.type == "SELL" and (t.pnl or 0) > 0)
        equity_curve = self._equity_curve()

        return BacktestResult(
            id=f"backtest-{int(time.time() * 1000)}",
            user_id=self.user_id,
            symbol=self.symbol,
            start_date=klines[0].date if klines else "",
            end_date=klines[-1].date if klines else "",
            initial_balance=self.initial_cash,
            final_balance=final_balance,
            total_return_percent=total_return_percent,
            total_trades=len(self.trades),
            winning_trades=winning,
            win_rate=(winning / total_sells) * 100 if total_sells > 0 else 0.0,
            total_fees=self.total_fees,
            sharpe_ratio=sharpe_from_equity_curve(equity_curve),
            buy_hold_return_percent=(
                ((last_price - first_price) / first_price) * 100 if first_price > 0 else 0.0
            ),
            max_drawdown_percent=max_drawdown_from_equity_curve(equity_curve),
            trades=[t.copy() for t in self.trades],
            created_at=iso_now(),
        )
