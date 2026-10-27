"""Batch backtest runner.

Ported from ``server/engine/backtestRunner.ts``. One loop over bars, oldest to
newest; on each bar:

    0) resume prefix   — reuse cached state/signals, do not re-run the strategy
    1) protective stop — intraday stop order, before today's buy fill (T+1)
    2) strategy call   — input is ``klines[:i+1]``, fills at this bar's close
    3) BUY/SELL fill   — limit-up/limit-down blocking, whole lots, cash check
    4) equity snapshot — after all fills of the day

The loop never touches bar ``i + 1``; the prefix-invariance test in
``tests/part2_integration`` proves it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence

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
from .models import (
    Account,
    BacktestResult,
    Decision,
    Diagnostic,
    Kline,
    Position,
    StrategyScore,
    StrategySignal,
    Trade,
    decision_from_raw,
)
from .strategies import Strategy, StrategyContext
from .timeline import DaySnapshot, summarize_chanlun

#: 连续异常达到该次数后判定策略不可用; 之前只降级为 HOLD
MAX_CONSECUTIVE_ERRORS = 5
#: 单次回测最多保留的异常诊断条数 (避免刷屏)
MAX_ERROR_DIAGNOSTICS = 3


@dataclass(slots=True)
class ResumeSeed:
    bar_count: int
    signals: List[StrategySignal]
    scores: List[StrategyScore]
    account: Account
    position: Position
    trades: List[Trade]


@dataclass(slots=True)
class RunBacktestOutput:
    result: BacktestResult
    diagnostics: List[Diagnostic]
    equity_curve: List[float] = field(default_factory=list)
    signals: Optional[List[StrategySignal]] = None
    daily_scores: Optional[List[StrategyScore]] = None
    final_state: Optional[Dict[str, Any]] = None


def _empty_result(
    symbol: str, user_id: str, initial_cash: float, diagnostics: List[Diagnostic]
) -> RunBacktestOutput:
    diagnostics.append(
        Diagnostic(level="warning", message="No K-line data provided; backtest produced no trades.")
    )
    result = BacktestResult(
        id=f"backtest-{int(__import__('time').time() * 1000)}",
        user_id=user_id,
        symbol=symbol,
        start_date="",
        end_date="",
        initial_balance=initial_cash,
        final_balance=initial_cash,
        total_return_percent=0.0,
        total_trades=0,
        winning_trades=0,
        win_rate=0.0,
        total_fees=0.0,
        sharpe_ratio=0.0,
        buy_hold_return_percent=0.0,
        max_drawdown_percent=0.0,
        trades=[],
        created_at=iso_now(),
    )
    return RunBacktestOutput(result=result, diagnostics=diagnostics, equity_curve=[])


def run_backtest(
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
    record_signals: bool = False,
    resume: Optional[ResumeSeed] = None,
    on_bar: Optional[Callable[["DaySnapshot"], None]] = None,
) -> RunBacktestOutput:
    """Run ``strategy`` over ``klines`` bar by bar.

    ``on_bar`` is the day-by-day recording hook used by the simulation timeline:
    it receives one :class:`~chanlun_server.timeline.DaySnapshot` per bar, after
    that bar's fills and equity snapshot. Passing ``None`` (the default) costs one
    truthiness check per bar and changes nothing else.
    """
    diagnostics: List[Diagnostic] = []

    if not klines:
        return _empty_result(symbol, user_id, initial_cash, diagnostics)

    strategy_params = build_strategy_params(
        {"params": strategy.params}, params
    )

    selected_indicators: List[Any] = []
    if selected_indicator_ids:
        available = list(indicators or [])
        selected_indicators = [d for d in available if getattr(d, "id", None) in selected_indicator_ids]

    account = resume.account.copy() if resume else create_initial_account(initial_cash, currency)
    position = resume.position.copy() if resume else create_initial_position()
    trades: List[Trade] = [t.copy() for t in resume.trades] if resume else []
    resume_bars = 0
    if resume:
        resume_bars = min(max(resume.bar_count, 0), len(klines))

    signals: List[StrategySignal] = list(resume.signals) if (resume and record_signals) else []
    daily_scores: List[StrategyScore] = list(resume.scores) if (resume and record_signals) else []

    strategy_stopped = False
    consecutive_errors = 0
    has_decided_once = resume_bars > 0
    total_error_diagnostics = 0
    total_fees = 0.0

    equity_curve: List[float] = []

    for i, current_kline in enumerate(klines):
        current_price = current_kline.close

        # --- 0) 增量续算: 前缀 K 线沿用缓存信号与末端状态 ---
        if i < resume_bars:
            equity_curve.append(account.cash + position.shares * current_price)
            if on_bar is not None:
                # Prefix bars made no decision in this run; record the carried
                # state so the timeline stays dense and day-indexed.
                on_bar(
                    DaySnapshot(
                        index=i,
                        kline=current_kline,
                        decision=None,
                        account_after=account.copy(),
                        position_after=position.copy(),
                        equity=equity_curve[-1],
                    )
                )
            continue

        trades_start = len(trades)
        diagnostics_start = len(diagnostics)
        prev_close = klines[i - 1].close if i > 0 else None

        # --- 1) 固定止损 (盘中止损单) ---
        if stop_loss_percent is not None and position.shares > 0:
            exec_result = execute_protective_stop(
                bar=current_kline,
                prev_close=prev_close,
                symbol=symbol,
                stop_loss_percent=stop_loss_percent,
                sellable_shares=position.shares,
                account=account,
                position=position,
                commission_rate=commission_rate,
                min_commission=min_commission,
            )
            account = exec_result.account
            position = exec_result.position
            total_fees += exec_result.fee
            if exec_result.trade is not None:
                trades.append(exec_result.trade)
            diagnostics.extend(exec_result.diagnostics)

        # --- 2) 策略决策: 只用截止当根的数据 ---
        klines_slice = klines[: i + 1]
        indicator_values = compute_indicator_values(selected_indicators, symbol, klines_slice, i)
        strategy_params.update(indicator_values)

        chanlun = compute_chanlun_structures(klines_slice)
        ctx = StrategyContext(
            symbol=symbol,
            timeframe="daily",
            klines=klines_slice,
            current_index=i,
            current_kline=current_kline,
            account=account,
            position=position,
            trades=trades_to_snapshots(trades),
            params=strategy_params,
            currency=currency,
            initial_cash=initial_cash,
            chanlun=chanlun,
            indicators=indicator_values,
        )

        decision: Optional[Decision] = None
        if not strategy_stopped:
            try:
                decision = decision_from_raw(strategy.decide(ctx))
                consecutive_errors = 0
                has_decided_once = True
            except Exception as exc:  # noqa: BLE001 - a bad bar must not kill the run
                consecutive_errors += 1
                message = str(exc) or exc.__class__.__name__
                fatal = has_decided_once and consecutive_errors >= MAX_CONSECUTIVE_ERRORS
                if fatal:
                    strategy_stopped = True
                    diagnostics.append(
                        Diagnostic(
                            level="error",
                            date=current_kline.date,
                            message=(
                                f"Strategy threw {consecutive_errors} consecutive errors after "
                                f"{len(klines)} bars, last: {message}. Strategy will no longer be called."
                            ),
                        )
                    )
                elif total_error_diagnostics < MAX_ERROR_DIAGNOSTICS:
                    total_error_diagnostics += 1
                    diagnostics.append(
                        Diagnostic(
                            level="warning",
                            date=current_kline.date,
                            message=f"Strategy error (treated as HOLD, 后续信号继续评估): {message}",
                        )
                    )
                decision = Decision(action="HOLD", reason=f"策略异常按 HOLD 处理: {message}")

        if strategy_stopped or decision is None:
            decision = Decision.hold()

        # --- 决策校验 ---
        validation_errors = validate_decision(decision)
        if validation_errors:
            for message in validation_errors:
                diagnostics.append(
                    Diagnostic(
                        level="warning",
                        date=current_kline.date,
                        message=f"Invalid decision: {message}",
                    )
                )
            decision = Decision.hold()

        # --- 记录策略信号 (成交拦截之前, 保持策略原始观点) ---
        if record_signals and decision.action != "HOLD":
            signals.append(
                StrategySignal(
                    date=current_kline.date,
                    action=decision.action,
                    reason=decision.reason,
                    confidence=decision.confidence,
                    price=current_price,
                )
            )
        if record_signals and decision.score is not None:
            daily_scores.append(StrategyScore(date=current_kline.date, score=decision.score))

        # --- 3) 以当根收盘价成交 ---
        if decision.action != "HOLD":
            exec_result = execute_decision_at_close(
                decision=decision,
                bar=current_kline,
                prev_close=prev_close,
                symbol=symbol,
                account=account,
                position=position,
                commission_rate=commission_rate,
                min_commission=min_commission,
                strategy_label=strategy.id or strategy.name,
            )
            account = exec_result.account
            position = exec_result.position
            total_fees += exec_result.fee
            if exec_result.trade is not None:
                trades.append(exec_result.trade)
            diagnostics.extend(exec_result.diagnostics)

        # --- 4) 当日收盘权益 ---
        equity_curve.append(account.cash + position.shares * current_price)

        if on_bar is not None:
            on_bar(
                DaySnapshot(
                    index=i,
                    kline=current_kline,
                    decision=decision,
                    account_after=account.copy(),
                    position_after=position.copy(),
                    equity=equity_curve[-1],
                    trades_executed=[t.to_snapshot() for t in trades[trades_start:]],
                    diagnostics=list(diagnostics[diagnostics_start:]),
                    indicators=dict(indicator_values),
                    chanlun=summarize_chanlun(chanlun),
                )
            )

    # --- 汇总 ---
    last_price = klines[-1].close
    first_price = klines[0].close
    final_position_market_value = position.shares * last_price
    final_balance = account.cash + final_position_market_value
    total_return_percent = (
        ((final_balance - initial_cash) / initial_cash) * 100 if initial_cash > 0 else 0.0
    )
    total_sells = sum(1 for t in trades if t.type == "SELL")
    winning_trades = sum(1 for t in trades if t.type == "SELL" and (t.pnl or 0) > 0)
    win_rate = (winning_trades / total_sells) * 100 if total_sells > 0 else 0.0
    buy_hold_return_percent = (
        ((last_price - first_price) / first_price) * 100 if first_price > 0 else 0.0
    )

    result = BacktestResult(
        id=f"backtest-{int(__import__('time').time() * 1000)}",
        user_id=user_id,
        symbol=symbol,
        start_date=klines[0].date,
        end_date=klines[-1].date,
        initial_balance=initial_cash,
        final_balance=final_balance,
        total_return_percent=total_return_percent,
        total_trades=len(trades),
        winning_trades=winning_trades,
        win_rate=win_rate,
        total_fees=total_fees,
        sharpe_ratio=sharpe_from_equity_curve(equity_curve),
        buy_hold_return_percent=buy_hold_return_percent,
        max_drawdown_percent=max_drawdown_from_equity_curve(equity_curve),
        trades=trades,
        created_at=iso_now(),
    )

    return RunBacktestOutput(
        result=result,
        diagnostics=diagnostics,
        equity_curve=equity_curve,
        signals=signals if record_signals else None,
        daily_scores=daily_scores if record_signals else None,
        final_state=(
            {"account": account, "position": position, "trades": trades}
            if record_signals
            else None
        ),
    )
