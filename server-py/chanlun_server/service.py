"""Application services behind the HTTP layer (backtest run + stepper sessions).

Kept separate from ``http_api`` so the same code paths can be driven directly by
tests and by the CLI without going through sockets.
"""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

from . import config
from .klines import get_klines
from .models import Kline
from .runner import run_backtest
from .stepper import BacktestStepper
from .strategies import Strategy, find_strategy

SESSION_TTL_SECONDS = 30 * 60
MAX_SESSIONS = 8

#: 可用回测引擎. ``native`` = 手写撮合循环 (零依赖, 历史账本基准);
#: ``backtrader`` = 开源框架 backtrader 驱动同一套策略契约.
BACKTEST_ENGINES = ("native", "backtrader")
DEFAULT_ENGINE = "native"

ProgressReporter = Callable[[Dict[str, Any]], None]


class ApiError(Exception):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


# ---------------------------------------------------------------------------
# 引擎分发
# ---------------------------------------------------------------------------


def resolve_engine(payload: Dict[str, Any]) -> str:
    """Read ``engine`` from a request payload; unknown values are a 400."""
    engine = str(payload.get("engine") or DEFAULT_ENGINE).strip().lower()
    if engine not in BACKTEST_ENGINES:
        raise ApiError(
            f"未知回测引擎: {engine} (可选: {', '.join(BACKTEST_ENGINES)})", 400
        )
    return engine


def run_backtest_with_engine(engine: str, **kwargs: Any) -> Any:
    """Dispatch to the native loop or the backtrader adapter.

    ``backtrader`` is imported lazily so the server keeps running (and the test
    suite keeps passing) when the optional dependency is not installed.
    """
    if engine == "backtrader":
        try:
            from .bt_engine import run_backtest_bt
        except ImportError as exc:  # pragma: no cover - depends on the environment
            raise ApiError(
                "backtrader 引擎不可用: 请先安装 backtrader (pip install backtrader)", 501
            ) from exc
        return run_backtest_bt(**kwargs)
    return run_backtest(**kwargs)


# ---------------------------------------------------------------------------
# 数据准备
# ---------------------------------------------------------------------------


def fetch_backtest_klines(
    query: Dict[str, Any], on_progress: Optional[ProgressReporter] = None
) -> tuple[List[Kline], bool]:
    symbol = str(query.get("symbol") or "")
    period = "1w" if query.get("period") == "1w" else "1d"
    adjust = str(query.get("adjust") or "forward")
    count = int(query.get("count") or 500)
    force = bool(query.get("force"))

    if on_progress:
        adjust_label = (
            "后复权" if adjust == "backward" else "不复权" if adjust == "" else "前复权"
        )
        on_progress(
            {
                "phase": "fetching",
                "message": (
                    f"正在拉取 {symbol} 的{'周线' if period == '1w' else '日线'} "
                    f"(2023-01-01 至今, {adjust_label})…"
                ),
            }
        )

    result = get_klines(symbol, period, count, adjust, force)
    klines = result.klines

    range_start = query.get("rangeStart")
    range_end = query.get("rangeEnd")
    if range_start:
        klines = [k for k in klines if k.date >= range_start]
    if range_end:
        klines = [k for k in klines if k.date <= range_end]

    if not klines:
        raise ApiError(f"没有可用的 K 线数据 (symbol={symbol}, period={period})", 400)

    return klines, result.cached


# ---------------------------------------------------------------------------
# 单标的回测
# ---------------------------------------------------------------------------


def _require_strategy(strategy_id: str, status: int = 400) -> Strategy:
    strategy = find_strategy(strategy_id)
    if strategy is None:
        available = ", ".join(f"{s.id} ({s.name})" for s in _all_strategies())
        raise ApiError(f"策略未找到: {strategy_id}. 可用策略: {available}", status)
    return strategy


def _all_strategies() -> List[Strategy]:
    from .strategies import load_strategies

    return load_strategies()


def run_server_backtest(
    payload: Dict[str, Any], on_progress: Optional[ProgressReporter] = None
) -> Dict[str, Any]:
    """Fetch K-lines, run the strategy, return the ``PoolSymbolDetailView`` shape."""
    symbol = str(payload.get("symbol") or "")
    strategy_id = str(payload.get("strategyId") or "")
    if not symbol:
        raise ApiError("symbol is required", 400)
    if not strategy_id:
        raise ApiError("strategyId is required", 400)

    strategy = _require_strategy(strategy_id)
    engine = resolve_engine(payload)

    klines, cached = fetch_backtest_klines(payload, on_progress)

    if on_progress:
        on_progress(
            {
                "phase": "computing",
                "message": (
                    f"K 线就绪 ({len(klines)} 根, {'本地缓存' if cached else '行情源'}), "
                    f"正在运行「{strategy.name}」回测 ({engine})…"
                ),
                "klines": len(klines),
                "source": "cache" if cached else "network",
            }
        )

    output = run_backtest_with_engine(
        engine,
        klines=klines,
        symbol=symbol,
        strategy=strategy,
        user_id="server",
        initial_cash=float(payload.get("initialCash") or config.DEFAULT_INITIAL_CASH),
        currency=str(payload.get("currency") or "CNY"),
        stop_loss_percent=_optional_float(payload.get("stopLossPercent")),
        commission_rate=float(payload.get("commissionRate") or config.DEFAULT_COMMISSION_RATE),
        min_commission=float(payload.get("minCommission") or config.DEFAULT_MIN_COMMISSION),
        params=payload.get("params") or {},
        selected_indicator_ids=payload.get("selectedIndicatorIds"),
        indicators=payload.get("indicatorCodes"),
    )

    return {
        "symbol": symbol,
        "engine": engine,
        "period": "1w" if payload.get("period") == "1w" else "1d",
        "adjust": str(payload.get("adjust") or "forward"),
        "klinesCount": len(klines),
        "dateRange": {"start": klines[0].date, "end": klines[-1].date},
        "result": output.result.to_dict(),
        "diagnostics": [d.to_dict() for d in output.diagnostics],
        "equityCurve": output.equity_curve,
        "equityDates": [k.date for k in klines],
        "klines": [k.to_dict() for k in klines],
    }


def _optional_float(value: Any) -> Optional[float]:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    return None


# ---------------------------------------------------------------------------
# 逐步回测会话
# ---------------------------------------------------------------------------


@dataclass
class StepperSession:
    id: str
    symbol: str
    total_steps: int
    date_range: Dict[str, str]
    stepper: BacktestStepper
    created_at: float
    last_access_at: float


_sessions: Dict[str, StepperSession] = {}
_sessions_lock = threading.Lock()


def _prune_sessions() -> None:
    now = time.time()
    with _sessions_lock:
        for session_id, session in list(_sessions.items()):
            if now - session.last_access_at > SESSION_TTL_SECONDS:
                _sessions.pop(session_id, None)
        if len(_sessions) >= MAX_SESSIONS:
            ordered = sorted(_sessions.values(), key=lambda s: s.last_access_at)
            for session in ordered[: len(_sessions) - MAX_SESSIONS + 1]:
                _sessions.pop(session.id, None)


def _view(session: StepperSession, state: Any) -> Dict[str, Any]:
    return {
        "sessionId": session.id,
        "symbol": session.symbol,
        "engine": session.stepper.engine,
        "cached": session.stepper.cached,
        "recordSeconds": round(session.stepper.record_seconds, 3),
        "totalSteps": session.total_steps,
        "dateRange": session.date_range,
        "tradeCount": len(session.stepper.get_trades()),
        "state": state.to_dict(),
    }


def create_stepper_session(payload: Dict[str, Any]) -> Dict[str, Any]:
    symbol = str(payload.get("symbol") or "")
    strategy_id = str(payload.get("strategyId") or "")
    if not symbol:
        raise ApiError("symbol is required", 400)
    if not strategy_id:
        raise ApiError("strategyId is required", 400)

    strategy = find_strategy(strategy_id)
    if strategy is None:
        raise ApiError(f"策略未找到: {strategy_id}", 404)

    engine = resolve_engine(payload)
    klines, _cached = fetch_backtest_klines(payload)

    stepper = BacktestStepper(
        klines=klines,
        symbol=symbol,
        strategy=strategy,
        user_id="server",
        initial_cash=float(payload.get("initialCash") or config.DEFAULT_INITIAL_CASH),
        currency=str(payload.get("currency") or "CNY"),
        stop_loss_percent=_optional_float(payload.get("stopLossPercent")),
        commission_rate=float(payload.get("commissionRate") or config.DEFAULT_COMMISSION_RATE),
        min_commission=float(payload.get("minCommission") or config.DEFAULT_MIN_COMMISSION),
        params=payload.get("params") or {},
        selected_indicator_ids=payload.get("selectedIndicatorIds"),
        indicators=payload.get("indicatorCodes"),
        engine=engine,
        # ``refresh`` forces a fresh recording, same escape hatch as the K-line cache
        use_cache=not bool(payload.get("refresh")),
    )
    # One recording pass; every navigation after this is an index lookup.
    state = stepper.start()

    _prune_sessions()
    session = StepperSession(
        id=uuid.uuid4().hex,
        symbol=symbol,
        total_steps=len(klines),
        date_range={"start": klines[0].date, "end": klines[-1].date},
        stepper=stepper,
        created_at=time.time(),
        last_access_at=time.time(),
    )
    with _sessions_lock:
        _sessions[session.id] = session

    return _view(session, state)


def _require_session(session_id: str) -> StepperSession:
    _prune_sessions()
    with _sessions_lock:
        session = _sessions.get(session_id)
    if session is None:
        raise ApiError("逐步回测会话不存在或已过期", 404)
    session.last_access_at = time.time()
    return session


def step_stepper_session(session_id: str, action: str, index: Optional[int]) -> Dict[str, Any]:
    session = _require_session(session_id)
    stepper = session.stepper

    if action == "start":
        state = stepper.start()
    elif action == "backward":
        state = stepper.step_backward()
    elif action == "jump":
        if index is None:
            raise ApiError("jump 需要 index 参数", 400)
        state = stepper.jump_to(int(index))
    else:
        state = stepper.step_forward()

    return _view(session, state)


def run_all_stepper_session(session_id: str) -> Dict[str, Any]:
    session = _require_session(session_id)
    payload = session.stepper.run_all()
    return {
        "sessionId": session.id,
        "symbol": session.symbol,
        "engine": session.stepper.engine,
        "totalSteps": session.total_steps,
        "dateRange": session.date_range,
        **payload,
    }


def stepper_session_trades(session_id: str) -> Dict[str, Any]:
    session = _require_session(session_id)
    return {
        "sessionId": session.id,
        "trades": session.stepper.get_trades(),
    }


def stepper_session_timeline(session_id: str) -> Dict[str, Any]:
    """Whole simulation in one payload, for client-side scrubbing.

    Fetching this once lets the browser move between days without a round trip:
    the rows carry the day's price, decision, equity, cash, shares and how many
    fills happened, which is everything the scrubber and the day list need.
    """
    session = _require_session(session_id)
    timeline = session.stepper.timeline
    return {
        "sessionId": session.id,
        "symbol": session.symbol,
        "engine": timeline.engine,
        "cached": timeline.cached,
        "recordSeconds": round(timeline.record_seconds, 3),
        "totalSteps": timeline.total_steps,
        "dateRange": timeline.date_range,
        "rows": timeline.snapshot_rows(),
        # The whole ledger travels with the timeline so the client can show
        # "trades up to this day" without another request per step.
        "trades": timeline.trades,
    }


def close_stepper_session(session_id: str) -> bool:
    with _sessions_lock:
        return _sessions.pop(session_id, None) is not None


def active_stepper_sessions() -> int:
    _prune_sessions()
    with _sessions_lock:
        return len(_sessions)


def clear_sessions() -> None:
    """Test helper."""
    with _sessions_lock:
        _sessions.clear()
