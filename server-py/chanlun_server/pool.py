"""Stock-pool backtest: run one strategy over 沪深300 / 中证500 and aggregate.

Ported from ``server/poolBacktest.ts``. Each symbol is backtested independently
with the same notional cash, then results are combined equal-weight:

* 组合收益 = 各标的策略收益的等权平均
* 组合权益曲线 = 各标的归一化权益 (÷ 名义本金) 的逐日平均, 缺失日沿用最近一次
  权益 (上市前/停牌 ≈ 持币)
* 单只标的的完整明细按需返回, 供前端点击排行榜某一行时画图

Job model: one running job at a time; a request with identical parameters attaches
to it instead of starting a second one.
"""

from __future__ import annotations

import json
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

from . import config
from .klines import get_klines
from .metrics import max_drawdown_from_equity_curve, sharpe_from_equity_curve
from .models import Kline
from .service import resolve_engine, run_backtest_with_engine
from .strategies import find_strategy

CONCURRENCY = 4
DEFAULT_COUNT = 400
DEFAULT_PER_SYMBOL_CASH = 100_000.0
MAX_FAILURES = 50
JOB_TTL_SECONDS = 30 * 60
MAX_JOBS = 3
MAX_FETCH_FAILURES_BEFORE_ABORT = 40

ASHARE_RE = re.compile(r"^\d{6}\.(SH|SZ|BJ)$")
INDEX_LABELS = {"hs300": "沪深300", "zz500": "中证500"}

#: 可排除板块 -> 代码前缀。创业板 / 科创板 / 北交所均有投资者适当性门槛。
EXCLUDABLE_BOARDS: Dict[str, Tuple[str, ...]] = {
    "chinext": ("300", "301"),
    "star": ("688", "689"),
    "bse": ("43", "83", "87", "88", "92"),
}


def a_share_board(symbol: str) -> str:
    """6 位代码或带后缀的 A 股代码 -> 板块 id (main / chinext / star / bse)。"""
    code = str(symbol or "").strip().upper().split(".", 1)[0]
    if code.startswith(EXCLUDABLE_BOARDS["chinext"]):
        return "chinext"
    if code.startswith(EXCLUDABLE_BOARDS["star"]):
        return "star"
    if code.startswith(EXCLUDABLE_BOARDS["bse"]) or str(symbol or "").strip().upper().endswith(".BJ"):
        return "bse"
    return "main"


def normalize_excluded_boards(value: Any) -> List[str]:
    """过滤非法板块 id, 保持去重后的稳定顺序。"""
    if not isinstance(value, (list, tuple, set)):
        return []
    out: List[str] = []
    for item in value:
        board = str(item)
        if board in EXCLUDABLE_BOARDS and board not in out:
            out.append(board)
    return out


# ---------------------------------------------------------------------------
# 股票池 / 元数据
# ---------------------------------------------------------------------------


def load_index_members(index_id: str) -> List[str]:
    candidates = [
        config.PUBLIC_DIR / f"index-members.{index_id}.json",
        config.DATA_DIR / index_id / "_constituents.json",
    ]
    for path in candidates:
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(raw, list) and raw:
            return [s for s in raw if isinstance(s, str) and ASHARE_RE.match(s)]
    raise ValueError(f"{INDEX_LABELS.get(index_id, index_id)} 成分股列表不可用")


_meta_cache: Optional[Dict[str, Dict[str, str]]] = None


def load_stock_meta() -> Dict[str, Dict[str, str]]:
    """code(6位) -> {name, industry} from public/merged_stock_data.json."""
    global _meta_cache
    if _meta_cache is not None:
        return _meta_cache
    meta: Dict[str, Dict[str, str]] = {}
    try:
        raw = json.loads((config.PUBLIC_DIR / "merged_stock_data.json").read_text(encoding="utf-8"))
        for code, info in (raw or {}).items():
            if not isinstance(info, dict):
                continue
            meta[code] = {
                "name": str(info.get("stock_name") or ""),
                "industry": str(info.get("industry") or ""),
            }
    except (OSError, json.JSONDecodeError):
        meta = {}
    _meta_cache = meta
    return meta


def build_universe(
    indexes: Sequence[str],
    custom: Sequence[str],
    exclude_boards: Optional[Sequence[str]] = None,
) -> List[str]:
    universe: List[str] = []
    seen: set[str] = set()

    def push(symbol: str) -> None:
        if symbol in seen:
            return
        seen.add(symbol)
        universe.append(symbol)

    for index_id in indexes:
        if index_id in INDEX_LABELS:
            for symbol in load_index_members(index_id):
                push(symbol)
    for symbol in custom:
        if isinstance(symbol, str) and ASHARE_RE.match(symbol):
            push(symbol)

    excluded = set(normalize_excluded_boards(exclude_boards))
    if excluded:
        universe = [s for s in universe if a_share_board(s) not in excluded]

    if not universe:
        if excluded:
            raise ValueError("筛选后股票池为空, 请减少排除板块或扩大回测范围")
        raise ValueError("扫描范围为空, 请至少选择一个指数或添加自定义标的")
    return universe


# ---------------------------------------------------------------------------
# 等权组合曲线
# ---------------------------------------------------------------------------


def build_portfolio_curve(
    series: Sequence[Tuple[List[str], List[float]]], initial_cash: float
) -> Tuple[List[float], List[str]]:
    if not series:
        return [], []

    all_dates = sorted({date for dates, _ in series for date in dates})
    if not all_dates:
        return [], []

    cursors = [0] * len(series)
    last_value = [1.0] * len(series)  # 上市前/停牌按持币处理
    equity: List[float] = []

    for date in all_dates:
        total = 0.0
        for idx, (dates, fractions) in enumerate(series):
            cursor = cursors[idx]
            while cursor < len(dates) and dates[cursor] <= date:
                last_value[idx] = fractions[cursor]
                cursor += 1
            cursors[idx] = cursor
            total += last_value[idx]
        equity.append((total / len(series)) * initial_cash)

    return equity, all_dates


def _mean(values: Sequence[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _median(values: Sequence[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2 == 0:
        return (ordered[mid - 1] + ordered[mid]) / 2
    return ordered[mid]


# ---------------------------------------------------------------------------
# 任务
# ---------------------------------------------------------------------------


@dataclass
class PoolJob:
    id: str
    input: Dict[str, Any]
    state: str = "running"
    started_at: float = field(default_factory=lambda: time.time() * 1000)
    finished_at: Optional[float] = None
    error: Optional[str] = None
    progress: Dict[str, int] = field(
        default_factory=lambda: {"total": 0, "done": 0, "ok": 0, "failed": 0, "traded": 0, "cached": 0}
    )
    active: List[str] = field(default_factory=list)
    rows: List[Dict[str, Any]] = field(default_factory=list)
    details: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    failures: List[Dict[str, str]] = field(default_factory=list)
    summary: Optional[Dict[str, Any]] = None
    cancelled: bool = False
    created_at: float = field(default_factory=time.time)

    # -- views ------------------------------------------------------------

    def view(self) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "id": self.id,
            "state": self.state,
            "progress": dict(self.progress),
            "active": list(self.active),
            "startedAt": int(self.started_at),
            "input": self.input,
        }
        if self.finished_at is not None:
            payload["finishedAt"] = int(self.finished_at)
        if self.error:
            payload["error"] = self.error
        if self.summary is not None:
            payload["result"] = self.summary
        return payload

    def symbol_detail(self, symbol: str) -> Optional[Dict[str, Any]]:
        return self.details.get(symbol)

    def all_trades(self) -> Dict[str, Any]:
        rows: List[Dict[str, Any]] = []
        meta = load_stock_meta()
        for symbol, detail in self.details.items():
            code = symbol.split(".")[0]
            for trade in detail["result"]["trades"]:
                rows.append(
                    {
                        "symbol": symbol,
                        "code": code,
                        "name": meta.get(code, {}).get("name") or None,
                        "date": trade["date"],
                        "type": trade["type"],
                        "signalType": trade["signalType"],
                        "reason": trade.get("reason"),
                        "price": trade["price"],
                        "shares": trade["shares"],
                        "value": trade["value"],
                        "fee": trade.get("fee", 0.0),
                        "pnl": trade.get("pnl"),
                        "pnlPercent": trade.get("pnlPercent"),
                    }
                )
        rows.sort(key=lambda r: (r["date"], r["symbol"]))
        return {"trades": rows, "total": len(rows)}

    def cancel(self) -> None:
        self.cancelled = True
        if self.state == "running":
            self.state = "cancelled"
            self.finished_at = time.time() * 1000


_jobs: Dict[str, PoolJob] = {}
_running: Optional[PoolJob] = None
_jobs_lock = threading.Lock()


class PoolBusy(Exception):
    """Another pool job is running with different parameters."""

    def __init__(self, job_id: str, message: str = "已有选股池回测正在运行, 请稍后再试") -> None:
        super().__init__(message)
        self.job_id = job_id


def _prune_jobs() -> None:
    now = time.time()
    for job_id, job in list(_jobs.items()):
        if job.state == "running":
            continue
        if now - job.created_at > JOB_TTL_SECONDS:
            _jobs.pop(job_id, None)
    if len(_jobs) >= MAX_JOBS:
        ordered = sorted(_jobs.values(), key=lambda j: j.created_at)
        for job in ordered[: len(_jobs) - MAX_JOBS + 1]:
            if job.state != "running":
                _jobs.pop(job.id, None)


def get_pool_backtest_job(job_id: str) -> Optional[PoolJob]:
    with _jobs_lock:
        _prune_jobs()
        return _jobs.get(job_id)


def _job_key(payload: Dict[str, Any]) -> Tuple[Any, ...]:
    return (
        payload.get("engine") or "native",
        payload.get("strategyId"),
        tuple(sorted(payload.get("indexes") or [])),
        tuple(sorted(payload.get("custom") or [])),
        tuple(sorted(normalize_excluded_boards(payload.get("excludeBoards")))),
        payload.get("period") or "1d",
        payload.get("adjust") or "forward",
        payload.get("initialCash") or DEFAULT_PER_SYMBOL_CASH,
        payload.get("stopLossPercent"),
        json.dumps(payload.get("params") or {}, sort_keys=True),
        payload.get("rangeStart"),
        payload.get("rangeEnd"),
    )


def request_pool_backtest(payload: Dict[str, Any]) -> Tuple[PoolJob, bool]:
    """Start a job (or attach to the identical running one)."""
    global _running

    strategy_id = str(payload.get("strategyId") or "")
    if not strategy_id:
        raise ValueError("strategyId is required")
    strategy = find_strategy(strategy_id)
    if strategy is None:
        raise ValueError(f"策略未找到: {strategy_id}")
    # 引擎校验提前到请求阶段, 免得坏参数在后台线程里才炸
    resolve_engine(payload)

    with _jobs_lock:
        if _running is not None and _running.state == "running":
            if _job_key(_running.input) == _job_key(payload):
                return _running, True
            raise PoolBusy(_running.id)

        job = PoolJob(id=uuid.uuid4().hex, input=payload)
        _prune_jobs()
        _jobs[job.id] = job
        _running = job

    thread = threading.Thread(target=_run_job, args=(job, strategy, payload), daemon=True)
    thread.start()
    return job, False


def _run_job(job: PoolJob, strategy: Any, payload: Dict[str, Any]) -> None:
    global _running
    try:
        indexes = [str(i) for i in (payload.get("indexes") or [])]
        custom = [str(s) for s in (payload.get("custom") or [])]
        exclude_boards = normalize_excluded_boards(payload.get("excludeBoards"))
        universe = build_universe(indexes, custom, exclude_boards)

        period = "1w" if payload.get("period") == "1w" else "1d"
        adjust = str(payload.get("adjust") or "forward")
        initial_cash = float(payload.get("initialCash") or DEFAULT_PER_SYMBOL_CASH)
        commission_rate = float(payload.get("commissionRate") or config.DEFAULT_COMMISSION_RATE)
        min_commission = float(payload.get("minCommission") or config.DEFAULT_MIN_COMMISSION)
        stop_loss = payload.get("stopLossPercent")
        stop_loss = float(stop_loss) if isinstance(stop_loss, (int, float)) else None
        params = payload.get("params") or {}
        range_start = payload.get("rangeStart")
        range_end = payload.get("rangeEnd")
        force = bool(payload.get("force"))
        engine = str(payload.get("engine") or "native")

        job.progress["total"] = len(universe)
        meta = load_stock_meta()
        series: List[Tuple[List[str], List[float]]] = []
        fetch_failures = 0

        def work(symbol: str) -> None:
            nonlocal fetch_failures
            if job.cancelled:
                return
            job.active.append(symbol)
            try:
                result = get_klines(symbol, period, DEFAULT_COUNT, adjust, force)
                klines: List[Kline] = result.klines
                if range_start:
                    klines = [k for k in klines if k.date >= range_start]
                if range_end:
                    klines = [k for k in klines if k.date <= range_end]
                if not klines:
                    raise ValueError("没有可用的 K 线数据")

                output = run_backtest_with_engine(
                    engine,
                    klines=klines,
                    symbol=symbol,
                    strategy=strategy,
                    user_id="pool",
                    initial_cash=initial_cash,
                    currency="CNY",
                    stop_loss_percent=stop_loss,
                    commission_rate=commission_rate,
                    min_commission=min_commission,
                    params=params,
                )
                report = output.result
                code = symbol.split(".")[0]
                job.rows.append(
                    {
                        "symbol": symbol,
                        "code": code,
                        "name": meta.get(code, {}).get("name"),
                        "industry": meta.get(code, {}).get("industry"),
                        "initialBalance": report.initial_balance,
                        "finalBalance": report.final_balance,
                        "returnPercent": report.total_return_percent,
                        "buyHoldPercent": report.buy_hold_return_percent,
                        "excessPercent": report.total_return_percent - report.buy_hold_return_percent,
                        "trades": report.total_trades,
                        "winRate": report.win_rate,
                        "sharpeRatio": report.sharpe_ratio,
                        "maxDrawdownPercent": report.max_drawdown_percent,
                        "fees": report.total_fees,
                        "klinesCount": len(klines),
                        "dateRange": {"start": klines[0].date, "end": klines[-1].date},
                    }
                )
                job.details[symbol] = {
                    "symbol": symbol,
                    "period": period,
                    "adjust": adjust,
                    "klinesCount": len(klines),
                    "dateRange": {"start": klines[0].date, "end": klines[-1].date},
                    "result": report.to_dict(),
                    "diagnostics": [d.to_dict() for d in output.diagnostics],
                    "equityCurve": output.equity_curve,
                    "equityDates": [k.date for k in klines],
                    "klines": [k.to_dict() for k in klines],
                }
                series.append(
                    ([k.date for k in klines], [v / initial_cash for v in output.equity_curve])
                )

                job.progress["ok"] += 1
                if report.total_trades > 0:
                    job.progress["traded"] += 1
                if result.cached:
                    job.progress["cached"] += 1
            except Exception as exc:  # noqa: BLE001
                fetch_failures += 1
                job.progress["failed"] += 1
                if len(job.failures) < MAX_FAILURES:
                    job.failures.append({"symbol": symbol, "error": str(exc)})
            finally:
                job.progress["done"] += 1
                if symbol in job.active:
                    job.active.remove(symbol)

        with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
            list(pool.map(work, universe))

        if job.cancelled:
            job.state = "cancelled"
            job.finished_at = time.time() * 1000
            return

        job.summary = _build_summary(job, initial_cash, series)
        job.state = "done"
        job.finished_at = time.time() * 1000
    except Exception as exc:  # noqa: BLE001
        job.state = "error"
        job.error = str(exc)
        job.finished_at = time.time() * 1000
    finally:
        with _jobs_lock:
            if _running is job:
                _running = None


def _build_summary(
    job: PoolJob, initial_cash: float, series: Sequence[Tuple[List[str], List[float]]]
) -> Dict[str, Any]:
    rows = sorted(job.rows, key=lambda r: r["returnPercent"], reverse=True)
    returns = [r["returnPercent"] for r in rows]
    buy_holds = [r["buyHoldPercent"] for r in rows]
    profitable = sum(1 for r in rows if r["returnPercent"] > 0)
    beat = sum(1 for r in rows if r["excessPercent"] > 0)

    equity_curve, equity_dates = build_portfolio_curve(series, initial_cash)
    final_equity = equity_curve[-1] if equity_curve else initial_cash
    total_return = ((final_equity - initial_cash) / initial_cash) * 100 if initial_cash else 0.0

    date_range = {"start": "", "end": ""}
    if equity_dates:
        date_range = {"start": equity_dates[0], "end": equity_dates[-1]}

    tested = len(rows)
    return {
        "universeSize": job.progress["total"],
        "tested": tested,
        "failed": job.progress["failed"],
        "traded": job.progress["traded"],
        "profitable": profitable,
        "beatBuyHold": beat,
        "initialCash": initial_cash,
        "finalEquity": final_equity,
        "totalReturnPercent": total_return,
        "buyHoldReturnPercent": _mean(buy_holds),
        "maxDrawdownPercent": max_drawdown_from_equity_curve(equity_curve, initial_cash),
        "sharpeRatio": sharpe_from_equity_curve(equity_curve),
        "symbolWinRate": (profitable / tested) * 100 if tested else 0.0,
        "beatBuyHoldRate": (beat / tested) * 100 if tested else 0.0,
        "meanReturnPercent": _mean(returns),
        "medianReturnPercent": _median(returns),
        "totalTrades": sum(r["trades"] for r in rows),
        "totalFees": sum(r["fees"] for r in rows),
        "equityCurve": equity_curve,
        "equityDates": equity_dates,
        "dateRange": date_range,
        "rows": rows,
        "failures": job.failures,
    }
