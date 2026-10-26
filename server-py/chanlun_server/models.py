"""Wire-contract data models.

Every model serialises to the exact camelCase JSON the existing React frontend
already consumes (see ``src/types/stock.ts`` and ``src/types/strategy.ts``), so
the Python server is a drop-in replacement for the Node one: the browser code
does not need a single change.

Internally we use snake_case attributes; ``to_dict()`` is the only place that
knows about the wire format.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


# ---------------------------------------------------------------------------
# K-line and ChanLun structures
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class Kline:
    date: str
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0
    amount: float = 0.0

    @staticmethod
    def from_dict(raw: Dict[str, Any]) -> "Kline":
        return Kline(
            date=str(raw["date"]),
            open=float(raw["open"]),
            high=float(raw["high"]),
            low=float(raw["low"]),
            close=float(raw["close"]),
            volume=float(raw.get("volume") or 0.0),
            amount=float(raw.get("amount") or 0.0),
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "date": self.date,
            "open": self.open,
            "high": self.high,
            "low": self.low,
            "close": self.close,
            "volume": self.volume,
            "amount": self.amount,
        }


def klines_from_raw(raw: Any) -> List[Kline]:
    """Coerce a JSON array into ``Kline`` objects (used by HTTP handlers)."""
    if not isinstance(raw, list):
        raise ValueError("klines must be an array")
    out: List[Kline] = []
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("klines must be an array of objects")
        for key in ("date", "open", "high", "low", "close"):
            if key not in item:
                raise ValueError(f"klines[i].{key} is required")
        out.append(Kline.from_dict(item))
    return out


def klines_to_dicts(klines: List[Kline]) -> List[Dict[str, Any]]:
    return [k.to_dict() for k in klines]


@dataclass(slots=True)
class MergedKline:
    high: float
    low: float
    direction: str  # 'up' | 'down'
    original_indices: List[int]
    original_high: float
    original_low: float

    def to_dict(self) -> Dict[str, Any]:
        return {
            "high": self.high,
            "low": self.low,
            "direction": self.direction,
            "originalIndices": list(self.original_indices),
            "originalHigh": self.original_high,
            "originalLow": self.original_low,
        }


@dataclass(slots=True)
class Fraction:
    type: str  # 'TOP' | 'BOTTOM'
    price: float
    index: int  # index in the merged array
    original_index: int  # index in the original array
    date: str

    def to_dict(self) -> Dict[str, Any]:
        return {
            "type": self.type,
            "price": self.price,
            "index": self.index,
            "originalIndex": self.original_index,
            "date": self.date,
        }


@dataclass(slots=True)
class Stroke:
    id: str
    start: Fraction
    end: Fraction
    direction: str

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "start": self.start.to_dict(),
            "end": self.end.to_dict(),
            "direction": self.direction,
        }


@dataclass(slots=True)
class Segment:
    id: str
    start: Fraction
    end: Fraction
    direction: str

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "start": self.start.to_dict(),
            "end": self.end.to_dict(),
            "direction": self.direction,
        }


@dataclass(slots=True)
class Hub:
    id: str
    zg: float
    zd: float
    gg: float
    dd: float
    start_index: int
    end_index: int
    strokes_count: int
    level: int

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "zg": self.zg,
            "zd": self.zd,
            "gg": self.gg,
            "dd": self.dd,
            "startIndex": self.start_index,
            "endIndex": self.end_index,
            "strokesCount": self.strokes_count,
            "level": self.level,
        }


@dataclass(slots=True)
class BSPoint:
    id: str
    type: str  # B1 B2 B3 S1 S2 S3
    label: str
    price: float
    original_index: int
    date: str
    stroke_index: int

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "type": self.type,
            "label": self.label,
            "price": self.price,
            "originalIndex": self.original_index,
            "date": self.date,
            "strokeIndex": self.stroke_index,
        }


@dataclass(slots=True)
class ChanlunStructures:
    merged_klines: List[MergedKline]
    fractions: List[Fraction]
    strokes: List[Stroke]
    segments: List[Segment]
    hubs: List[Hub]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "mergedKlines": [m.to_dict() for m in self.merged_klines],
            "fractions": [f.to_dict() for f in self.fractions],
            "strokes": [s.to_dict() for s in self.strokes],
            "segments": [s.to_dict() for s in self.segments],
            "hubs": [h.to_dict() for h in self.hubs],
        }


# ---------------------------------------------------------------------------
# Account / position / trades
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class Account:
    initial_cash: float
    cash: float
    equity: float
    currency: str = "CNY"

    def copy(self) -> "Account":
        return Account(self.initial_cash, self.cash, self.equity, self.currency)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "initialCash": self.initial_cash,
            "cash": self.cash,
            "equity": self.equity,
            "currency": self.currency,
        }


@dataclass(slots=True)
class Position:
    shares: int = 0
    average_cost: float = 0.0
    market_value: float = 0.0
    unrealized_pnl: float = 0.0
    unrealized_pnl_percent: float = 0.0

    def copy(self) -> "Position":
        return Position(
            self.shares,
            self.average_cost,
            self.market_value,
            self.unrealized_pnl,
            self.unrealized_pnl_percent,
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "shares": self.shares,
            "averageCost": self.average_cost,
            "marketValue": self.market_value,
            "unrealizedPnl": self.unrealized_pnl,
            "unrealizedPnlPercent": self.unrealized_pnl_percent,
        }


@dataclass(slots=True)
class Trade:
    id: str
    type: str  # BUY | SELL
    signal_type: str
    price: float
    date: str
    shares: int
    value: float
    fee: float = 0.0
    reason: Optional[str] = None
    confidence: Optional[float] = None
    pnl: Optional[float] = None
    pnl_percent: Optional[float] = None

    def copy(self) -> "Trade":
        return Trade(
            id=self.id,
            type=self.type,
            signal_type=self.signal_type,
            price=self.price,
            date=self.date,
            shares=self.shares,
            value=self.value,
            fee=self.fee,
            reason=self.reason,
            confidence=self.confidence,
            pnl=self.pnl,
            pnl_percent=self.pnl_percent,
        )

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "id": self.id,
            "type": self.type,
            "signalType": self.signal_type,
            "price": self.price,
            "date": self.date,
            "shares": self.shares,
            "value": self.value,
            "fee": self.fee,
        }
        if self.reason is not None:
            out["reason"] = self.reason
        if self.confidence is not None:
            out["confidence"] = self.confidence
        if self.pnl is not None:
            out["pnl"] = self.pnl
        if self.pnl_percent is not None:
            out["pnlPercent"] = self.pnl_percent
        return out

    def to_snapshot(self) -> Dict[str, Any]:
        """Shape exposed to strategies as ``input.trades``."""
        return {
            "id": self.id,
            "date": self.date,
            "action": self.type,
            "price": self.price,
            "shares": self.shares,
            "value": self.value,
            "fee": self.fee,
            "reason": self.reason if self.reason is not None else self.signal_type,
        }


@dataclass(slots=True)
class Diagnostic:
    message: str
    level: str = "warning"  # warning | error
    date: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"level": self.level, "message": self.message}
        if self.date is not None:
            out["date"] = self.date
        return out


# ---------------------------------------------------------------------------
# Strategy decision
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class Amount:
    unit: str  # cash | shares | percent
    value: float

    def to_dict(self) -> Dict[str, Any]:
        return {"unit": self.unit, "value": self.value}

    @staticmethod
    def from_raw(raw: Any) -> Optional["Amount"]:
        if not isinstance(raw, dict):
            return None
        unit = raw.get("unit")
        value = raw.get("value")
        if not isinstance(unit, str):
            return None
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            return None
        return Amount(unit=unit, value=float(value))


@dataclass(slots=True)
class Decision:
    action: str = "HOLD"  # BUY | SELL | HOLD
    amount: Optional[Amount] = None
    reason: Optional[str] = None
    confidence: Optional[float] = None
    score: Optional[float] = None

    def __post_init__(self) -> None:
        # Strategies may hand back ``{"unit": ..., "value": ...}``; normalise once
        # so the engine only ever deals with ``Amount``.
        if isinstance(self.amount, dict):
            self.amount = Amount.from_raw(self.amount)
        if isinstance(self.action, str):
            self.action = self.action.upper()

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"action": self.action}
        if self.amount is not None:
            out["amount"] = self.amount.to_dict()
        if self.reason is not None:
            out["reason"] = self.reason
        if self.confidence is not None:
            out["confidence"] = self.confidence
        if self.score is not None:
            out["score"] = self.score
        return out

    @staticmethod
    def hold() -> "Decision":
        return Decision(action="HOLD")


def decision_from_raw(raw: Any) -> Decision:
    """Normalise anything a strategy returned into a ``Decision``.

    Strategies are plain Python callables, so they may return a ``Decision``, a
    dict, or nothing at all. Anything unrecognised becomes HOLD instead of
    crashing the whole run.
    """
    if raw is None:
        return Decision.hold()
    if isinstance(raw, Decision):
        return raw
    if isinstance(raw, dict):
        action = raw.get("action")
        if not isinstance(action, str):
            return Decision.hold()
        confidence = raw.get("confidence")
        score = raw.get("score")
        return Decision(
            action=action,
            amount=Amount.from_raw(raw.get("amount")),
            reason=raw.get("reason") if isinstance(raw.get("reason"), str) else None,
            confidence=float(confidence)
            if isinstance(confidence, (int, float)) and not isinstance(confidence, bool)
            else None,
            score=float(score)
            if isinstance(score, (int, float)) and not isinstance(score, bool)
            else None,
        )
    return Decision.hold()


@dataclass(slots=True)
class StrategySignal:
    date: str
    action: str
    price: float
    reason: Optional[str] = None
    confidence: Optional[float] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"date": self.date, "action": self.action, "price": self.price}
        if self.reason is not None:
            out["reason"] = self.reason
        if self.confidence is not None:
            out["confidence"] = self.confidence
        return out


@dataclass(slots=True)
class StrategyScore:
    date: str
    score: float

    def to_dict(self) -> Dict[str, Any]:
        return {"date": self.date, "score": self.score}


# ---------------------------------------------------------------------------
# Backtest report
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class BacktestResult:
    id: str
    user_id: str
    symbol: str
    start_date: str
    end_date: str
    initial_balance: float
    final_balance: float
    total_return_percent: float
    total_trades: int
    winning_trades: int
    win_rate: float
    total_fees: float
    sharpe_ratio: float
    buy_hold_return_percent: float
    max_drawdown_percent: float
    trades: List[Trade] = field(default_factory=list)
    created_at: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "userId": self.user_id,
            "symbol": self.symbol,
            "startDate": self.start_date,
            "endDate": self.end_date,
            "initialBalance": self.initial_balance,
            "finalBalance": self.final_balance,
            "totalReturnPercent": self.total_return_percent,
            "totalTrades": self.total_trades,
            "winningTrades": self.winning_trades,
            "winRate": self.win_rate,
            "totalFees": self.total_fees,
            "sharpeRatio": self.sharpe_ratio,
            "buyHoldReturnPercent": self.buy_hold_return_percent,
            "maxDrawdownPercent": self.max_drawdown_percent,
            "trades": [t.to_dict() for t in self.trades],
            "createdAt": self.created_at,
        }


def diagnostics_to_dicts(diagnostics: List[Diagnostic]) -> List[Dict[str, Any]]:
    return [d.to_dict() for d in diagnostics]
