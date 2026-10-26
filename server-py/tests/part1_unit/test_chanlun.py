"""Part 1 — unit tests for the ChanLun structure engine.

Pure functions only: no IO, no clock, no network.
"""

from __future__ import annotations

import pytest

from chanlun_server.chanlun import (
    calculate_bs_points,
    calculate_hubs,
    calculate_segments,
    calculate_strokes,
    check_first_buy,
    check_first_sell,
    compute_chanlun_structures,
    compute_strokes_and_bs_points,
    find_fractions,
    merge_klines,
    run_chanlun_pipeline,
)
from conftest import make_klines, ramp_klines, wave_klines

pytestmark = pytest.mark.unit


# ---------------------------------------------------------------------------
# 包含关系
# ---------------------------------------------------------------------------


def test_merge_returns_empty_for_no_bars():
    assert merge_klines([]) == []


def test_merge_upward_containment_takes_max_high_and_max_low():
    bars = make_klines(
        [
            {"date": "2024-01-01", "open": 10, "high": 12, "low": 9, "close": 11},
            {"date": "2024-01-02", "open": 11, "high": 13, "low": 10, "close": 12},
            # contained by previous, direction is up -> high=max, low=max
            {"date": "2024-01-03", "open": 11, "high": 12.5, "low": 10.5, "close": 12},
        ]
    )
    merged = merge_klines(bars)
    assert len(merged) == 2
    assert merged[1].high == 13
    assert merged[1].low == 10.5
    assert merged[1].original_indices == [1, 2]
    assert merged[1].original_high == 13
    assert merged[1].original_low == 10


def test_merge_downward_containment_takes_min_high_and_min_low():
    bars = make_klines(
        [
            {"date": "2024-01-01", "open": 20, "high": 21, "low": 19, "close": 20},
            {"date": "2024-01-02", "open": 19, "high": 19.5, "low": 18, "close": 18.5},
            # contained by previous, direction down -> high=min, low=min
            {"date": "2024-01-03", "open": 19, "high": 19.2, "low": 18.2, "close": 18.6},
        ]
    )
    merged = merge_klines(bars)
    assert len(merged) == 2
    assert merged[1].high == 19.2
    assert merged[1].low == 18


def test_merge_without_containment_keeps_every_bar():
    bars = ramp_klines(10)
    assert len(merge_klines(bars)) == 10


# ---------------------------------------------------------------------------
# 分型 / 笔
# ---------------------------------------------------------------------------


def test_fractions_are_top_and_bottom_alternating_after_strokes():
    bars = wave_klines(400)
    merged = merge_klines(bars)
    fractions = find_fractions(merged, bars)
    assert fractions, "expected at least one fractal"
    for fraction in fractions:
        assert fraction.type in ("TOP", "BOTTOM")
        assert fraction.price > 0

    strokes = calculate_strokes(fractions)
    for stroke in strokes:
        assert stroke.start.type != stroke.end.type
        assert stroke.start.index < stroke.end.index
        assert stroke.direction == ("down" if stroke.start.type == "TOP" else "up")

    for prev, nxt in zip(strokes, strokes[1:]):
        assert prev.direction != nxt.direction
        assert prev.end.index <= nxt.start.index


def test_top_fraction_price_is_the_highest_original_bar():
    bars = make_klines(
        [
            {"date": "2024-01-01", "open": 10, "high": 10.0, "low": 9.0, "close": 9.5},
            {"date": "2024-01-02", "open": 10.2, "high": 12.0, "low": 10.5, "close": 11.5},
            {"date": "2024-01-03", "open": 11.4, "high": 11.6, "low": 9.9, "close": 10.0},
        ]
    )
    fractions = find_fractions(merge_klines(bars), bars)
    assert len(fractions) == 1
    assert fractions[0].type == "TOP"
    assert fractions[0].price == 12.0
    assert fractions[0].original_index == 1


def test_strokes_need_minimum_distance():
    bars = make_klines(
        [
            {"date": "2024-01-01", "open": 10, "high": 10.2, "low": 9.8, "close": 10},
            {"date": "2024-01-02", "open": 10.1, "high": 11.0, "low": 10.0, "close": 10.8},
            {"date": "2024-01-03", "open": 10.8, "high": 10.9, "low": 10.2, "close": 10.4},
            {"date": "2024-01-04", "open": 10.4, "high": 10.5, "low": 9.5, "close": 9.6},
            {"date": "2024-01-05", "open": 9.6, "high": 9.9, "low": 9.4, "close": 9.7},
        ]
    )
    strokes = calculate_strokes(find_fractions(merge_klines(bars), bars))
    for stroke in strokes:
        assert abs(stroke.end.index - stroke.start.index) >= 4


# ---------------------------------------------------------------------------
# 线段 / 中枢
# ---------------------------------------------------------------------------


def test_segments_require_at_least_three_strokes():
    assert calculate_segments([]) == []
    assert calculate_segments(calculate_strokes(find_fractions(merge_klines(ramp_klines(10)), ramp_klines(10)))) == []


def test_hub_bounds_follow_three_line_overlap():
    bars = wave_klines(400)
    merged = merge_klines(bars)
    strokes = calculate_strokes(find_fractions(merged, bars))
    hubs = calculate_hubs(strokes)
    assert hubs, "synthetic wave series should contain hubs"

    for hub in hubs:
        assert hub.zg > hub.zd
        assert hub.gg >= hub.zg
        assert hub.dd <= hub.zd
        assert hub.strokes_count >= 3
        assert hub.level == 1
        assert hub.start_index < hub.end_index
        # rounded to 2 decimals like the TS implementation
        assert hub.zg == round(hub.zg, 2)


def test_hub_uses_first_three_strokes_of_the_window():
    bars = wave_klines(400)
    merged = merge_klines(bars)
    strokes = calculate_strokes(find_fractions(merged, bars))
    hubs = calculate_hubs(strokes)
    first = hubs[0]

    # A hub id encodes the kline index of its first stroke's start, so locate
    # the stroke window by that index rather than assuming it starts at 0.
    start_stroke = next(i for i, s in enumerate(strokes) if s.start.original_index == first.start_index)
    window = strokes[start_stroke : start_stroke + 3]
    highs = [max(s.start.price, s.end.price) for s in window]
    lows = [min(s.start.price, s.end.price) for s in window]
    assert first.zg == round(min(highs), 2)
    assert first.zd == round(max(lows), 2)


# ---------------------------------------------------------------------------
# 买卖点
# ---------------------------------------------------------------------------


def test_bs_points_are_valid_sorted_and_unique():
    bars = wave_klines(400)
    merged = merge_klines(bars)
    strokes = calculate_strokes(find_fractions(merged, bars))
    points = calculate_bs_points(bars, strokes)

    valid = {"B1", "B2", "B3", "S1", "S2", "S3"}
    assert points
    assert all(p.type in valid for p in points)
    assert [p.original_index for p in points] == sorted(p.original_index for p in points)
    assert len({p.id for p in points}) == len(points)
    for point in points:
        assert point.price == strokes[point.stroke_index].end.price
        assert point.label in {"一买", "二买", "三买", "一卖", "二卖", "三卖"}


def test_confirmed_only_is_a_subset_of_all_points():
    bars = wave_klines(400)
    merged = merge_klines(bars)
    strokes = calculate_strokes(find_fractions(merged, bars))

    everything = {(p.type, p.original_index) for p in calculate_bs_points(bars, strokes)}
    confirmed = {
        (p.type, p.original_index) for p in calculate_bs_points(bars, strokes, confirmed_only=True)
    }
    assert confirmed <= everything
    if everything - confirmed:
        # the only difference must be the very last stroke
        last_index = len(strokes) - 1
        for point in calculate_bs_points(bars, strokes):
            if (point.type, point.original_index) not in confirmed:
                assert point.stroke_index == last_index


def test_bs_points_need_at_least_five_strokes():
    bars = ramp_klines(40)
    merged = merge_klines(bars)
    strokes = calculate_strokes(find_fractions(merged, bars))
    assert len(strokes) < 5
    assert calculate_bs_points(bars, strokes) == []


def test_first_buy_and_first_sell_are_mirror_conditions():
    bars = wave_klines(400)
    merged = merge_klines(bars)
    strokes = calculate_strokes(find_fractions(merged, bars))
    # Same window cannot be both a first-buy and a first-sell structure.
    for end in range(4, len(strokes)):
        window = strokes[max(0, end - 4) : end + 1]
        assert not (check_first_buy(window, bars) and check_first_sell(window, bars))


# ---------------------------------------------------------------------------
# 流水线
# ---------------------------------------------------------------------------


def test_structures_regression_counts():
    """Golden counts for the synthetic series — catches silent algorithm drift."""
    bars = wave_klines(400)
    structures = compute_chanlun_structures(bars)
    assert len(structures.merged_klines) == 399
    assert len(structures.fractions) == 14
    assert len(structures.strokes) == 13
    assert len(structures.segments) == 2
    assert len(structures.hubs) == 2
    assert len(calculate_bs_points(bars, structures.strokes)) == 3


def test_pipeline_payload_is_json_ready():
    bars = wave_klines(400)
    payload = run_chanlun_pipeline(bars)
    assert set(payload) == {
        "mergedKlines",
        "fractions",
        "strokes",
        "segments",
        "hubs",
        "bsPoints",
    }
    assert isinstance(payload["strokes"][0], dict)
    assert "originalIndices" in payload["mergedKlines"][0]
    assert "strokeIndex" in payload["bsPoints"][0]


def test_strokes_and_bspoints_matches_full_pipeline():
    bars = wave_klines(300)
    strokes, points = compute_strokes_and_bs_points(bars)
    full = run_chanlun_pipeline(bars)
    assert len(strokes) == len(full["strokes"])
    assert [p.id for p in points] == [p["id"] for p in full["bsPoints"]]


def test_algorithms_are_deterministic():
    bars = wave_klines(260, seed=3.0)
    first = run_chanlun_pipeline(bars)
    second = run_chanlun_pipeline(bars)
    assert first == second
