"""ChanLun (缠论) structure recognition.

Faithful port of ``src/utils/chanlun.ts`` so that the Python engine produces
byte-identical structures to the TypeScript one:

    merge_klines      包含关系合并
    find_fractions    顶/底分型
    calculate_strokes 笔 (两遍过滤法, min_distance=4)
    calculate_segments 线段 (笔级别分型, min_distance=3)
    calculate_hubs    中枢 (三笔重叠区间 + 延伸)
    calculate_bs_points 一二三类买卖点 (移植自 czsc Rust 实现)

Everything here is pure: same input -> same output, no IO, no clock.
"""

from __future__ import annotations

from typing import Dict, List, Sequence, Set

from .models import (
    BSPoint,
    ChanlunStructures,
    Fraction,
    Hub,
    Kline,
    MergedKline,
    Segment,
    Stroke,
)
from .numeric import round_half_up

BS_LABELS: Dict[str, str] = {
    "B1": "一买",
    "B2": "二买",
    "B3": "三买",
    "S1": "一卖",
    "S2": "二卖",
    "S3": "三卖",
}

#: 一类买卖点检测窗口, 对齐 cxt_first_buy_V221126 的 [21..5] 奇数序列
BS1_WINDOWS: Sequence[int] = (21, 19, 17, 15, 13, 11, 9, 7, 5)


# ---------------------------------------------------------------------------
# Step 1: 包含关系处理
# ---------------------------------------------------------------------------


def merge_klines(klines: Sequence[Kline]) -> List[MergedKline]:
    """Combine overlapping K-lines.

    Upward containment: merged high = max(H1, H2), merged low = max(L1, L2)
    Downward containment: merged high = min(H1, H2), merged low = min(L1, L2)
    """
    if not klines:
        return []

    merged: List[MergedKline] = [
        MergedKline(
            high=klines[0].high,
            low=klines[0].low,
            direction="up",
            original_indices=[0],
            original_high=klines[0].high,
            original_low=klines[0].low,
        )
    ]

    for i in range(1, len(klines)):
        k = klines[i]
        last = merged[-1]

        last_contains_current = last.high >= k.high and last.low <= k.low
        current_contains_last = k.high >= last.high and k.low <= last.low

        if last_contains_current or current_contains_last:
            if len(merged) > 1:
                prev = merged[-2]
                if last.high > prev.high:
                    direction = "up"
                elif last.high < prev.high:
                    direction = "down"
                else:
                    direction = last.direction
            else:
                direction = last.direction

            if direction == "up":
                new_high = max(last.high, k.high)
                new_low = max(last.low, k.low)
            else:
                new_high = min(last.high, k.high)
                new_low = min(last.low, k.low)

            last.high = new_high
            last.low = new_low
            last.direction = direction
            last.original_indices.append(i)
            last.original_high = max(last.original_high, k.high)
            last.original_low = min(last.original_low, k.low)
        else:
            next_dir = "up" if k.high > last.high else "down"
            merged.append(
                MergedKline(
                    high=k.high,
                    low=k.low,
                    direction=next_dir,
                    original_indices=[i],
                    original_high=k.high,
                    original_low=k.low,
                )
            )

    return merged


# ---------------------------------------------------------------------------
# Step 2: 分型
# ---------------------------------------------------------------------------


def find_fractions(merged: Sequence[MergedKline], original: Sequence[Kline]) -> List[Fraction]:
    fractions: List[Fraction] = []

    for i in range(1, len(merged) - 1):
        prev = merged[i - 1]
        curr = merged[i]
        nxt = merged[i + 1]

        is_top = (
            curr.high > prev.high
            and curr.high > nxt.high
            and curr.low > prev.low
            and curr.low > nxt.low
        )
        is_bottom = (
            curr.low < prev.low
            and curr.low < nxt.low
            and curr.high < prev.high
            and curr.high < nxt.high
        )

        if is_top:
            highest = curr.original_indices[0]
            for idx in curr.original_indices:
                if original[idx].high > original[highest].high:
                    highest = idx
            fractions.append(
                Fraction(
                    type="TOP",
                    price=original[highest].high,
                    index=i,
                    original_index=highest,
                    date=original[highest].date,
                )
            )
        elif is_bottom:
            lowest = curr.original_indices[0]
            for idx in curr.original_indices:
                if original[idx].low < original[lowest].low:
                    lowest = idx
            fractions.append(
                Fraction(
                    type="BOTTOM",
                    price=original[lowest].low,
                    index=i,
                    original_index=lowest,
                    date=original[lowest].date,
                )
            )

    return fractions


# ---------------------------------------------------------------------------
# Step 3: 笔 (两遍过滤法)
# ---------------------------------------------------------------------------


def _connect_fenxing_to_stroke(fractions: Sequence[Fraction], min_distance: int) -> List[Fraction]:
    """Two-pass greedy filter that keeps extremes and enforces alternation."""
    if len(fractions) < 2:
        return []

    bi_points: List[Fraction] = []
    for fx in fractions:
        if not bi_points:
            bi_points.append(fx)
            continue
        last = bi_points[-1]
        if fx.type == last.type:
            if last.type == "TOP" and fx.price > last.price:
                bi_points[-1] = fx
            elif last.type == "BOTTOM" and fx.price < last.price:
                bi_points[-1] = fx
        else:
            if abs(fx.index - last.index) >= min_distance:
                bi_points.append(fx)

    final_points: List[Fraction] = []
    for fx in bi_points:
        if not final_points:
            final_points.append(fx)
            continue
        last = final_points[-1]
        if fx.type == last.type:
            if (fx.type == "TOP" and fx.price > last.price) or (
                fx.type == "BOTTOM" and fx.price < last.price
            ):
                final_points[-1] = fx
        else:
            if abs(fx.index - last.index) >= min_distance:
                final_points.append(fx)

    return final_points


def calculate_strokes(fractions: Sequence[Fraction]) -> List[Stroke]:
    filtered = _connect_fenxing_to_stroke(fractions, 4)
    if len(filtered) < 2:
        return []

    strokes: List[Stroke] = []
    for i in range(len(filtered) - 1):
        curr = filtered[i]
        nxt = filtered[i + 1]

        if curr.type == "TOP" and nxt.type == "BOTTOM":
            strokes.append(
                Stroke(
                    id=f"stroke-{curr.original_index}-{nxt.original_index}",
                    start=curr,
                    end=nxt,
                    direction="down",
                )
            )
        elif curr.type == "BOTTOM" and nxt.type == "TOP":
            strokes.append(
                Stroke(
                    id=f"stroke-{curr.original_index}-{nxt.original_index}",
                    start=curr,
                    end=nxt,
                    direction="up",
                )
            )

    return strokes


# ---------------------------------------------------------------------------
# Step 4: 线段
# ---------------------------------------------------------------------------


def calculate_segments(strokes: Sequence[Stroke]) -> List[Segment]:
    if len(strokes) < 3:
        return []

    stroke_fenxings: List[Fraction] = []
    for i in range(1, len(strokes) - 1):
        prev_price = strokes[i - 1].end.price
        curr_price = strokes[i].end.price
        next_price = strokes[i + 1].end.price

        if curr_price > prev_price and curr_price > next_price:
            stroke_fenxings.append(
                Fraction(
                    type="TOP",
                    price=max(strokes[i].start.price, strokes[i].end.price),
                    index=i,
                    original_index=strokes[i].end.original_index,
                    date=strokes[i].end.date,
                )
            )
        elif curr_price < prev_price and curr_price < next_price:
            stroke_fenxings.append(
                Fraction(
                    type="BOTTOM",
                    price=min(strokes[i].start.price, strokes[i].end.price),
                    index=i,
                    original_index=strokes[i].end.original_index,
                    date=strokes[i].end.date,
                )
            )

    if len(stroke_fenxings) < 2:
        return []

    seg_points = _connect_fenxing_to_stroke(stroke_fenxings, 3)
    if len(seg_points) < 2:
        return []

    segments: List[Segment] = []
    for i in range(len(seg_points) - 1):
        curr = seg_points[i]
        nxt = seg_points[i + 1]

        start_stroke = strokes[curr.index]
        end_stroke = strokes[nxt.index]

        if curr.type == "TOP" and nxt.type == "BOTTOM":
            direction = "down"
            start_fraction = start_stroke.start if start_stroke.direction == "down" else start_stroke.end
            end_fraction = end_stroke.start if end_stroke.direction == "up" else end_stroke.end
        elif curr.type == "BOTTOM" and nxt.type == "TOP":
            direction = "up"
            start_fraction = start_stroke.start if start_stroke.direction == "up" else start_stroke.end
            end_fraction = end_stroke.start if end_stroke.direction == "down" else end_stroke.end
        else:
            continue

        segments.append(
            Segment(
                id=f"segment-{start_fraction.original_index}-{end_fraction.original_index}",
                start=start_fraction,
                end=end_fraction,
                direction=direction,
            )
        )

    return segments


# ---------------------------------------------------------------------------
# Step 5: 中枢
# ---------------------------------------------------------------------------


def _identify_hubs_generic(lines: Sequence[Stroke], level: int) -> List[Hub]:
    if len(lines) < 3:
        return []

    hubs: List[Hub] = []
    i = 0
    while i <= len(lines) - 3:
        l1, l2, l3 = lines[i], lines[i + 1], lines[i + 2]

        l1_high = max(l1.start.price, l1.end.price)
        l1_low = min(l1.start.price, l1.end.price)
        l2_high = max(l2.start.price, l2.end.price)
        l2_low = min(l2.start.price, l2.end.price)
        l3_high = max(l3.start.price, l3.end.price)
        l3_low = min(l3.start.price, l3.end.price)

        zg = min(l1_high, l2_high, l3_high)
        zd = max(l1_low, l2_low, l3_low)

        if zg > zd:
            gg = max(l1_high, l2_high, l3_high)
            dd = min(l1_low, l2_low, l3_low)
            hub_end_index = l3.end.original_index
            count = 3

            j = i + 3
            while j < len(lines):
                next_line = lines[j]
                next_high = max(next_line.start.price, next_line.end.price)
                next_low = min(next_line.start.price, next_line.end.price)
                if next_high > zd and next_low < zg:
                    hub_end_index = next_line.end.original_index
                    gg = max(gg, next_high)
                    dd = min(dd, next_low)
                    count += 1
                    j += 1
                else:
                    break

            hubs.append(
                Hub(
                    id=f"hub-{l1.start.original_index}-{hub_end_index}",
                    zg=round_half_up(zg, 2),
                    zd=round_half_up(zd, 2),
                    gg=round_half_up(gg, 2),
                    dd=round_half_up(dd, 2),
                    start_index=l1.start.original_index,
                    end_index=hub_end_index,
                    strokes_count=count,
                    level=level,
                )
            )
            i = j
        else:
            i += 1

    return hubs


def calculate_hubs(strokes: Sequence[Stroke]) -> List[Hub]:
    return _identify_hubs_generic(strokes, 1)


def calculate_segment_hubs(segments: Sequence[Segment]) -> List[Hub]:
    if len(segments) < 3:
        return []
    segment_lines = [
        Stroke(id=s.id, start=s.start, end=s.end, direction=s.direction) for s in segments
    ]
    return _identify_hubs_generic(segment_lines, 2)


# ---------------------------------------------------------------------------
# 买卖点识别
# ---------------------------------------------------------------------------


def _stroke_high(s: Stroke) -> float:
    return max(s.start.price, s.end.price)


def _stroke_low(s: Stroke) -> float:
    return min(s.start.price, s.end.price)


def _stroke_power_price(s: Stroke) -> float:
    return abs(s.end.price - s.start.price)


def _stroke_length(s: Stroke) -> int:
    return s.end.index - s.start.index + 1


def _stroke_power_volume(s: Stroke, klines: Sequence[Kline]) -> float:
    """Volume inside the stroke, excluding the two fractal bars."""
    vol = 0.0
    for i in range(s.start.original_index + 1, s.end.original_index):
        if 0 <= i < len(klines):
            vol += klines[i].volume
    return vol


def _mean(values: Sequence[float]) -> float:
    if not values:
        return 0.0
    return sum(values) / len(values)


def check_first_buy(bis: Sequence[Stroke], klines: Sequence[Kline]) -> bool:
    """一买结构判定 (下跌趋势背驰), 移植 czsc ``check_first_buy``."""
    n = len(bis)
    if n < 5 or n % 2 != 1:
        return False
    if bis[n - 1].direction != "down":
        return False
    if bis[0].direction != bis[n - 1].direction:
        return False

    max_high = float("-inf")
    min_low = float("inf")
    for b in bis:
        max_high = max(max_high, _stroke_high(b))
        min_low = min(min_low, _stroke_low(b))
    if max_high != _stroke_high(bis[0]) or min_low != _stroke_low(bis[n - 1]):
        return False

    key_bis: List[Stroke] = []
    for i in range(0, n - 2, 2):
        if i == 0:
            key_bis.append(bis[0])
        elif _stroke_low(bis[i]) < _stroke_low(bis[i - 2]):
            key_bis.append(bis[i])
    if not key_bis:
        return False

    last = bis[n - 1]
    prev = bis[n - 3]
    bc_price = _stroke_power_price(last) < max(
        _stroke_power_price(prev), _mean([_stroke_power_price(b) for b in key_bis])
    )
    bc_volume = _stroke_power_volume(last, klines) < max(
        _stroke_power_volume(prev, klines),
        _mean([_stroke_power_volume(b, klines) for b in key_bis]),
    )
    bc_length = _stroke_length(last) < max(
        _stroke_length(prev), _mean([_stroke_length(b) for b in key_bis])
    )
    return bc_price and (bc_volume or bc_length)


def check_first_sell(bis: Sequence[Stroke], klines: Sequence[Kline]) -> bool:
    """一卖结构判定, ``check_first_buy`` 的镜像."""
    n = len(bis)
    if n < 5 or n % 2 != 1:
        return False
    if bis[n - 1].direction != "up":
        return False
    if bis[0].direction != bis[n - 1].direction:
        return False

    max_high = float("-inf")
    min_low = float("inf")
    for b in bis:
        max_high = max(max_high, _stroke_high(b))
        min_low = min(min_low, _stroke_low(b))
    if max_high != _stroke_high(bis[n - 1]) or min_low != _stroke_low(bis[0]):
        return False

    key_bis: List[Stroke] = []
    for i in range(0, n - 2, 2):
        if i == 0:
            key_bis.append(bis[0])
        elif _stroke_high(bis[i]) > _stroke_high(bis[i - 2]):
            key_bis.append(bis[i])
    if not key_bis:
        return False

    last = bis[n - 1]
    prev = bis[n - 3]
    bc_price = _stroke_power_price(last) < max(
        _stroke_power_price(prev), _mean([_stroke_power_price(b) for b in key_bis])
    )
    bc_volume = _stroke_power_volume(last, klines) < max(
        _stroke_power_volume(prev, klines),
        _mean([_stroke_power_volume(b, klines) for b in key_bis]),
    )
    bc_length = _stroke_length(last) < max(
        _stroke_length(prev), _mean([_stroke_length(b) for b in key_bis])
    )
    return bc_price and (bc_volume or bc_length)


def calculate_bs_points(
    klines: Sequence[Kline],
    strokes: Sequence[Stroke],
    confirmed_only: bool = False,
) -> List[BSPoint]:
    """三类买卖点.

    - B1/S1: 趋势背驰 (窗口从大到小取首个命中)
    - B2/S2: 一买/一卖后次级别反弹、再次回调不创新低/新高
    - B3/S3: 5 笔中枢 (b1∧b3 重叠), 离开后的回抽整笔不回中枢区间

    ``confirmed_only`` 只输出「之后已经存在下一笔」的买卖点 —— 最后一笔的终点
    仍可能被后续 K 线改写, 据此产生的点会在重算同一段历史时消失。
    """
    points: List[BSPoint] = []
    n = len(strokes)
    if not klines or n < 5:
        return points

    max_stroke_index = n - 2 if confirmed_only else n - 1

    seen: Set[str] = set()
    last_fired_at: Dict[str, int] = {}

    def push_point(point_type: str, stroke_idx: int, dedupe_gap: int) -> None:
        prev_at = last_fired_at.get(point_type)
        if prev_at is not None and stroke_idx - prev_at < dedupe_gap:
            return
        stroke = strokes[stroke_idx]
        point = BSPoint(
            id=f"bs-{point_type}-{stroke.end.original_index}",
            type=point_type,
            label=BS_LABELS[point_type],
            price=stroke.end.price,
            original_index=stroke.end.original_index,
            date=stroke.end.date,
            stroke_index=stroke_idx,
        )
        key = f"{point_type}-{stroke.end.original_index}"
        if key in seen:
            return
        seen.add(key)
        last_fired_at[point_type] = stroke_idx
        points.append(point)

    # ---- B1/S1 ----
    for e in range(4, max_stroke_index + 1):
        for w in BS1_WINDOWS:
            start = e - w + 1
            if start < 0:
                continue
            seg = strokes[start : e + 1]
            if check_first_buy(seg, klines):
                push_point("B1", e, 3)
                break
            if check_first_sell(seg, klines):
                push_point("S1", e, 3)
                break

    # ---- B2/S2 ----
    for p in list(points):
        k = p.stroke_index
        if p.type == "B1" and k + 2 <= max_stroke_index:
            pullback = strokes[k + 2]
            if pullback.direction == "down" and _stroke_low(pullback) > _stroke_low(strokes[k]):
                push_point("B2", k + 2, 1)
        if p.type == "S1" and k + 2 <= max_stroke_index:
            rally = strokes[k + 2]
            if rally.direction == "up" and _stroke_high(rally) < _stroke_high(strokes[k]):
                push_point("S2", k + 2, 1)

    # ---- B3/S3 ----
    for e in range(4, max_stroke_index + 1):
        b1 = strokes[e - 4]
        b3 = strokes[e - 2]
        b5 = strokes[e]
        zs_zd = max(_stroke_low(b1), _stroke_low(b3))
        zs_zg = min(_stroke_high(b1), _stroke_high(b3))
        if zs_zd > zs_zg:
            continue
        if b5.direction == "down" and _stroke_low(b5) > zs_zg:
            push_point("B3", e, 3)
        elif b5.direction == "up" and _stroke_high(b5) < zs_zd:
            push_point("S3", e, 3)

    points.sort(key=lambda p: (p.original_index, p.type))
    return points


# ---------------------------------------------------------------------------
# Pipelines (shared by HTTP handlers, strategies and the CLI)
# ---------------------------------------------------------------------------


def compute_chanlun_structures(klines: Sequence[Kline]) -> ChanlunStructures:
    """合并K线 -> 分型 -> 笔 -> 线段/中枢 (不含买卖点)."""
    merged = merge_klines(klines)
    fractions = find_fractions(merged, klines)
    strokes = calculate_strokes(fractions)
    segments = calculate_segments(strokes)
    hubs = calculate_hubs(strokes)
    return ChanlunStructures(
        merged_klines=merged,
        fractions=fractions,
        strokes=strokes,
        segments=segments,
        hubs=hubs,
    )


def compute_strokes_and_bs_points(klines: Sequence[Kline]):
    """笔 + 买卖点 (跳过线段/中枢, 保持扫描轻量)."""
    strokes = calculate_strokes(find_fractions(merge_klines(klines), klines))
    return strokes, calculate_bs_points(klines, strokes)


def run_chanlun_pipeline(klines: Sequence[Kline]) -> Dict[str, object]:
    """完整流水线: 结构 + 买卖点, 直接可 JSON 序列化."""
    structures = compute_chanlun_structures(klines)
    bs_points = calculate_bs_points(klines, structures.strokes)
    payload = structures.to_dict()
    payload["bsPoints"] = [p.to_dict() for p in bs_points]
    return payload


def stroke_high(stroke: Stroke) -> float:
    """Public alias used by strategies (B3 hub range, higher-low checks)."""
    return max(stroke.start.price, stroke.end.price)


def stroke_low(stroke: Stroke) -> float:
    return min(stroke.start.price, stroke.end.price)
