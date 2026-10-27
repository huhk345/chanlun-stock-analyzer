"""Day-by-day simulation timeline — record once, navigate for free.

The stepper used to *re-run* the strategy every time you moved: jumping to day
900 from day 0 meant 900 strategy calls (each with a fresh ChanLun pass over the
prefix), which is why scrubbing felt slow. This module inverts that:

1. one pass over the cached K-lines records one :class:`DaySnapshot` per trading
   day (decision, fills, account, position, equity, indicators, ChanLun summary);
2. every navigation afterwards is an index lookup — forward, backward and jump
   all cost the same, and no arithmetic is ever redone (so no drift either).

The same recording hook is implemented by both engines (``runner.run_backtest``
and ``bt_engine.run_backtest_bt``), so a simulation can be replayed day by day on
either one with an identical ledger.

Recordings are also cached on disk under ``.cache/timelines/`` keyed by every
input that can change the outcome (symbol, engine, strategy source hash, params,
fees, stop-loss, bar window). Re-opening the same simulation is then a JSON read
instead of a full re-run.
"""

from __future__ import annotations

import hashlib
import inspect
import json
import pathlib
import time
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Sequence

from . import config
from .models import Account, Amount, Decision, Diagnostic, Kline, Position

#: bump when the record layout or the engine semantics change
TIMELINE_VERSION = 1

CACHE_DIR = config.CACHE_DIR.parent / "timelines"
#: one recording is ~1 MB per 900 bars, so keep the directory bounded
MAX_CACHE_FILES = 40


# ---------------------------------------------------------------------------
# 单日快照 (引擎侧写入)
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class DaySnapshot:
    """Everything that happened on one bar, as recorded by an engine."""

    index: int
    kline: Kline
    decision: Optional[Decision]
    account_after: Account
    position_after: Position
    equity: float
    trades_executed: List[Dict[str, Any]] = field(default_factory=list)
    diagnostics: List[Diagnostic] = field(default_factory=list)
    indicators: Dict[str, Any] = field(default_factory=dict)
    chanlun: Optional[Dict[str, Any]] = None

    def to_record(self) -> Dict[str, Any]:
        return {
            "index": self.index,
            "date": self.kline.date,
            "kline": self.kline.to_dict(),
            "decision": self.decision.to_dict() if self.decision is not None else None,
            "accountAfter": self.account_after.to_dict(),
            "positionAfter": self.position_after.to_dict(),
            "tradesExecuted": self.trades_executed,
            "diagnostics": [d.to_dict() for d in self.diagnostics],
            "equity": self.equity,
            "indicators": self.indicators,
            "chanlun": self.chanlun,
        }


def summarize_chanlun(structures: Any) -> Optional[Dict[str, Any]]:
    """Compact ChanLun summary for the day panel (counts + last hub bounds).

    The full structure graph is far too large to keep per day; the counts and the
    most recent hub are what a trader actually reads when asking "what did the
    strategy see on this bar?".
    """
    if structures is None:
        return None
    hubs = list(getattr(structures, "hubs", []) or [])
    last = hubs[-1] if hubs else None
    return {
        "merged": len(getattr(structures, "merged_klines", []) or []),
        "fractions": len(getattr(structures, "fractions", []) or []),
        "strokes": len(getattr(structures, "strokes", []) or []),
        "segments": len(getattr(structures, "segments", []) or []),
        "hubs": len(hubs),
        "lastHub": (
            {"zg": last.zg, "zd": last.zd, "gg": last.gg, "dd": last.dd} if last else None
        ),
    }


# ---------------------------------------------------------------------------
# 单步状态 (前端契约, 与旧 stepper.StepState 完全兼容)
# ---------------------------------------------------------------------------


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
    #: 当日收盘盯市权益 (cash + shares * close), 与 accountAfter.equity 不同:
    #: 后者只在成交时更新, 这里每天都是最新的
    equity: float = 0.0
    indicators: Dict[str, Any] = field(default_factory=dict)
    chanlun: Optional[Dict[str, Any]] = None

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
            "equity": self.equity,
            "indicators": self.indicators,
            "chanlun": self.chanlun,
        }


def _account_from(raw: Dict[str, Any]) -> Account:
    return Account(
        initial_cash=float(raw.get("initialCash") or 0.0),
        cash=float(raw.get("cash") or 0.0),
        equity=float(raw.get("equity") or 0.0),
        currency=str(raw.get("currency") or "CNY"),
    )


def _position_from(raw: Dict[str, Any]) -> Position:
    return Position(
        shares=int(raw.get("shares") or 0),
        average_cost=float(raw.get("averageCost") or 0.0),
        market_value=float(raw.get("marketValue") or 0.0),
        unrealized_pnl=float(raw.get("unrealizedPnl") or 0.0),
        unrealized_pnl_percent=float(raw.get("unrealizedPnlPercent") or 0.0),
    )


def _decision_from(raw: Optional[Dict[str, Any]]) -> Optional[Decision]:
    if not raw:
        return None
    amount = Amount.from_raw(raw.get("amount"))
    return Decision(
        action=str(raw.get("action") or "HOLD"),
        amount=amount,
        reason=raw.get("reason"),
        confidence=raw.get("confidence"),
        score=raw.get("score"),
    )


# ---------------------------------------------------------------------------
# 时间轴
# ---------------------------------------------------------------------------


@dataclass
class Timeline:
    """An ordered recording of every simulated day for one symbol + strategy."""

    symbol: str
    records: List[Dict[str, Any]]
    trades: List[Dict[str, Any]]
    result: Dict[str, Any]
    diagnostics: List[Dict[str, Any]]
    equity_curve: List[float]
    initial_account: Dict[str, Any]
    initial_position: Dict[str, Any]
    engine: str = "native"
    cached: bool = False
    #: wall-clock seconds the recording pass took (0 when served from cache)
    record_seconds: float = 0.0

    # -- navigation --------------------------------------------------------

    def __len__(self) -> int:
        return len(self.records)

    @property
    def total_steps(self) -> int:
        return len(self.records)

    @property
    def date_range(self) -> Dict[str, str]:
        if not self.records:
            return {"start": "", "end": ""}
        return {"start": self.records[0]["date"], "end": self.records[-1]["date"]}

    def clamp(self, index: int) -> int:
        if not self.records:
            return -1
        return max(0, min(int(index), len(self.records) - 1))

    def state_at(self, index: int) -> StepState:
        """Full day state (O(1) — no strategy, no ChanLun, no arithmetic)."""
        initial_account = _account_from(self.initial_account)
        initial_position = _position_from(self.initial_position)
        if not self.records:
            return StepState(
                current_step_index=-1,
                total_steps=0,
                current_kline=None,
                decision=None,
                account_before=initial_account,
                account_after=initial_account,
                position_before=initial_position,
                position_after=initial_position,
                diagnostics=[Diagnostic(level="warning", message="No K-line data provided.")],
                is_finished=True,
                equity=initial_account.equity,
            )

        i = self.clamp(index)
        record = self.records[i]
        previous = self.records[i - 1] if i > 0 else None
        return StepState(
            current_step_index=i,
            total_steps=len(self.records),
            current_kline=Kline.from_dict(record["kline"]),
            decision=_decision_from(record.get("decision")),
            account_before=(
                _account_from(previous["accountAfter"]) if previous else initial_account
            ),
            account_after=_account_from(record["accountAfter"]),
            position_before=(
                _position_from(previous["positionAfter"]) if previous else initial_position
            ),
            position_after=_position_from(record["positionAfter"]),
            trades_executed=list(record.get("tradesExecuted") or []),
            diagnostics=[
                Diagnostic(
                    level=str(d.get("level") or "warning"),
                    message=str(d.get("message") or ""),
                    date=d.get("date"),
                )
                for d in record.get("diagnostics") or []
            ],
            is_finished=i == len(self.records) - 1,
            equity=float(record.get("equity") or 0.0),
            indicators=dict(record.get("indicators") or {}),
            chanlun=record.get("chanlun"),
        )

    def trades_until(self, index: int) -> List[Dict[str, Any]]:
        """Fills that had already happened by the close of day ``index``."""
        if not self.records:
            return []
        cutoff = self.records[self.clamp(index)]["date"]
        return [t for t in self.trades if str(t.get("date", "")) <= cutoff]

    def snapshot_rows(self) -> List[Dict[str, Any]]:
        """Compact per-day rows for the client-side scrubber."""
        rows: List[Dict[str, Any]] = []
        for record in self.records:
            decision = record.get("decision") or {}
            rows.append(
                {
                    "index": record["index"],
                    "date": record["date"],
                    "close": record["kline"]["close"],
                    "action": decision.get("action") or "HOLD",
                    "reason": decision.get("reason"),
                    "equity": record.get("equity") or 0.0,
                    "cash": record["accountAfter"]["cash"],
                    "shares": record["positionAfter"]["shares"],
                    "trades": len(record.get("tradesExecuted") or []),
                    "diagnostics": len(record.get("diagnostics") or []),
                }
            )
        return rows

    # -- serialisation -----------------------------------------------------

    def to_payload(self) -> Dict[str, Any]:
        return {
            "version": TIMELINE_VERSION,
            "createdAt": int(time.time()),
            "symbol": self.symbol,
            "engine": self.engine,
            "records": self.records,
            "trades": self.trades,
            "result": self.result,
            "diagnostics": self.diagnostics,
            "equityCurve": self.equity_curve,
            "initialAccount": self.initial_account,
            "initialPosition": self.initial_position,
        }

    @staticmethod
    def from_payload(payload: Dict[str, Any]) -> Optional["Timeline"]:
        if not isinstance(payload, dict) or payload.get("version") != TIMELINE_VERSION:
            return None
        try:
            return Timeline(
                symbol=str(payload["symbol"]),
                records=list(payload["records"]),
                trades=list(payload.get("trades") or []),
                result=dict(payload["result"]),
                diagnostics=list(payload.get("diagnostics") or []),
                equity_curve=list(payload.get("equityCurve") or []),
                initial_account=dict(payload["initialAccount"]),
                initial_position=dict(payload["initialPosition"]),
                engine=str(payload.get("engine") or "native"),
                cached=True,
            )
        except (KeyError, TypeError, ValueError):
            return None

    def run_all_payload(self) -> Dict[str, Any]:
        """The ``run-all`` response body (works for cached and fresh timelines)."""
        return {
            "result": self.result,
            "diagnostics": self.diagnostics,
            "equityCurve": self.equity_curve,
            "trades": self.trades,
        }


def build_timeline(
    *,
    symbol: str,
    engine: str,
    records: Iterable[DaySnapshot],
    result: Any,
    diagnostics: Sequence[Diagnostic],
    equity_curve: Sequence[float],
    trades: Sequence[Any],
    initial_account: Account,
    initial_position: Position,
    record_seconds: float = 0.0,
) -> Timeline:
    """Assemble a :class:`Timeline` from an engine's recording pass."""
    return Timeline(
        symbol=symbol,
        records=[snapshot.to_record() for snapshot in records],
        trades=[trade.to_dict() for trade in trades],
        result=result.to_dict() if hasattr(result, "to_dict") else dict(result),
        diagnostics=[d.to_dict() for d in diagnostics],
        equity_curve=list(equity_curve),
        initial_account=initial_account.to_dict(),
        initial_position=initial_position.to_dict(),
        engine=engine,
        record_seconds=record_seconds,
    )


# ---------------------------------------------------------------------------
# 磁盘缓存
# ---------------------------------------------------------------------------


def strategy_fingerprint(strategy: Any) -> Optional[str]:
    """Hash of the strategy's code, so cached timelines invalidate on edits.

    Both the ``decide`` function body *and* its module file are hashed: the body
    catches edits to the logic, the file catches edits to module-level constants
    (``DEFAULTS``, helper functions) the body may depend on.

    Returns ``None`` when no source can be resolved (e.g. code compiled from a
    string by the sandbox), in which case the caller must skip the cache rather
    than risk serving a stale recording.
    """
    decide = getattr(strategy, "decide", None)
    if decide is None:
        return None

    digest = hashlib.sha1()
    found = False

    try:
        digest.update(inspect.getsource(decide).encode("utf-8"))
        found = True
    except (TypeError, OSError):
        pass

    try:
        path = inspect.getsourcefile(decide)
    except (TypeError, OSError):
        path = None
    if path:
        try:
            digest.update(pathlib.Path(path).read_bytes())
            found = True
        except OSError:
            pass

    return digest.hexdigest()[:16] if found else None


def cache_key(
    *,
    symbol: str,
    engine: str,
    strategy: Any,
    params: Dict[str, Any],
    initial_cash: float,
    commission_rate: float,
    min_commission: float,
    stop_loss_percent: Optional[float],
    klines: Sequence[Kline],
) -> Optional[str]:
    """Stable key for one simulation, or ``None`` when it must not be cached."""
    source = strategy_fingerprint(strategy)
    if source is None or not klines:
        return None
    material = {
        "v": TIMELINE_VERSION,
        "symbol": symbol,
        "engine": engine,
        "strategy": getattr(strategy, "id", ""),
        "source": source,
        "params": params,
        "cash": initial_cash,
        "commission": commission_rate,
        "minCommission": min_commission,
        "stopLoss": stop_loss_percent,
        "bars": [klines[0].date, klines[-1].date, len(klines)],
        # Prices can be re-based by an ex-rights refresh without the window
        # changing; a few tail closes detect that and invalidate the recording.
        "tail": [[k.date, k.close] for k in klines[-3:]],
    }
    raw = json.dumps(material, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:24]


def _cache_path(key: str) -> pathlib.Path:
    return CACHE_DIR / f"{key}.json"


def load_timeline(key: Optional[str]) -> Optional[Timeline]:
    if not key:
        return None
    try:
        raw = _cache_path(key).read_text(encoding="utf-8")
    except OSError:
        return None
    try:
        return Timeline.from_payload(json.loads(raw))
    except (json.JSONDecodeError, ValueError):
        return None


def save_timeline(key: Optional[str], timeline: Timeline) -> None:
    if not key:
        return
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        path = _cache_path(key)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(
            json.dumps(timeline.to_payload(), ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        tmp.replace(path)
        _prune_cache()
    except OSError:
        # A failed cache write must never fail the simulation.
        pass


def _prune_cache() -> None:
    try:
        files = sorted(CACHE_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    except OSError:
        return
    for stale in files[MAX_CACHE_FILES:]:
        try:
            stale.unlink()
        except OSError:
            pass


def clear_cache() -> int:
    """Delete every cached timeline; returns how many files were removed."""
    removed = 0
    if not CACHE_DIR.exists():
        return 0
    for path in list(CACHE_DIR.glob("*.json")):
        try:
            path.unlink()
            removed += 1
        except OSError:
            pass
    return removed
