"""缠论周线日线趋势策略 (thermometer) — Python port.

Behaviour is identical to ``server/strategies/chanlun-weekly-daily-thermometer.ts``:

* 周线只用「已完成周线」确认多头 (MA20 + 4 周斜率 + 结构 + 无近端卖点)
* 日线只在「已确认」的缠论买点右侧入场, 优先级 B3 > B2 > B1
* B3 必须由突破中枢的放量笔确认; 收盘连续回到中枢内即离场
* 仓位按沪深300趋势强度分档, 配合 ATR 动态止盈 / 结构止损 / 周日线卖点退出

Every decision only reads data up to the current bar, so the strategy is safe
under the engine's prefix-invariance contract.
"""

from __future__ import annotations

import json
import pathlib
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple

from ..chanlun import calculate_bs_points, compute_chanlun_structures, stroke_high, stroke_low
from ..indicators import atr, rsi
from ..models import BSPoint, Decision, Hub, Kline, MergedKline, Stroke
from ..numeric import is_finite_positive, round_half_up
from . import Strategy, StrategyContext

_DATA_FILE = pathlib.Path(__file__).with_name("data") / "market_strength.json"
_market_rows: Optional[List[List[Any]]] = None


def market_strength_rows() -> List[List[Any]]:
    """[日期, 大盘强弱评分, 买点温度, 沪深300收盘] — 2007-12-04 起."""
    global _market_rows
    if _market_rows is None:
        raw = json.loads(_DATA_FILE.read_text(encoding="utf-8"))
        _market_rows = [[row[0], float(row[1]), float(row[2]), float(row[3])] for row in raw]
    return _market_rows


DEFAULTS: Dict[str, Any] = {
    "weeklyMaPeriod": 20,
    "weeklySlopeWeeks": 4,
    "maxSignalAge": 10,
    "minBreakoutVolumeRatio": 1.5,
    "hubReturnBars": 3,
    "maxRsi": 72,
    "maxDistanceFromMa20Percent": 12,
    "minRelativeStrengthPercent": -8,
    "minimumSignalQuality": 0.7,
    "hardStopPercent": 10,
    "structureStopBufferPercent": 1.5,
    # 3×ATR 中位 9.0% → 启动瞬间止损位在成本上方约 6%; 5×ATR 会等于启动线, 等于没有保护
    "trailingAtrMultiple": 3,
    "trailingActivationPercent": 15,
    "maxHoldingBars": 60,
    "timeStopMinReturnPercent": 2,
}


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------


def number_param(ctx: StrategyContext, key: str) -> float:
    value = ctx.params.get(key)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    return float(DEFAULTS[key])


def mean_at(values: Sequence[float], end_index: int, period: int) -> Optional[float]:
    if period <= 0 or end_index + 1 < period:
        return None
    total = 0.0
    for i in range(end_index - period + 1, end_index + 1):
        total += values[i]
    return total / period


def kline_mean(
    klines: Sequence[Kline], end_index: int, period: int, field: str = "close"
) -> Optional[float]:
    if period <= 0 or end_index + 1 < period:
        return None
    total = 0.0
    for i in range(end_index - period + 1, end_index + 1):
        total += getattr(klines[i], field)
    return total / period


def _utc_ms(date: str) -> int:
    """Epoch ms for ``YYYY-MM-DD`` interpreted as UTC midnight (like Date.parse)."""
    import datetime as _dt

    d = _dt.date.fromisoformat(date[:10])
    return int(_dt.datetime(d.year, d.month, d.day, tzinfo=_dt.timezone.utc).timestamp() * 1000)


def _monday_of(date: str) -> str:
    import datetime as _dt

    d = _dt.date.fromisoformat(date[:10])
    monday = d - _dt.timedelta(days=(d.weekday()))  # Monday == 0
    return monday.isoformat()


def completed_weeks(klines: Sequence[Kline]) -> List[Kline]:
    """Aggregate daily bars into completed weeks (drop forming/partial buckets)."""
    groups: List[Tuple[str, Kline]] = []
    for bar in klines:
        key = _monday_of(bar.date)
        if groups and groups[-1][0] == key:
            last = groups[-1][1]
            last.high = max(last.high, bar.high)
            last.low = min(last.low, bar.low)
            last.close = bar.close
            last.volume += bar.volume
            last.amount += bar.amount
            last.date = bar.date
        else:
            groups.append((key, Kline(**bar.to_dict())))

    last_bar = klines[-1] if klines else None
    last_week_complete = False
    if last_bar is not None:
        import datetime as _dt

        last_week_complete = _dt.date.fromisoformat(last_bar.date[:10]).weekday() == 4  # Friday

    sliced = groups[1:] if last_week_complete else groups[1:-1]
    return [bar for _, bar in sliced]


# ---------------------------------------------------------------------------
# 周线 / 大盘上下文
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class WeeklyContext:
    bars: List[Kline]
    strokes: List[Stroke]
    hubs: List[Hub]
    points: List[BSPoint]
    bullish: bool
    weak: bool
    fresh_b3: bool
    fresh_sell: bool
    close: Optional[float]
    ma20: Optional[float]
    ma_slope_up: bool


def has_rising_hubs(hubs: Sequence[Hub]) -> bool:
    if len(hubs) < 2:
        return False
    previous = hubs[-2]
    latest = hubs[-1]
    return latest.zd > previous.zg


def has_higher_weekly_swings(strokes: Sequence[Stroke]) -> bool:
    ups = [s for s in strokes if s.direction == "up"][-2:]
    downs = [s for s in strokes if s.direction == "down"][-2:]
    return (
        len(ups) == 2
        and len(downs) == 2
        and ups[1].end.price > ups[0].end.price
        and downs[1].end.price > downs[0].end.price
    )


def confirmation_index(
    strokes: Sequence[Stroke], merged_klines: Sequence[MergedKline], point: BSPoint
) -> Optional[int]:
    """Bar index at which a BS point becomes immutable (``None`` if still open)."""
    next_index = point.stroke_index + 1
    if next_index >= len(strokes):
        return None
    next_stroke = strokes[next_index]
    merged_index = next_stroke.end.index + 1
    if merged_index < len(merged_klines):
        return merged_klines[merged_index].original_indices[0]
    return next_stroke.end.original_index


@dataclass(slots=True)
class ConfirmedPoint:
    point: BSPoint
    confirmed_at: int


def latest_confirmed_point(
    points: Sequence[BSPoint],
    strokes: Sequence[Stroke],
    merged_klines: Sequence[MergedKline],
    current_index: int,
    types: Sequence[str],
    max_age: int,
) -> Optional[ConfirmedPoint]:
    for point in reversed(points):
        if point.type not in types:
            continue
        confirmed_at = confirmation_index(strokes, merged_klines, point)
        if confirmed_at is None:
            continue
        age = current_index - confirmed_at
        if 0 <= age <= max_age:
            return ConfirmedPoint(point=point, confirmed_at=confirmed_at)
    return None


def b3_hub_range(point: BSPoint, strokes: Sequence[Stroke]) -> Optional[Dict[str, float]]:
    e = point.stroke_index
    if e - 4 < 0 or e - 2 < 0:
        return None
    first = strokes[e - 4]
    second = strokes[e - 2]
    zd = max(stroke_low(first), stroke_low(second))
    zg = min(stroke_high(first), stroke_high(second))
    return {"zd": zd, "zg": zg} if zg > zd else None


def breakout_volume_confirmed(
    point: BSPoint, strokes: Sequence[Stroke], klines: Sequence[Kline], min_ratio: float
) -> bool:
    """The breakout stroke must carry volume: its heaviest bar >= 20-bar mean * ratio."""
    breakout_index = point.stroke_index - 1
    if breakout_index < 0:
        return False
    breakout = strokes[breakout_index]
    if breakout.direction != "up":
        return False

    max_volume = 0.0
    max_volume_index = -1
    for i in range(breakout.start.original_index, breakout.end.original_index + 1):
        if 0 <= i < len(klines) and klines[i].volume > max_volume:
            max_volume = klines[i].volume
            max_volume_index = i
    if max_volume_index < 0 or max_volume <= 0:
        return False

    average_volume = kline_mean(klines, max_volume_index, 20, "volume")
    return is_finite_positive(average_volume) and max_volume >= average_volume * min_ratio


def trailing_atr_multiple_for(base_multiple: float, max_profit_percent: float) -> float:
    if max_profit_percent >= 30:
        return max(1.5, base_multiple * 2 / 3)
    if max_profit_percent >= 20:
        return max(1.5, base_multiple * 5 / 6)
    return base_multiple


def weekly_context(klines: Sequence[Kline]) -> WeeklyContext:
    bars = completed_weeks(klines)
    if not bars:
        return WeeklyContext(
            bars=[],
            strokes=[],
            hubs=[],
            points=[],
            bullish=False,
            weak=False,
            fresh_b3=False,
            fresh_sell=False,
            close=None,
            ma20=None,
            ma_slope_up=False,
        )

    structures = compute_chanlun_structures(bars)
    points = calculate_bs_points(bars, structures.strokes, confirmed_only=True)
    end_index = len(bars) - 1
    ma20 = kline_mean(bars, end_index, int(DEFAULTS["weeklyMaPeriod"]))
    ma20_at_slope_start = kline_mean(
        bars, end_index - int(DEFAULTS["weeklySlopeWeeks"]), int(DEFAULTS["weeklyMaPeriod"])
    )
    close = bars[end_index].close
    enough_history = len(bars) >= int(DEFAULTS["weeklyMaPeriod"]) + int(DEFAULTS["weeklySlopeWeeks"])
    slope_up = (
        is_finite_positive(ma20)
        and is_finite_positive(ma20_at_slope_start)
        and ma20 > ma20_at_slope_start
    )
    fresh_b3 = (
        latest_confirmed_point(points, structures.strokes, structures.merged_klines, end_index, ["B3"], 3)
        is not None
    )
    fresh_sell = (
        latest_confirmed_point(
            points, structures.strokes, structures.merged_klines, end_index, ["S1", "S2", "S3"], 2
        )
        is not None
    )
    structural_uptrend = has_rising_hubs(structures.hubs) or has_higher_weekly_swings(structures.strokes)
    bullish = (
        enough_history
        and is_finite_positive(ma20)
        and close > ma20
        and slope_up
        and structural_uptrend
        and not fresh_sell
    )
    weak = enough_history and close < (ma20 if ma20 is not None else float("inf")) and not slope_up

    return WeeklyContext(
        bars=bars,
        strokes=structures.strokes,
        hubs=structures.hubs,
        points=points,
        bullish=bullish,
        weak=weak,
        fresh_b3=fresh_b3,
        fresh_sell=fresh_sell,
        close=close,
        ma20=ma20,
        ma_slope_up=slope_up,
    )


@dataclass(slots=True)
class MarketContext:
    source: str  # benchmark | stock-fallback
    score: float
    close: float
    ma20: float
    ma60: float
    stable_trend: bool
    relative_strength_percent: Optional[float]


def stock_fallback_market_context(
    stock_klines: Sequence[Kline], index: int
) -> Optional[MarketContext]:
    close = stock_klines[index].close if 0 <= index < len(stock_klines) else None
    ma20 = kline_mean(stock_klines, index, 20)
    ma60 = kline_mean(stock_klines, index, 60)
    ma20_ten_days_ago = kline_mean(stock_klines, index - 10, 20)
    if not (
        is_finite_positive(close)
        and is_finite_positive(ma20)
        and is_finite_positive(ma60)
        and is_finite_positive(ma20_ten_days_ago)
    ):
        return None

    stable_trend = close > ma20 and close > ma60 and ma20 > ma60 and ma20 > ma20_ten_days_ago
    return MarketContext(
        source="stock-fallback",
        # Neutral, small-size fallback: stock-local data cannot estimate market breadth.
        score=50.0,
        close=close,
        ma20=ma20,
        ma60=ma60,
        stable_trend=stable_trend,
        relative_strength_percent=None,
    )


def market_context(date: str, stock_klines: Sequence[Kline], index: int) -> Optional[MarketContext]:
    """Latest market row strictly before the signal date (one-day lag)."""
    rows = market_strength_rows()

    low = 0
    high = len(rows) - 1
    row_index = -1
    while low <= high:
        mid = (low + high) >> 1
        if rows[mid][0] < date:
            row_index = mid
            low = mid + 1
        else:
            high = mid - 1

    if row_index < 0:
        return stock_fallback_market_context(stock_klines, index)

    row = rows[row_index]
    age_days = (_utc_ms(date) - _utc_ms(row[0])) / 86_400_000
    if age_days > 15:
        return stock_fallback_market_context(stock_klines, index)

    closes = [item[3] for item in rows[: row_index + 1]]
    end = len(closes) - 1
    ma20 = mean_at(closes, end, 20)
    ma60 = mean_at(closes, end, 60)
    ma20_ten_days_ago = mean_at(closes, end - 10, 20)
    if not (is_finite_positive(ma20) and is_finite_positive(ma60)):
        return stock_fallback_market_context(stock_klines, index)

    stable_trend = (
        row[3] > ma20
        and row[3] > ma60
        and ma20 > ma60
        and is_finite_positive(ma20_ten_days_ago)
        and ma20 > ma20_ten_days_ago
        and row[1] >= 50
    )

    # Align the benchmark with the latest common completed session (t-1).
    stock_close = stock_klines[index - 1].close if index >= 1 else None
    stock_old_close = stock_klines[index - 21].close if index >= 21 else None
    market_old_close = rows[row_index - 20][3] if row_index >= 20 else None
    relative_strength = (
        ((stock_close / stock_old_close - 1) - (row[3] / market_old_close - 1)) * 100
        if is_finite_positive(stock_close)
        and is_finite_positive(stock_old_close)
        and is_finite_positive(market_old_close)
        else None
    )

    return MarketContext(
        source="benchmark",
        score=row[1],
        close=row[3],
        ma20=ma20,
        ma60=ma60,
        stable_trend=stable_trend,
        relative_strength_percent=relative_strength,
    )


# ---------------------------------------------------------------------------
# 买点候选 / 仓位 / 分数
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class BuyCandidate:
    kind: str  # B1 | B2 | B3
    quality: float
    reason: str
    support_price: float
    point_date: str
    hub_upper: Optional[float]


def confirmed_point_candidate(
    found: Optional[ConfirmedPoint],
    point_type: str,
    klines: Sequence[Kline],
    index: int,
    ma20: float,
    ma20_rising: bool,
    weekly: WeeklyContext,
    hub_upper: Optional[float] = None,
) -> Optional[BuyCandidate]:
    if found is None:
        return None
    point = found.point
    bar = klines[index]
    if bar.close <= point.price or bar.close <= ma20 or bar.close <= bar.open or not ma20_rising:
        return None
    base_quality = 0.9 if point_type == "B3" else 0.82 if point_type == "B2" else 0.74
    point_name = "三买" if point_type == "B3" else "二买" if point_type == "B2" else "一买"
    quality = min(0.99, base_quality + (0.035 if weekly.fresh_b3 else 0.0))
    return BuyCandidate(
        kind=point_type,
        quality=quality,
        reason=f"{point_type}|周线多头，日线{point_name}右侧确认，收盘站上买点与 MA20",
        support_price=point.price,
        point_date=point.date,
        hub_upper=hub_upper,
    )


def allocation_percent(market: MarketContext, weekly_bullish: bool, candidate_kind: str) -> float:
    """仓位只由大盘趋势强度决定: 趋势越强, 仓位越重."""
    if market.source == "stock-fallback":
        return 25.0 if candidate_kind == "B3" and weekly_bullish and market.stable_trend else 0.0
    if not weekly_bullish or not market.stable_trend:
        return 0.0
    if market.score >= 75:
        return 100.0
    if market.score >= 60:
        return 80.0
    return 50.0


def attraction_score(
    weekly: WeeklyContext,
    market: Optional[MarketContext],
    close: float,
    daily_ma20: Optional[float],
    daily_ma20_rising: bool,
    relative_strength: Optional[float],
    has_fresh_daily_buy: bool,
) -> float:
    score = 24.0 if weekly.bullish else 0.0
    score += 10.0 if weekly.fresh_b3 else (6.0 if has_rising_hubs(weekly.hubs) else 0.0)
    if is_finite_positive(daily_ma20) and close > daily_ma20:
        score += 16.0
    if daily_ma20_rising:
        score += 10.0
    if market is not None:
        score += max(0.0, min(20.0, market.score / 100 * 20))
        if relative_strength is not None:
            score += max(0.0, min(14.0, ((relative_strength + 15) / 30) * 14))
    if has_fresh_daily_buy:
        score += 10.0
    return round_half_up(min(100.0, max(0.0, score)), 2)


def sell_all(reason: str, score: float, shares: int, confidence: float = 0.9) -> Decision:
    return Decision(
        action="SELL",
        amount={"unit": "shares", "value": shares},
        reason=reason,
        confidence=confidence,
        score=score,
    )


def current_entry_trade(ctx: StrategyContext) -> Optional[Dict[str, Any]]:
    for trade in reversed(ctx.trades):
        if trade.get("action") == "BUY":
            return trade
    return None


def entry_index_for(ctx: StrategyContext, trade_date: Optional[str]) -> Optional[int]:
    if not trade_date:
        return None
    for i, bar in enumerate(ctx.klines):
        if bar.date == trade_date:
            return i
    for i, bar in enumerate(ctx.klines):
        if bar.date > trade_date:
            return i
    return None


# ---------------------------------------------------------------------------
# 主决策
# ---------------------------------------------------------------------------


def _reason_field(reason: Optional[str], key: str) -> Optional[float]:
    """Extract ``|key=1.2345|`` style numeric fields from an entry reason."""
    if not reason:
        return None
    import re

    match = re.search(rf"(?:^|\|){key}=([0-9]+(?:\.[0-9]+)?)", reason)
    return float(match.group(1)) if match else None


def decide(ctx: StrategyContext) -> Decision:
    klines = ctx.klines
    index = min(ctx.current_index, len(klines) - 1)
    current = klines[index]
    if current is None or index < 1:
        return Decision(action="HOLD", score=0.0)

    daily_structures = ctx.chanlun if ctx.chanlun is not None else compute_chanlun_structures(list(klines))
    daily_points = calculate_bs_points(list(klines), list(daily_structures.strokes), confirmed_only=True)
    weekly = weekly_context(klines)
    market = market_context(current.date, klines, index)

    daily_ma20 = kline_mean(klines, index, 20)
    daily_ma20_five_days_ago = kline_mean(klines, index - 5, 20)
    daily_ma20_rising = (
        is_finite_positive(daily_ma20)
        and is_finite_positive(daily_ma20_five_days_ago)
        and daily_ma20 > daily_ma20_five_days_ago
    )
    distance_from_ma20 = (
        ((current.close / daily_ma20) - 1) * 100 if is_finite_positive(daily_ma20) else None
    )
    rsi_value = rsi(klines, index)
    relative_strength = market.relative_strength_percent if market else None

    max_confirm_age = int(number_param(ctx, "maxSignalAge"))
    b3 = latest_confirmed_point(
        daily_points, daily_structures.strokes, daily_structures.merged_klines, index, ["B3"], max_confirm_age
    )
    b2 = latest_confirmed_point(
        daily_points, daily_structures.strokes, daily_structures.merged_klines, index, ["B2"], max_confirm_age
    )
    b1 = latest_confirmed_point(
        daily_points, daily_structures.strokes, daily_structures.merged_klines, index, ["B1"], max_confirm_age
    )

    b3_hub = b3_hub_range(b3.point, daily_structures.strokes) if b3 else None
    b3_volume_confirmed = b3 is not None and breakout_volume_confirmed(
        b3.point,
        daily_structures.strokes,
        klines,
        number_param(ctx, "minBreakoutVolumeRatio"),
    )
    b3_candidate = (
        confirmed_point_candidate(
            b3, "B3", klines, index, daily_ma20 if daily_ma20 else float("inf"), daily_ma20_rising, weekly,
            b3_hub["zg"] if b3_hub else None,
        )
        if b3_volume_confirmed
        else None
    )
    market_stable = market is not None and market.source == "benchmark" and market.stable_trend
    b2_candidate = (
        confirmed_point_candidate(
            b2, "B2", klines, index, daily_ma20 if daily_ma20 else float("inf"), daily_ma20_rising, weekly
        )
        if market_stable
        else None
    )
    b1_candidate = (
        confirmed_point_candidate(
            b1, "B1", klines, index, daily_ma20 if daily_ma20 else float("inf"), daily_ma20_rising, weekly
        )
        if market_stable
        else None
    )
    candidate = b3_candidate or b2_candidate or b1_candidate
    score = attraction_score(
        weekly,
        market,
        current.close,
        daily_ma20,
        daily_ma20_rising,
        relative_strength,
        candidate is not None,
    )

    # ---------------------------------------------------------------- 持仓管理
    if ctx.position.shares > 0:
        entry_trade = current_entry_trade(ctx)
        entry_index = entry_index_for(ctx, entry_trade.get("date") if entry_trade else None)
        held_bars = 0 if entry_index is None else index - entry_index + 1

        if weekly.fresh_sell:
            return sell_all("[weekly-sell]|周线出现近两周确认卖点", score, ctx.position.shares, 0.95)

        if weekly.weak:
            return sell_all(
                f"[weekly-weak]|周线收盘 {weekly.close:.2f}，MA20 {weekly.ma20:.2f}，4 周斜率未向上"
                if weekly.close is not None and weekly.ma20 is not None
                else "[weekly-weak]|周线转弱，4 周斜率未向上",
                score,
                ctx.position.shares,
                0.88,
            )

        hard_stop = ctx.position.average_cost * (1 - number_param(ctx, "hardStopPercent") / 100)
        if current.close <= hard_stop:
            return sell_all(
                f"[hard-stop]|收盘低于成本 {number_param(ctx, 'hardStopPercent'):.1f}%",
                score,
                ctx.position.shares,
                0.98,
            )

        # B3 入场后跌回被突破中枢上沿下方并连续 N 根未收回 → 突破失败离场
        entry_reason = entry_trade.get("reason") if entry_trade else None
        hub_upper = _reason_field(entry_reason, "hub")
        if is_finite_positive(hub_upper) and entry_index is not None:
            required_bars = int(number_param(ctx, "hubReturnBars"))
            bars_back_inside = 0
            i = index
            while i > entry_index and bars_back_inside < required_bars:
                if klines[i].close > hub_upper:
                    break
                bars_back_inside += 1
                i -= 1
            if bars_back_inside >= required_bars:
                return sell_all(
                    f"[hub-return]|收盘连续 {bars_back_inside} 根跌回中枢上沿 {hub_upper:.2f} 下方，突破失败",
                    score,
                    ctx.position.shares,
                    0.93,
                )

        structural_support = _reason_field(entry_reason, "support")
        if not is_finite_positive(structural_support) and entry_index is not None and entry_reason:
            if entry_reason.startswith("B3|"):
                entry_b3 = next(
                    (
                        p
                        for p in daily_points
                        if p.type == "B3" and p.original_index <= entry_index and entry_index - p.original_index <= 10
                    ),
                    None,
                )
                if entry_b3:
                    structural_support = entry_b3.price
            elif entry_reason.startswith("B2|"):
                entry_b2 = next(
                    (
                        p
                        for p in daily_points
                        if p.type == "B2" and p.original_index <= entry_index and entry_index - p.original_index <= 10
                    ),
                    None,
                )
                if entry_b2:
                    structural_support = entry_b2.price
            elif entry_reason.startswith("hub-retest|"):
                support_hubs = [h for h in daily_structures.hubs if h.end_index < entry_index]
                if support_hubs:
                    structural_support = support_hubs[-1].zg
            elif entry_reason.startswith("higher-low|"):
                swing_lows = [
                    s
                    for s in daily_structures.strokes
                    if s.direction == "down" and s.end.original_index <= entry_index
                ]
                if swing_lows:
                    structural_support = swing_lows[-1].end.price

        if (
            not is_finite_positive(hub_upper)
            and is_finite_positive(structural_support)
            and current.close
            <= structural_support * (1 - number_param(ctx, "structureStopBufferPercent") / 100)
        ):
            return sell_all(
                "[structure-stop]|收盘跌破入场支撑并超过结构缓冲", score, ctx.position.shares, 0.93
            )

        atr_value = atr(klines, index)
        if entry_index is not None and is_finite_positive(atr_value):
            highest_since_entry = ctx.position.average_cost
            for i in range(entry_index + 1, index + 1):
                highest_since_entry = max(highest_since_entry, klines[i].high)
            maximum_profit_percent = ((highest_since_entry / ctx.position.average_cost) - 1) * 100
            atr_multiple = trailing_atr_multiple_for(
                number_param(ctx, "trailingAtrMultiple"), maximum_profit_percent
            )
            trailing_stop = highest_since_entry - atr_multiple * atr_value
            if (
                maximum_profit_percent >= number_param(ctx, "trailingActivationPercent")
                and current.close <= trailing_stop
            ):
                if not weekly.bullish:
                    return sell_all(
                        f"[atr-trailing-stop]|浮盈达到启动线后收盘跌破 {atr_multiple:.2f} ATR 动态移动保护位，周线多头未确认",
                        score,
                        ctx.position.shares,
                        0.9,
                    )

                entry_date = entry_trade.get("date") if entry_trade else ""
                already_trimmed = any(
                    t.get("action") == "SELL"
                    and (t.get("date") or "") >= (entry_date or "")
                    and str(t.get("reason") or "").startswith("[atr-trailing-trim]")
                    for t in ctx.trades
                )
                if not already_trimmed:
                    trim_shares = int((ctx.position.shares * 0.5) // 100) * 100
                    if trim_shares < 100 or trim_shares >= ctx.position.shares:
                        return sell_all(
                            f"[atr-trailing-stop]|触发 {atr_multiple:.2f} ATR 动态移动保护位，持仓不足一手无法减半，清仓",
                            score,
                            ctx.position.shares,
                            0.9,
                        )
                    return Decision(
                        action="SELL",
                        amount={"unit": "shares", "value": trim_shares},
                        reason="[atr-trailing-trim]|周线仍多头，首次减仓约 50%，剩余仓位等待周线或结构退出",
                        confidence=0.9,
                        score=score,
                    )

        recent_daily_sell = latest_confirmed_point(
            daily_points, daily_structures.strokes, daily_structures.merged_klines, index, ["S2", "S3"], 5
        )
        if recent_daily_sell and entry_index is not None and recent_daily_sell.point.original_index >= entry_index:
            return sell_all(
                f"[daily-{recent_daily_sell.point.type}]|日线出现确认卖点", score, ctx.position.shares, 0.88
            )

        current_return_percent = (
            ((current.close / ctx.position.average_cost) - 1) * 100
            if ctx.position.average_cost > 0
            else ctx.position.unrealized_pnl_percent
        )
        if (
            held_bars >= number_param(ctx, "maxHoldingBars")
            and current_return_percent < number_param(ctx, "timeStopMinReturnPercent")
            and not weekly.bullish
        ):
            return sell_all(
                "[time-stop]|持有达到时间上限、收益不足且周线多头未确认",
                score,
                ctx.position.shares,
                0.82,
            )

        return Decision(action="HOLD", reason="持仓管理中，周线趋势与风险条件未触发", score=score)

    # ---------------------------------------------------------------- 新开仓过滤
    if not weekly.bullish:
        return Decision(action="HOLD", reason="[filter:weekly]|等待周线多头确认", score=score)
    if market is None:
        return Decision(action="HOLD", reason="[filter:market-data]|大盘数据缺失或过期，暂停新买入", score=score)
    if candidate is None:
        return Decision(action="HOLD", reason="[filter:chanlun-point]|等待确认的日线 B3、B2 或 B1", score=score)
    if market.source == "stock-fallback" and not market.stable_trend:
        return Decision(
            action="HOLD",
            reason="[filter:stock-fallback-trend]|大盘数据已过期，个股 MA20/MA60 趋势未确认",
            score=score,
        )
    if current.close <= (daily_ma20 if daily_ma20 is not None else float("inf")) or not daily_ma20_rising or current.close <= current.open:
        return Decision(action="HOLD", reason="[filter:daily-trend]|等待日线趋势与收盘确认", score=score)
    if rsi_value is None or rsi_value > number_param(ctx, "maxRsi"):
        return Decision(action="HOLD", reason="[filter:rsi]|RSI 过热或数据不足", score=score)
    if distance_from_ma20 is None or distance_from_ma20 > number_param(ctx, "maxDistanceFromMa20Percent"):
        return Decision(action="HOLD", reason="[filter:extension]|价格离日线 MA20 过远，避免追高", score=score)
    if market.source == "benchmark" and (
        relative_strength is None or relative_strength < number_param(ctx, "minRelativeStrengthPercent")
    ):
        return Decision(
            action="HOLD", reason="[filter:relative-strength]|相对沪深300强度不足或历史数据不够", score=score
        )
    if candidate.quality < number_param(ctx, "minimumSignalQuality"):
        return Decision(action="HOLD", reason="[filter:quality]|买点质量低于最低阈值", score=score)

    percent = allocation_percent(market, weekly.bullish, candidate.kind)
    if percent <= 0:
        return Decision(
            action="HOLD", reason="[filter:allocation]|当前大盘趋势强度不足，不允许新开仓", score=score
        )

    hub_part = f"|hub={candidate.hub_upper:.4f}" if candidate.hub_upper is not None else ""
    return Decision(
        action="BUY",
        amount={"unit": "percent", "value": percent},
        reason=(
            f"{candidate.reason}|support={candidate.support_price:.4f}|point={candidate.point_date}{hub_part}"
            f"|周线{'含近端三买' if weekly.fresh_b3 else '多头结构'}，日线 MA20 上行，"
            f"大盘强度 {market.score:.1f}，数据源 {'沪深300' if market.source == 'benchmark' else '个股趋势回退'}，"
            f"仓位 {percent:g}%"
        ),
        confidence=candidate.quality,
        score=score,
    )


STRATEGY = Strategy(
    id="chanlun-weekly-daily-thermometer",
    name="缠论周线日线趋势",
    description=(
        "周线只用已完成周线确认多头，日线只在确认的缠论买点右侧入场，优先级为三买、二买、一买；"
        "一买和二买仅在市场趋势稳定时启用。B3 必须由突破中枢的放量笔确认，收盘连续回到中枢内即离场；"
        "仓位按沪深300趋势强度分档，并使用随浮盈收紧的 ATR 动态止盈、结构止损和周日线卖点退出。"
        "所有判断只使用当前回测日及之前的数据。"
    ),
    requires_chanlun=True,
    params=[
        {"key": "maxSignalAge", "label": "买点确认后最大等待交易日", "type": "number", "defaultValue": 10, "min": 0, "max": 30, "step": 1},
        {"key": "minBreakoutVolumeRatio", "label": "突破笔量能 / 20 日均量倍数", "type": "number", "defaultValue": 1.5, "min": 1, "max": 5, "step": 0.1},
        {"key": "hubReturnBars", "label": "回到中枢连续收盘根数", "type": "number", "defaultValue": 3, "min": 1, "max": 10, "step": 1},
        {"key": "maxRsi", "label": "买入 RSI 上限", "type": "number", "defaultValue": 72, "min": 50, "max": 90, "step": 1},
        {"key": "maxDistanceFromMa20Percent", "label": "距 MA20 最大涨幅 (%)", "type": "number", "defaultValue": 12, "min": 2, "max": 30, "step": 1},
        {"key": "minRelativeStrengthPercent", "label": "20 日相对强度下限 (%)", "type": "number", "defaultValue": -8, "min": -30, "max": 20, "step": 1},
        {"key": "minimumSignalQuality", "label": "最低买点质量", "type": "number", "defaultValue": 0.7, "min": 0.5, "max": 0.99, "step": 0.01},
        {"key": "hardStopPercent", "label": "收盘硬止损 (%)", "type": "number", "defaultValue": 10, "min": 3, "max": 25, "step": 0.5},
        {"key": "structureStopBufferPercent", "label": "结构止损缓冲 (%)", "type": "number", "defaultValue": 1.5, "min": 0, "max": 8, "step": 0.5},
        {"key": "trailingAtrMultiple", "label": "移动止盈 ATR 倍数", "type": "number", "defaultValue": 3, "min": 2, "max": 10, "step": 0.5},
        {"key": "trailingActivationPercent", "label": "启动移动保护的最大浮盈 (%)", "type": "number", "defaultValue": 15, "min": 5, "max": 50, "step": 1},
        {"key": "maxHoldingBars", "label": "最长持有交易日", "type": "number", "defaultValue": 60, "min": 10, "max": 250, "step": 5},
        {"key": "timeStopMinReturnPercent", "label": "时间止损最低收益 (%)", "type": "number", "defaultValue": 2, "min": -10, "max": 20, "step": 1},
    ],
    decide=decide,
)
